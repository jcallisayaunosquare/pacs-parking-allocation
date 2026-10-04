import { sql, type Kysely } from 'kysely';
import { InfrastructureError, RunLockHeldError } from '../../../shared/errors';
import type { Database } from '../../../shared/db/schema';
import type { CycleState } from '../domain/types';
import type {
  AllocationRepository,
  CycleRecord,
  DomainEvent,
  RunRecord,
  RunSnapshot,
} from '../application/ports';

/** Postgres unique-violation. 23505 on uq_single_running_run is the lock being held. */
const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (e: unknown, constraint?: string): boolean => {
  const err = e as { code?: string; constraint?: string };
  return err?.code === UNIQUE_VIOLATION && (!constraint || err.constraint === constraint);
};

const toCycle = (r: {
  id: string;
  label: string;
  starts_on: Date;
  ends_on: Date;
  state: CycleState;
  registration_opens_at: Date;
  registration_closes_at: Date;
}): CycleRecord => ({
  id: r.id,
  label: r.label,
  startsOn: new Date(r.starts_on),
  endsOn: new Date(r.ends_on),
  state: r.state,
  registrationOpensAt: new Date(r.registration_opens_at),
  registrationClosesAt: new Date(r.registration_closes_at),
});

const toRun = (r: {
  id: string;
  cycle_id: string;
  state: RunRecord['state'];
  random_seed: string;
  algorithm_version: string;
  idempotency_key: string;
  entrants_count: number;
  spots_count: number;
  assigned_count: number;
  started_at: Date;
  finished_at: Date | null;
  error_detail: string | null;
}): RunRecord => ({
  id: r.id,
  cycleId: r.cycle_id,
  state: r.state,
  randomSeed: BigInt(r.random_seed),
  algorithmVersion: r.algorithm_version,
  idempotencyKey: r.idempotency_key,
  entrantsCount: r.entrants_count,
  spotsCount: r.spots_count,
  assignedCount: r.assigned_count,
  startedAt: new Date(r.started_at),
  finishedAt: r.finished_at ? new Date(r.finished_at) : null,
  errorDetail: r.error_detail,
});

export class KyselyAllocationRepository implements AllocationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async findCycle(cycleId: string): Promise<CycleRecord | null> {
    const row = await this.db
      .selectFrom('allocation_cycle')
      .selectAll()
      .where('id', '=', cycleId)
      .executeTakeFirst();
    return row ? toCycle(row as never) : null;
  }

  async findRunByIdempotencyKey(key: string): Promise<RunRecord | null> {
    const row = await this.db
      .selectFrom('allocation_run')
      .selectAll()
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    return row ? toRun(row as never) : null;
  }

  async findRun(runId: string): Promise<RunRecord | null> {
    const row = await this.db
      .selectFrom('allocation_run')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirst();
    return row ? toRun(row as never) : null;
  }

  async openRun(input: {
    cycleId: string;
    seed: bigint;
    algorithmVersion: string;
    idempotencyKey: string;
  }): Promise<RunRecord> {
    try {
      const row = await this.db
        .insertInto('allocation_run')
        .values({
          cycle_id: input.cycleId,
          state: 'RUNNING',
          random_seed: input.seed.toString(),
          algorithm_version: input.algorithmVersion,
          idempotency_key: input.idempotencyKey,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toRun(row as never);
    } catch (e) {
      // Guard 1 of §12. Both the lock and a replayed key land here; the lock is the
      // one the caller must see as 409.
      if (isUniqueViolation(e, 'uq_single_running_run')) throw new RunLockHeldError();
      if (isUniqueViolation(e)) throw new RunLockHeldError();
      throw new InfrastructureError('Could not open an allocation run.', e);
    }
  }

  async snapshotInputs(cycleId: string): Promise<RunSnapshot> {
    // One consistent read of everything the draw needs. A resident deactivated after
    // this point does not affect the run in flight (§11 integrity scenarios).
    const registered = await this.db
      .selectFrom('raffle_registration as rr')
      .innerJoin('resident as r', 'r.id', 'rr.resident_id')
      .leftJoin('fairness_state as fs', 'fs.resident_id', 'r.id')
      .select([
        'r.id as residentId',
        'r.is_eligible as isEligible',
        'r.deactivated_at as deactivatedAt',
        'r.needs_accessible_spot as needsAccessibleSpot',
        'fs.score as score',
      ])
      .where('rr.cycle_id', '=', cycleId)
      .where('rr.withdrawn', '=', false)
      .execute();

    const eligible = registered.filter((r) => r.isEligible && r.deactivatedAt === null);
    const skipped = registered.filter((r) => !r.isEligible || r.deactivatedAt !== null);

    const spots = await this.db
      .selectFrom('parking_spot')
      .select(['id as spotId', 'spot_code as spotCode', 'type'])
      .where('is_active', '=', true)
      .orderBy('spot_code')
      .execute();

    return {
      entrants: eligible.map((r) => ({
        residentId: r.residentId,
        fairnessScore: r.score === null ? 0 : Number(r.score),
        needsAccessibleSpot: r.needsAccessibleSpot,
      })),
      spots: spots.map((s) => ({ spotId: s.spotId, spotCode: s.spotCode, type: s.type })),
      skippedResidentIds: skipped.map((r) => r.residentId),
    };
  }

  async commitRun(input: Parameters<AllocationRepository['commitRun']>[0]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      if (input.assignments.length > 0) {
        await trx
          .insertInto('spot_assignment')
          .values(
            input.assignments.map((a) => ({
              cycle_id: input.cycleId,
              run_id: input.runId,
              resident_id: a.residentId,
              spot_id: a.spotId,
              state: 'ACTIVE' as const,
              valid_from: input.validFrom,
              valid_until: input.validUntil,
            })),
          )
          .execute();
      }

      if (input.waitlist.length > 0) {
        await trx
          .insertInto('waitlist_entry')
          .values(
            input.waitlist.map((w) => ({
              cycle_id: input.cycleId,
              run_id: input.runId,
              resident_id: w.residentId,
              position: w.position,
              state: 'WAITING' as const,
            })),
          )
          .execute();
      }

      if (input.history.length > 0) {
        await trx
          .insertInto('allocation_history')
          .values(
            input.history.map((h) => ({
              run_id: input.runId,
              cycle_id: input.cycleId,
              resident_id: h.residentId,
              spot_id: h.spotId,
              result: h.result,
              fairness_score_at_draw: h.fairnessScoreAtDraw,
              waitlist_position: h.waitlistPosition,
            })),
          )
          .execute();
      }

      // One statement, not one per resident. The transaction is held open for the
      // writes only (§12), and lock hold time must not grow with the building — 500
      // residents would otherwise mean 500 round-trips inside the transaction.
      //
      // The inserted totals are the *deltas* (1 registration, 0 or 1 win), which is
      // what lets `excluded` serve as the increment on the conflict path.
      if (input.fairness.length > 0) {
        await trx
          .insertInto('fairness_state')
          .values(
            input.fairness.map((f) => ({
              resident_id: f.residentId,
              score: f.score,
              consecutive_misses: f.consecutiveMisses,
              total_registrations: f.totalRegistrations,
              total_wins: f.totalWins,
              last_won_cycle_id: f.lastWonCycleId,
            })),
          )
          .onConflict((oc) =>
            oc.column('resident_id').doUpdateSet({
              score: sql`excluded.score`,
              consecutive_misses: sql`excluded.consecutive_misses`,
              total_registrations: sql`fairness_state.total_registrations + excluded.total_registrations`,
              total_wins: sql`fairness_state.total_wins + excluded.total_wins`,
              last_won_cycle_id: sql`coalesce(excluded.last_won_cycle_id, fairness_state.last_won_cycle_id)`,
              updated_at: sql`now()`,
            }),
          )
          .execute();
      }

      await trx
        .updateTable('allocation_run')
        .set({
          state: 'COMPLETED',
          finished_at: new Date(),
          entrants_count: input.entrantsCount,
          spots_count: input.spotsCount,
          assigned_count: input.assignments.length,
        })
        .where('id', '=', input.runId)
        .execute();

      await trx
        .updateTable('allocation_cycle')
        .set({ state: 'ACTIVE' })
        .where('id', '=', input.cycleId)
        .execute();

      if (input.events.length > 0) {
        await trx
          .insertInto('event_outbox')
          .values(
            input.events.map((e) => ({
              event_type: e.eventType,
              aggregate_type: e.aggregateType,
              aggregate_id: e.aggregateId,
              payload: JSON.stringify(e.payload),
            })),
          )
          .execute();
      }
    });
  }

  async markRunFailed(runId: string, detail: string): Promise<void> {
    await this.db
      .updateTable('allocation_run')
      .set({ state: 'FAILED', finished_at: new Date(), error_detail: detail.slice(0, 2000) })
      .where('id', '=', runId)
      .execute();
  }

  async markRunCompletedEmpty(runId: string, events: readonly DomainEvent[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('allocation_run')
        .set({ state: 'COMPLETED_EMPTY', finished_at: new Date() })
        .where('id', '=', runId)
        .execute();
      if (events.length > 0) {
        await trx
          .insertInto('event_outbox')
          .values(
            events.map((e) => ({
              event_type: e.eventType,
              aggregate_type: e.aggregateType,
              aggregate_id: e.aggregateId,
              payload: JSON.stringify(e.payload),
            })),
          )
          .execute();
      }
    });
  }

  async countActiveSpots(): Promise<number> {
    const row = await this.db
      .selectFrom('parking_spot')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('is_active', '=', true)
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  async failStaleRuns(olderThan: Date): Promise<number> {
    const res = await this.db
      .updateTable('allocation_run')
      .set({
        state: 'FAILED',
        finished_at: new Date(),
        error_detail: 'Run exceeded its timeout and was failed by the sweeper.',
      })
      .where('state', '=', 'RUNNING')
      .where('started_at', '<', olderThan)
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0);
  }
}
