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

/** The passes a run makes: restricted pools first, then everything else (BR-07). */
export type PoolName = 'ACCESSIBLE' | 'EV' | 'STANDARD';

/** Why an assignment ended. Feeds the termination policy, never the ranking query. */
export type TerminationReason = 'EXPIRED' | 'RELEASED' | 'REVOKED' | 'DECLINED' | 'CANCELLED';

/**
 * Why a registered resident was not a candidate. Recorded as SKIPPED, with the anchor
 * untouched: a resident is neither rewarded nor punished for a run they were not in.
 */
export type SkipReason = 'NOT_ELIGIBLE' | 'DEACTIVATED' | 'ADMIN_ACCOUNT' | 'HOLDS_ACTIVE_SPOT';

export interface SkippedCandidate {
  readonly residentId: string;
  readonly reason: SkipReason;
}

export interface DrawableSpot {
  readonly spotId: string;
  readonly spotCode: string;
  readonly type: SpotType;
}

/**
 * Bay status is derived, never stored: there is no RESERVED state and no status column to
 * drift out of step with the assignments. OUT_OF_SERVICE when the bay is deactivated,
 * HELD while an ACTIVE assignment exists, FREE otherwise.
 */
export type BayStatus = 'OUT_OF_SERVICE' | 'HELD' | 'FREE';

export const bayStatus = (bay: { isActive: boolean; hasActiveAssignment: boolean }): BayStatus =>
  !bay.isActive ? 'OUT_OF_SERVICE' : bay.hasActiveAssignment ? 'HELD' : 'FREE';
