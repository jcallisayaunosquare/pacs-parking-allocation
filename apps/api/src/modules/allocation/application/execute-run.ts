import { fail, RunLockHeldError } from '../../../shared/errors';
import { ok, type Result } from '../../../shared/result';
import type { Clock, SeedSource } from '../../../shared/clock';
import { applyOutcome, initialFairnessState, type FairnessState } from '../../fairness/domain/fairness';
import { isRunnable } from '../domain/cycle';
import type { DrawStrategy } from '../domain/types';
import type {
  AllocationRepository,
  CachePort,
  DomainEvent,
  HistoryRow,
} from './ports';

export interface ExecuteRunCommand {
  readonly cycleId: string;
  readonly idempotencyKey: string;
}

export interface RunResult {
  readonly runId: string;
  readonly state: 'COMPLETED' | 'COMPLETED_EMPTY';
  readonly algorithmVersion: string;
  readonly randomSeed: number;
  readonly entrants: number;
  readonly spots: number;
  readonly assigned: number;
  readonly waitlisted: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/**
 * UC-05 — execute an allocation run. The flow of Figure 12.1, in order:
 * idempotency check → lock → state check → snapshot → draw (pure) → one transaction.
 *
 * Note where the transaction begins: after all computation. The draw is in-memory and
 * fast, so the database is held open only for the writes (§12).
 */
export class ExecuteRun {
  constructor(
    private readonly repo: AllocationRepository,
    private readonly draw: DrawStrategy,
    private readonly clock: Clock,
    private readonly seeds: SeedSource,
    private readonly cache: CachePort,
  ) {}

  async execute(cmd: ExecuteRunCommand): Promise<Result<RunResult>> {
    // ------------------------------------------------- idempotency (§12, §16)
    const replay = await this.repo.findRunByIdempotencyKey(cmd.idempotencyKey);
    if (replay) {
      if (replay.state === 'FAILED') {
        return fail('INTERNAL_ERROR', `Run ${replay.id} failed: ${replay.errorDetail ?? 'unknown'}`);
      }
      return ok(this.present(replay, replay.entrantsCount - replay.assignedCount));
    }

    const cycle = await this.repo.findCycle(cmd.cycleId);
    if (!cycle) return fail('NOT_FOUND', 'Cycle not found.');
    if (!isRunnable(cycle.state)) {
      return fail(
        'INVALID_CYCLE_STATE',
        `A run may only start from REGISTRATION_CLOSED; this cycle is ${cycle.state}.`,
      );
    }

    // An inventory error must not cost residents their fairness scores (§12 edge case).
    if ((await this.repo.countActiveSpots()) === 0) {
      return fail('NO_SPOTS_AVAILABLE', 'There are no active parking spots to allocate.');
    }

    // ------------------------------------------------------- lock (§12 guard 1)
    const seed = this.seeds.next();
    let run;
    try {
      run = await this.repo.openRun({
        cycleId: cycle.id,
        seed,
        algorithmVersion: this.draw.version,
        idempotencyKey: cmd.idempotencyKey,
      });
    } catch (e) {
      if (e instanceof RunLockHeldError) {
        return fail('RAFFLE_IN_PROGRESS', 'An allocation run is already executing for this cycle.');
      }
      throw e;
    }

    try {
      const snapshot = await this.repo.snapshotInputs(cycle.id);

      if (snapshot.entrants.length === 0) {
        await this.repo.markRunCompletedEmpty(run.id, [
          {
            eventType: 'AllocationCompletedEmpty',
            aggregateType: 'AllocationRun',
            aggregateId: run.id,
            payload: { cycleId: cycle.id, cycleLabel: cycle.label },
          },
        ]);
        return ok({
          ...this.present(run, 0),
          state: 'COMPLETED_EMPTY',
          entrants: 0,
          spots: snapshot.spots.length,
          assigned: 0,
          waitlisted: 0,
          finishedAt: this.clock.now().toISOString(),
        });
      }

      // ------------------------------------------------- the draw: pure, in-memory
      const result = this.draw.draw(snapshot.entrants, snapshot.spots, seed);

      const assignedIds = new Set(result.assignments.map((a) => a.residentId));
      const history: HistoryRow[] = [
        ...result.assignments.map((a) => ({
          residentId: a.residentId,
          spotId: a.spotId,
          result: 'ASSIGNED' as const,
          fairnessScoreAtDraw: a.fairnessScoreAtDraw,
          waitlistPosition: null,
        })),
        ...result.waitlist.map((w) => ({
          residentId: w.residentId,
          spotId: null,
          result: 'WAITLISTED' as const,
          fairnessScoreAtDraw: w.fairnessScoreAtDraw,
          waitlistPosition: w.position,
        })),
        ...snapshot.skippedResidentIds.map((id) => ({
          residentId: id,
          spotId: null,
          result: 'SKIPPED' as const,
          fairnessScoreAtDraw: 0,
          waitlistPosition: null,
        })),
      ];

      const fairness: FairnessState[] = snapshot.entrants.map((e) => {
        const before: FairnessState = {
          ...initialFairnessState(e.residentId),
          score: e.fairnessScore,
        };
        return applyOutcome(before, assignedIds.has(e.residentId) ? 'ASSIGNED' : 'WAITLISTED', cycle.id);
      });

      const events: DomainEvent[] = [
        {
          eventType: 'AllocationCompleted',
          aggregateType: 'AllocationRun',
          aggregateId: run.id,
          payload: {
            cycleId: cycle.id,
            cycleLabel: cycle.label,
            entrants: snapshot.entrants.length,
            assigned: result.assignments.length,
            waitlisted: result.waitlist.length,
            unmetAccessibilityNeeds: result.unmetAccessibilityNeeds,
          },
        },
        ...result.assignments.map((a) => ({
          eventType: 'SpotAssigned',
          aggregateType: 'SpotAssignment',
          aggregateId: a.residentId,
          payload: { cycleId: cycle.id, residentId: a.residentId, spotId: a.spotId },
        })),
        ...result.waitlist.map((w) => ({
          eventType: 'ResidentWaitlisted',
          aggregateType: 'WaitlistEntry',
          aggregateId: w.residentId,
          payload: { cycleId: cycle.id, residentId: w.residentId, position: w.position },
        })),
      ];

      // --------------------------------------------------------- one transaction
      await this.repo.commitRun({
        runId: run.id,
        cycleId: cycle.id,
        validFrom: cycle.startsOn,
        validUntil: cycle.endsOn,
        assignments: result.assignments.map((a) => ({ residentId: a.residentId, spotId: a.spotId })),
        waitlist: result.waitlist.map((w) => ({ residentId: w.residentId, position: w.position })),
        history,
        fairness,
        entrantsCount: snapshot.entrants.length,
        spotsCount: snapshot.spots.length,
        events,
      });

      // The cache is disposable (ADR-007): a failure here must not fail the run.
      await this.cache.invalidate('dashboard:').catch(() => undefined);
      await this.cache.invalidate('fairness:').catch(() => undefined);

      const finished = this.clock.now();
      return ok({
        runId: run.id,
        state: 'COMPLETED',
        algorithmVersion: result.algorithmVersion,
        randomSeed: Number(seed),
        entrants: snapshot.entrants.length,
        spots: snapshot.spots.length,
        assigned: result.assignments.length,
        waitlisted: result.waitlist.length,
        startedAt: run.startedAt.toISOString(),
        finishedAt: finished.toISOString(),
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      await this.repo.markRunFailed(run.id, detail).catch(() => undefined);
      return fail('INTERNAL_ERROR', 'The allocation run failed and was rolled back.');
    }
  }

  private present(run: { id: string; state: string; algorithmVersion: string; randomSeed: bigint; entrantsCount: number; spotsCount: number; assignedCount: number; startedAt: Date; finishedAt: Date | null }, waitlisted: number): RunResult {
    return {
      runId: run.id,
      state: run.state === 'COMPLETED_EMPTY' ? 'COMPLETED_EMPTY' : 'COMPLETED',
      algorithmVersion: run.algorithmVersion,
      randomSeed: Number(run.randomSeed),
      entrants: run.entrantsCount,
      spots: run.spotsCount,
      assigned: run.assignedCount,
      waitlisted: Math.max(0, waitlisted),
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    };
  }
}
