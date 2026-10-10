import { createHash } from 'node:crypto';
import { biasQuanta, type AllocationConfig } from './allocation-config';

/**
 * The priority key of rules C, D, E and F, and the total order over it.
 *
 * The comparator lives in the domain because it is the business rule the product is
 * judged on, because it has to be testable with no infrastructure at all, and because it
 * is the thing most likely to change. Nothing in this file does I/O, reads a clock or
 * draws a random number: the instant and the seed are arguments.
 */

/** One candidate, as snapshotted at run.decidedAt. Pure data: no behaviour, no I/O. */
export interface Candidate {
  readonly residentId: string;
  /** Rule C's anchor for a resident who never held a spot. Set when first made eligible. */
  readonly participationStartedAt: Date;
  /** End of the most recent allocation that counted as served. null means never served. */
  readonly lastBenefitEndAt: Date | null;
  /** Rule D - lifetime count of allocations that counted. Never reset. */
  readonly servedCount: number;
  /** Committed runs this resident has appeared in. 0 means a first-time participant. */
  readonly priorParticipations: number;
  readonly needsAccessibleSpot: boolean;
  readonly hasElectricVehicle: boolean;
}

/**
 * The persisted, auditable priority key. Every field is written to
 * allocation_run_candidate so a past run is explainable without re-deriving it.
 */
export interface PriorityKey {
  readonly residentId: string;
  /** Primary key, DESC. Negative exactly when the Early-Waiting Bias applies. */
  readonly effectiveWaitQuanta: number;
  /** Secondary key, ASC (rule D). */
  readonly servedCount: number;
  /** Tertiary key, ASC - the raffle (rule E step 3). 128-bit, identity-derived. */
  readonly raffleToken: bigint;
  // ---- explanation fields: never compared, always shown ----
  readonly anchorAt: Date;
  readonly rawWaitQuanta: number;
  readonly biasApplied: boolean;
  readonly firstTimeParticipant: boolean;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

/**
 * Rules C, D, E and F as one pure function of (candidate, config, instant, seed).
 *
 * The Early-Waiting Bias is a subtraction, not a branch on the opponent. Because a
 * resident is cooling exactly while their raw wait is below the window, the subtraction
 * drives every cooling resident strictly negative and everyone else non-negative - so
 * rule F's hard gate is a theorem of the arithmetic rather than a second comparison
 * path. That is what makes the comparator transitive; the pairwise reading of rule F
 * admits a 3-resident cycle (see the regression test in priority-key.spec.ts) and must
 * never be implemented.
 */
export function computePriorityKey(
  c: Candidate,
  cfg: AllocationConfig,
  decidedAt: Date,
  seedHex: string,
  runId: string,
): PriorityKey {
  const quantumMs = cfg.waitQuantumMinutes * MS_PER_MINUTE;
  const bias = biasQuanta(cfg);

  const anchorMs = Math.max(
    c.participationStartedAt.getTime(),
    c.lastBenefitEndAt?.getTime() ?? c.participationStartedAt.getTime(),
  );

  // Clamped at 0: a clock that went backwards, or an admin typo that puts activation in
  // the future, must not mint priority out of nothing.
  const rawWaitQuanta = Math.max(0, Math.floor((decidedAt.getTime() - anchorMs) / quantumMs));

  const sinceBenefitMs =
    c.lastBenefitEndAt === null ? null : decidedAt.getTime() - c.lastBenefitEndAt.getTime();
  const biasApplied =
    sinceBenefitMs !== null &&
    sinceBenefitMs >= 0 &&
    sinceBenefitMs < cfg.earlyWaitingBiasHours * MS_PER_HOUR;

  return {
    residentId: c.residentId,
    effectiveWaitQuanta: rawWaitQuanta - (biasApplied ? bias : 0),
    servedCount: c.servedCount,
    raffleToken: raffleToken(seedHex, runId, c.residentId),
    anchorAt: new Date(anchorMs),
    rawWaitQuanta,
    biasApplied,
    firstTimeParticipant: c.priorParticipations === 0,
  };
}

/**
 * Rule E step 3. Derived from identity, never from position in the input array: a
 * resident can recompute this with sha256sum and three strings, which is the whole of
 * the fairness proof we offer them. The run id in the preimage stops a token from being
 * reused - or predicted - across runs.
 */
export function raffleToken(seedHex: string, runId: string, residentId: string): bigint {
  const digest = createHash('sha256').update(`${seedHex}:${runId}:${residentId}`).digest('hex');
  return BigInt(`0x${digest.slice(0, 32)}`); // 128 bits
}

/**
 * The total order of rule E. Lexicographic over a product of total orders, so it is
 * transitive by construction. residentId is a terminal guard against a 128-bit token
 * collision and must never decide a real run - ordering by id alone is the alphabetical
 * bias the draw exists to avoid.
 */
export function compareByPriority(a: PriorityKey, b: PriorityKey): number {
  if (a.effectiveWaitQuanta !== b.effectiveWaitQuanta) {
    return b.effectiveWaitQuanta - a.effectiveWaitQuanta; // longer wait first
  }
  if (a.servedCount !== b.servedCount) {
    return a.servedCount - b.servedCount; // fewer past allocations first
  }
  if (a.raffleToken !== b.raffleToken) {
    return a.raffleToken < b.raffleToken ? -1 : 1; // the raffle
  }
  return a.residentId < b.residentId ? -1 : a.residentId > b.residentId ? 1 : 0;
}

/** Waiting time in hours, for anything a human reads. The key itself stays in quanta. */
export const quantaToHours = (quanta: number, cfg: Pick<AllocationConfig, 'waitQuantumMinutes'>): number =>
  Math.round((quanta * cfg.waitQuantumMinutes) / 60);
