export type SpotType = 'STANDARD' | 'ACCESSIBLE' | 'EV';

export type CycleState =
  | 'DRAFT'
  | 'REGISTRATION_OPEN'
  | 'REGISTRATION_CLOSED'
  | 'ACTIVE'
  | 'CLOSED';

export type RunState = 'RUNNING' | 'COMPLETED' | 'COMPLETED_EMPTY' | 'FAILED';

export type AssignmentState = 'ACTIVE' | 'RELEASED' | 'REVOKED' | 'EXPIRED';

export type WaitlistState = 'WAITING' | 'PROMOTED' | 'LAPSED';

export type DrawOutcome = 'ASSIGNED' | 'WAITLISTED' | 'SKIPPED';

/** One participant in a draw, as snapshotted when the run started (§12). */
export interface Entrant {
  readonly residentId: string;
  /** fairness_state.score at snapshot time. Weight is score + 1. */
  readonly fairnessScore: number;
  readonly needsAccessibleSpot: boolean;
}

export interface DrawableSpot {
  readonly spotId: string;
  readonly spotCode: string;
  readonly type: SpotType;
}

export interface DrawAssignment {
  readonly residentId: string;
  readonly spotId: string;
  readonly fairnessScoreAtDraw: number;
  /** True when pass 1 matched an ACCESSIBLE spot to a resident who needs one. */
  readonly viaAccessibilityPreAssignment: boolean;
}

export interface DrawWaitlistEntry {
  readonly residentId: string;
  readonly position: number;
  readonly fairnessScoreAtDraw: number;
}

export interface DrawResult {
  readonly algorithmVersion: string;
  readonly seed: bigint;
  readonly assignments: readonly DrawAssignment[];
  readonly waitlist: readonly DrawWaitlistEntry[];
  /** Residents who need an accessible spot but none was available (§12 edge case). */
  readonly unmetAccessibilityNeeds: readonly string[];
}

/**
 * The draw is a strategy because the weighting policy is a business decision, not an
 * engineering one — open question Q-03 (cap the weight? super-linear growth?) can be
 * answered later without touching the use case (§12).
 */
export interface DrawStrategy {
  readonly version: string;
  draw(entrants: readonly Entrant[], spots: readonly DrawableSpot[], seed: bigint): DrawResult;
}
