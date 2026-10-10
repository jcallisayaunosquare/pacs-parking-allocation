import { sql, type Kysely } from 'kysely';
import { InfrastructureError, RunLockHeldError } from '../../../shared/errors';
import type { Database } from '../../../shared/db/schema';
import type { CycleState, SkipReason, SkippedCandidate } from '../domain/types';
import type { Candidate } from '../domain/priority-key';
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

const hex = (b: Buffer | null): string | null => (b === null ? null : b.toString('hex'));

const toRun = (r: {
  id: string;
  cycle_id: string;
  state: RunRecord['state'];
  random_seed: Buffer;
  seed_commitment: Buffer;
  decided_at: Date;
  config_version: number;
  input_hash: Buffer | null;
  result_hash: Buffer | null;
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
  randomSeedHex: r.random_seed.toString('hex'),
  seedCommitmentHex: r.seed_commitment.toString('hex'),
  decidedAt: new Date(r.decided_at),
  configVersion: r.config_version,
  inputHashHex: hex(r.input_hash),
  resultHashHex: hex(r.result_hash),
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

  async listRuns(limit: number): Promise<readonly RunRecord[]> {
    const rows = await this.db
      .selectFrom('allocation_run')
      .selectAll()
      // Newest first, and by id after that: two runs can share a decided_at when a draw
      // is retried, and a report whose order is not total reads differently each load.
      .orderBy('decided_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return rows.map((r) => toRun(r as never));
  }

  /**
   * decided_at is taken from the database clock, not the Lambda's: it is the single
   * instant every priority key is computed against, so it must come from one place that
   * cannot drift between invocations.
   */
  async openRun(input: {
    cycleId: string;
    seedHex: string;
    seedCommitmentHex: string;
    configVersion: number;
    algorithmVersion: string;
    idempotencyKey: string;
  }): Promise<RunRecord> {
    try {
      const row = await this.db
        .insertInto('allocation_run')
        .values({
          cycle_id: input.cycleId,
          state: 'RUNNING',
          random_seed: Buffer.from(input.seedHex, 'hex'),
          seed_commitment: Buffer.from(input.seedCommitmentHex, 'hex'),
          config_version: input.configVersion,
          algorithm_version: input.algorithmVersion,
          idempotency_key: input.idempotencyKey,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toRun(row as never);
    } catch (e) {
      // Guard 1 of section 12. Both the lock and a replayed key land here; the lock is the
      // one the caller must see as 409.
      if (isUniqueViolation(e, 'uq_single_running_run')) throw new RunLockHeldError();
      if (isUniqueViolation(e)) throw new RunLockHeldError();
      throw new InfrastructureError('Could not open an allocation run.', e);
    }
  }

  /**
   * The candidate snapshot. It emits *facts* - anchors, counts, flags - and never a
   * priority key: duplicating the key formula in SQL and TypeScript would guarantee they
   * drift, and the drift would be invisible until a resident compared their dashboard to
   * the run page. The domain sorts; this query does not.
   *
   * Read in one REPEATABLE READ transaction, so a registration committed halfway through
   * cannot produce a candidate list no replay can reproduce.
   */
  async snapshotInputs(cycleId: string, decidedAt: Date): Promise<RunSnapshot> {
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async (trx) => {
      const registered = await trx
        .selectFrom('raffle_registration as rr')
        .innerJoin('resident as r', 'r.id', 'rr.resident_id')
        .select((eb) => [
          'r.id as residentId',
          'r.is_eligible as isEligible',
          'r.is_admin as isAdmin',
          'r.deactivated_at as deactivatedAt',
          'r.needs_accessible_spot as needsAccessibleSpot',
          'r.has_electric_vehicle as hasElectricVehicle',
          'r.participation_started_at as participationStartedAt',
          // Rule C's second branch and rule D's h(r), from the one column that decides
          // both: counts_as_served. No termination reason is consulted here.
          eb
            .selectFrom('spot_assignment as sa')
            .select(sql<Date | null>`max(sa.benefit_ended_at)`.as('v'))
            .whereRef('sa.resident_id', '=', 'r.id')
            .where('sa.counts_as_served', '=', true)
            .where('sa.benefit_ended_at', 'is not', null)
            .where('sa.benefit_ended_at', '<=', decidedAt)
            .as('lastBenefitEndAt'),
          eb
            .selectFrom('spot_assignment as sa2')
            .select(sql<string>`count(*)`.as('v'))
            .whereRef('sa2.resident_id', '=', 'r.id')
            .where('sa2.counts_as_served', '=', true)
            .as('servedCount'),
          eb
            .selectFrom('allocation_history as ah')
            .select(sql<string>`count(distinct ah.run_id)`.as('v'))
            .whereRef('ah.resident_id', '=', 'r.id')
            .as('priorParticipations'),
          // BR-01: a resident still holding a bay at the decision instant is skipped
          // rather than ranked, so a long-running release promotion cannot double-assign.
          eb
            .selectFrom('spot_assignment as sa3')
            .select(sql<string>`count(*)`.as('v'))
            .whereRef('sa3.resident_id', '=', 'r.id')
            .where('sa3.state', '=', 'ACTIVE')
            .where('sa3.valid_until', '>', decidedAt)
            .as('activeHoldings'),
        ])
        .where('rr.cycle_id', '=', cycleId)
        .where('rr.withdrawn', '=', false)
        .execute();

      const skipReason = (r: (typeof registered)[number]): SkipReason | null =>
        r.deactivatedAt !== null
          ? 'DEACTIVATED'
          : r.isAdmin
            ? 'ADMIN_ACCOUNT'
            : !r.isEligible
              ? 'NOT_ELIGIBLE'
              : Number(r.activeHoldings ?? 0) > 0
                ? 'HOLDS_ACTIVE_SPOT'
                : null;

      const candidates: Candidate[] = [];
      const skipped: SkippedCandidate[] = [];

      for (const r of registered) {
        const reason = skipReason(r);
        if (reason !== null) {
          skipped.push({ residentId: r.residentId, reason });
          continue;
        }
        candidates.push({
          residentId: r.residentId,
          participationStartedAt: new Date(r.participationStartedAt),
          lastBenefitEndAt: r.lastBenefitEndAt === null ? null : new Date(r.lastBenefitEndAt),
          servedCount: Number(r.servedCount ?? 0),
          priorParticipations: Number(r.priorParticipations ?? 0),
          needsAccessibleSpot: r.needsAccessibleSpot,
          hasElectricVehicle: r.hasElectricVehicle,
        });
      }

      const spots = await trx
        .selectFrom('parking_spot')
        .select(['id as spotId', 'spot_code as spotCode', 'type'])
        .where('is_active', '=', true)
        .orderBy('spot_code')
        .execute();

      return {
        candidates,
        spots: spots.map((s) => ({ spotId: s.spotId, spotCode: s.spotCode, type: s.type })),
        skipped,
      };
    });
  }

  async commitRun(input: Parameters<AllocationRepository['commitRun']>[0]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      // Guard 3: the cycle row is locked for the duration, so a concurrent state change
      // cannot interleave with the writes that depend on it.
      await trx
        .selectFrom('allocation_cycle')
        .select('id')
        .where('id', '=', input.cycleId)
        .forUpdate()
        .execute();

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
              waitlist_position: h.waitlistPosition,
            })),
          )
          .execute();
      }

      // The contestable record. One statement, not one per resident: the transaction is
      // held open for the writes only, and lock hold time must not grow with the building.
      if (input.candidates.length > 0) {
        await trx
          .insertInto('allocation_run_candidate')
          .values(
            input.candidates.map((c) => ({
              run_id: input.runId,
              resident_id: c.residentId,
              anchor_at: c.anchorAt,
              raw_wait_quanta: c.rawWaitQuanta,
              effective_wait_quanta: c.effectiveWaitQuanta,
              bias_applied: c.biasApplied,
              first_time: c.firstTime,
              served_count: c.servedCount,
              raffle_token: c.raffleToken,
              final_rank: c.finalRank,
              pool: c.pool,
              outcome: c.outcome,
              spot_id: c.spotId,
            })),
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
          input_hash: Buffer.from(input.inputHashHex, 'hex'),
          result_hash: Buffer.from(input.resultHashHex, 'hex'),
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
