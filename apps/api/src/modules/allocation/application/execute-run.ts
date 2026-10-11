import { fail, RunLockHeldError } from '../../../shared/errors';
import { ok, type Result } from '../../../shared/result';
import type { Clock, SeedSource } from '../../../shared/clock';
import { isRunnable } from '../domain/cycle';
import { drawBlocker } from '../domain/draw-eligibility';
import {
  allocate,
  ALGORITHM_VERSION,
  inputHash,
  resultHash,
  seedCommitment,
  type AllocationInput,
} from '../domain/allocate';
import { quantaToHours } from '../domain/priority-key';
import type {
  AllocationConfigProvider,
  AllocationRepository,
  CachePort,
  DomainEvent,
  HistoryRow,
  RunCandidateRow,
  RunRecord,
} from './ports';

export interface ExecuteRunCommand {
  readonly cycleId: string;
  readonly idempotencyKey: string;
}

export interface RunResult {
  readonly runId: string;
  readonly state: 'COMPLETED' | 'COMPLETED_EMPTY';
  readonly algorithmVersion: string;
  /** Exposed deliberately: the seed plus the commitment is what makes the run auditable. */
  readonly randomSeedHex: string;
  readonly seedCommitmentHex: string;
  readonly decidedAt: string;
  readonly configVersion: number;
  readonly inputHashHex: string | null;
  readonly resultHashHex: string | null;
  readonly entrants: number;
  readonly spots: number;
  readonly assigned: number;
  readonly waitlisted: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/**
 * UC-05 - execute an allocation run:
 * idempotency check -> config -> lock and seed -> state check -> snapshot -> allocate (pure) ->
 * one transaction.
 *
 * Note where the transaction begins: after all computation. The decision is in-memory,
 * integer-only and sub-millisecond, so the database is held open only for the writes.
 *
 * Note also what is *not* here. The fairness policy is a pure domain function; this class
 * owns idempotency, the lock, the cycle state check, the snapshot, the single transaction
 * and cache invalidation. Swapping the policy cannot touch any of that.
 */
export class ExecuteRun {
  constructor(
    private readonly repo: AllocationRepository,
    private readonly config: AllocationConfigProvider,
    private readonly clock: Clock,
    private readonly seeds: SeedSource,
    private readonly cache: CachePort,
  ) {}

  async execute(cmd: ExecuteRunCommand): Promise<Result<RunResult>> {
    // ------------------------------------------------- idempotency (section 12, section 16)
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

    /*
     * And no other period may be in effect. Checked here, before the run row exists, for
     * the same reason the inventory is: a refused draw must leave no trace, because a
     * spurious run strips first-time-participant status from everyone in it (E-4).
     */
    const inEffect = await this.repo.findPeriodInEffect(cmd.cycleId);
    const blocked = drawBlocker({ state: cycle.state, periodInEffect: inEffect });
    if (blocked) return fail('INVALID_CYCLE_STATE', blocked);

    // An inventory error must not produce a run row at all: a spurious run would strip
    // first-time-participant status from everyone in it (edge case E-4).
    if ((await this.repo.countActiveSpots()) === 0) {
      return fail('NO_SPOTS_AVAILABLE', 'There are no active parking spots to allocate.');
    }

    const config = await this.config.current();

    // --------------------------------- lock, seed and commitment (section 12 guard 1)
    // The seed is drawn and persisted before the candidate list is read, so it cannot be
    // chosen with knowledge of who is competing, and the commitment makes re-rolling for
    // a nicer result a hash preimage problem rather than an operational one.
    const seedHex = this.seeds.next();
    let run: RunRecord;
    try {
      run = await this.repo.openRun({
        cycleId: cycle.id,
        seedHex,
        seedCommitmentHex: seedCommitment(seedHex),
        configVersion: config.version,
        algorithmVersion: ALGORITHM_VERSION,
        idempotencyKey: cmd.idempotencyKey,
      });
    } catch (e) {
      if (e instanceof RunLockHeldError) {
        return fail('RAFFLE_IN_PROGRESS', 'An allocation run is already executing for this cycle.');
      }
      throw e;
    }

    try {
      // One frozen instant for the whole run. Never Date.now() inside the loop: two
      // candidates' waiting times computed microseconds apart would make hour-bucket
      // membership a race, and no replay could reproduce it.
      const decidedAt = run.decidedAt;
      const snapshot = await this.repo.snapshotInputs(
        cycle.id,
        decidedAt,
        config.absenceResetPeriods,
      );

      if (snapshot.candidates.length === 0) {
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

      // -------------------------------------- the decision: pure, in-memory
      const input: AllocationInput = {
        runId: run.id,
        decidedAt,
        seedHex,
        config,
        candidates: snapshot.candidates,
        spots: snapshot.spots,
      };
      const result = allocate(input);
      const inputHashHex = inputHash(input);
      const resultHashHex = resultHash(result);

      const spotByResident = new Map(result.allocations.map((a) => [a.residentId, a]));

      // The contestable record: every key as computed, in final rank order.
      const candidateRows: RunCandidateRow[] = result.keys.map((k, i) => {
        const won = spotByResident.get(k.residentId);
        return {
          residentId: k.residentId,
          anchorAt: k.anchorAt,
          rawWaitQuanta: k.rawWaitQuanta,
          effectiveWaitQuanta: k.effectiveWaitQuanta,
          biasApplied: k.biasApplied,
          firstTime: k.firstTimeParticipant,
          servedCount: k.servedCount,
          raffleToken: k.raffleToken.toString(),
          finalRank: i + 1,
          pool: won?.pool ?? null,
          outcome: won ? ('ASSIGNED' as const) : ('WAITLISTED' as const),
          spotId: won?.spotId ?? null,
        };
      });

      const history: HistoryRow[] = [
        ...result.allocations.map((a) => ({
          residentId: a.residentId,
          spotId: a.spotId,
          result: 'ASSIGNED' as const,
          waitlistPosition: null,
        })),
        ...result.waitlist.map((w) => ({
          residentId: w.residentId,
          spotId: null,
          result: 'WAITLISTED' as const,
          waitlistPosition: w.position,
        })),
        ...snapshot.skipped.map((s) => ({
          residentId: s.residentId,
          spotId: null,
          result: 'SKIPPED' as const,
          waitlistPosition: null,
        })),
      ];

      const events: DomainEvent[] = [
        {
          eventType: 'AllocationCompleted',
          aggregateType: 'AllocationRun',
          aggregateId: run.id,
          payload: {
            cycleId: cycle.id,
            cycleLabel: cycle.label,
            entrants: snapshot.candidates.length,
            assigned: result.allocations.length,
            waitlisted: result.waitlist.length,
            unmetAccessibilityNeeds: result.unmetAccessibilityNeeds,
            unusedSpots: result.unusedSpotIds.length,
            skipped: snapshot.skipped.map((s) => ({ residentId: s.residentId, reason: s.reason })),
          },
        },
        ...result.allocations.map((a) => ({
          eventType: 'SpotAssigned',
          aggregateType: 'SpotAssignment',
          aggregateId: a.residentId,
          payload: { cycleId: cycle.id, residentId: a.residentId, spotId: a.spotId, pool: a.pool },
        })),
        ...result.waitlist.map((w) => ({
          eventType: 'ResidentWaitlisted',
          aggregateType: 'WaitlistEntry',
          aggregateId: w.residentId,
          payload: {
            cycleId: cycle.id,
            residentId: w.residentId,
            position: w.position,
            effectiveWaitHours: quantaToHours(
              result.keys.find((k) => k.residentId === w.residentId)?.effectiveWaitQuanta ?? 0,
              config,
            ),
          },
        })),
      ];

      // --------------------------------------------------------- one transaction
      await this.repo.commitRun({
        runId: run.id,
        cycleId: cycle.id,
        validFrom: cycle.startsOn,
        validUntil: cycle.endsOn,
        assignments: result.allocations.map((a) => ({ residentId: a.residentId, spotId: a.spotId })),
        waitlist: result.waitlist.map((w) => ({ residentId: w.residentId, position: w.position })),
        history,
        candidates: candidateRows,
        entrantsCount: snapshot.candidates.length,
        spotsCount: snapshot.spots.length,
        inputHashHex,
        resultHashHex,
        events,
      });

      // The cache is disposable (ADR-007): a failure here must not fail the run.
      await this.cache.invalidate('dashboard:').catch(() => undefined);
      await this.cache.invalidate('fairness:').catch(() => undefined);

      const finished = this.clock.now();
      return ok({
        runId: run.id,
        state: 'COMPLETED' as const,
        algorithmVersion: result.algorithmVersion,
        randomSeedHex: seedHex,
        seedCommitmentHex: run.seedCommitmentHex,
        decidedAt: decidedAt.toISOString(),
        configVersion: config.version,
        inputHashHex,
        resultHashHex,
        entrants: snapshot.candidates.length,
        spots: snapshot.spots.length,
        assigned: result.allocations.length,
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

  /** Waitlisted is derived rather than stored: entrants minus winners, never negative. */
  private present(run: RunRecord, waitlisted: number): RunResult {
    return {
      runId: run.id,
      state: run.state === 'COMPLETED_EMPTY' ? 'COMPLETED_EMPTY' : 'COMPLETED',
      algorithmVersion: run.algorithmVersion,
      randomSeedHex: run.randomSeedHex,
      seedCommitmentHex: run.seedCommitmentHex,
      decidedAt: run.decidedAt.toISOString(),
      configVersion: run.configVersion,
      inputHashHex: run.inputHashHex,
      resultHashHex: run.resultHashHex,
      entrants: run.entrantsCount,
      spots: run.spotsCount,
      assigned: run.assignedCount,
      waitlisted: Math.max(0, waitlisted),
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    };
  }
}
