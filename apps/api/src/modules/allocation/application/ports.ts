import type {
  AssignmentState,
  CycleState,
  DrawableSpot,
  DrawOutcome,
  RunState,
  SkippedCandidate,
  TerminationReason,
} from '../domain/types';
import type {
  AllocationConfig,
  AllocationConfigPatch,
  AllocationConfigVersion,
} from '../domain/allocation-config';
import type { Candidate } from '../domain/priority-key';

/**
 * Ports the allocation use cases depend on. Everything here is an interface; the Kysely
 * and DynamoDB implementations live in the infrastructure ring and are wired in the
 * composition root (section 10, ADR-012).
 */

export interface CycleRecord {
  readonly id: string;
  readonly label: string;
  readonly startsOn: Date;
  readonly endsOn: Date;
  readonly state: CycleState;
  readonly registrationOpensAt: Date;
  readonly registrationClosesAt: Date;
}

export interface RunRecord {
  readonly id: string;
  readonly cycleId: string;
  readonly state: RunState;
  /** 32 bytes of seed, as lowercase hex. The first field of every token preimage. */
  readonly randomSeedHex: string;
  readonly seedCommitmentHex: string;
  /** The single instant every priority key in this run was computed against. */
  readonly decidedAt: Date;
  readonly configVersion: number;
  readonly inputHashHex: string | null;
  readonly resultHashHex: string | null;
  readonly algorithmVersion: string;
  readonly idempotencyKey: string;
  readonly entrantsCount: number;
  readonly spotsCount: number;
  readonly assignedCount: number;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly errorDetail: string | null;
}

/** Everything the decision needs, read inside one transaction so it is a consistent snapshot. */
export interface RunSnapshot {
  readonly candidates: readonly Candidate[];
  readonly spots: readonly DrawableSpot[];
  /** Registered residents excluded at snapshot time - recorded as SKIPPED (FR-21). */
  readonly skipped: readonly SkippedCandidate[];
}

export interface HistoryRow {
  readonly residentId: string;
  readonly spotId: string | null;
  readonly result: DrawOutcome;
  readonly waitlistPosition: number | null;
}

/** One row of the contestable record: the key as computed, plus where it landed. */
export interface RunCandidateRow {
  readonly residentId: string;
  readonly anchorAt: Date;
  readonly rawWaitQuanta: number;
  readonly effectiveWaitQuanta: number;
  readonly biasApplied: boolean;
  readonly firstTime: boolean;
  readonly servedCount: number;
  /** The 128-bit token as a decimal string, so nothing rounds on the way to numeric(39,0). */
  readonly raffleToken: string;
  readonly finalRank: number;
  readonly pool: string | null;
  readonly outcome: DrawOutcome;
  readonly spotId: string | null;
}

export interface AssignmentRow {
  readonly residentId: string;
  readonly spotId: string;
}

export interface WaitlistRow {
  readonly residentId: string;
  readonly position: number;
}

export interface DomainEvent {
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

export interface AllocationRepository {
  findCycle(cycleId: string): Promise<CycleRecord | null>;
  findRunByIdempotencyKey(key: string): Promise<RunRecord | null>;
  findRun(runId: string): Promise<RunRecord | null>;
  /**
   * Every committed run, newest first, for the draws report. Capped rather than paged:
   * a building draws four times a year, so the whole history fits in one response for
   * decades, and a cursor here would be machinery for a list that never grows.
   */
  listRuns(limit: number): Promise<readonly RunRecord[]>;

  /**
   * Inserts a RUNNING run, with the seed and its commitment, before the candidate list is
   * read - which is the substance of the guarantee: the seed is fixed before the system
   * knows who is competing. Rejects with RunLockHeldError when another run is in flight;
   * the partial unique index is the lock (section 12, guard 1).
   */
  openRun(input: {
    cycleId: string;
    seedHex: string;
    seedCommitmentHex: string;
    configVersion: number;
    algorithmVersion: string;
    idempotencyKey: string;
  }): Promise<RunRecord>;

  /** The unordered snapshot. It never computes a priority key; the domain does that. */
  snapshotInputs(
    cycleId: string,
    decidedAt: Date,
    absenceResetPeriods: number | null,
  ): Promise<RunSnapshot>;

  /** The one transaction: assignments, waitlist, history, candidate keys, run, cycle, outbox. */
  commitRun(input: {
    runId: string;
    cycleId: string;
    validFrom: Date;
    validUntil: Date;
    assignments: readonly AssignmentRow[];
    waitlist: readonly WaitlistRow[];
    history: readonly HistoryRow[];
    candidates: readonly RunCandidateRow[];
    entrantsCount: number;
    spotsCount: number;
    inputHashHex: string;
    resultHashHex: string;
    events: readonly DomainEvent[];
  }): Promise<void>;

  markRunFailed(runId: string, detail: string): Promise<void>;
  markRunCompletedEmpty(runId: string, events: readonly DomainEvent[]): Promise<void>;

  countActiveSpots(): Promise<number>;
  /**
   * The period whose allocation is in force, when there is one, excluding the period
   * named. Null when nothing is in effect.
   */
  findPeriodInEffect(exceptCycleId: string): Promise<{ id: string; label: string } | null>;

  /** Sweeper: runs stuck in RUNNING past the timeout are failed and the lock freed (section 12). */
  failStaleRuns(olderThan: Date): Promise<number>;
}

/**
 * Rule A: never a literal in code. The port is what enforces that.
 *
 * The domain never calls this - allocate() takes an AllocationConfig value, which is what
 * keeps it testable by literal and stops configuration becoming an ambient dependency.
 */
export interface AllocationConfigProvider {
  /** The version in force now, for new runs and the dashboard. */
  current(): Promise<AllocationConfig>;
  /**
   * The version a past run used. Not optional: replaying a 2024 run under 2026's bias
   * would silently produce a different answer.
   */
  atVersion(version: number): Promise<AllocationConfig | null>;
  /** An admin edit inserts a new version; a row is never updated. */
  insert(values: Omit<AllocationConfig, 'version'>, changedBy: string | null): Promise<AllocationConfig>;
  history(limit: number): Promise<readonly AllocationConfigVersion[]>;
}

export type { AllocationConfigPatch };

export interface RegistrationRepository {
  register(cycleId: string, residentId: string): Promise<{ created: boolean }>;
  /** `at` is stored: a withdrawal counts as having held the bay and restarts the clock. */
  withdraw(cycleId: string, residentId: string, at: Date): Promise<boolean>;
  isRegistered(cycleId: string, residentId: string): Promise<boolean>;
  /**
   * Who is entered in a period's draw: active, not withdrawn, eligible and not an
   * administrator - the same pool the run is drawn from.
   */
  listEntrants(cycleId: string): Promise<readonly Entrant[]>;
}

export interface Entrant {
  readonly id: string;
  readonly fullName: string;
  readonly unitNumber: string;
  readonly registeredAt: Date;
}

export interface CycleRepository {
  create(input: Omit<CycleRecord, 'id' | 'state'>): Promise<CycleRecord>;
  list(): Promise<readonly CycleRecord[]>;
  transition(cycleId: string, to: CycleState): Promise<CycleRecord | null>;
  findByState(state: CycleState): Promise<readonly CycleRecord[]>;
  /** Next cycle a resident can register for, for the dashboard (section 16). */
  findUpcoming(now: Date): Promise<CycleRecord | null>;
  findById(cycleId: string): Promise<CycleRecord | null>;
  rename(cycleId: string, label: string): Promise<CycleRecord | null>;
  /**
   * What a period has produced. Read before a removal, because the answer is the
   * difference between a plan and a record.
   */
  consequences(cycleId: string): Promise<{ hasRun: boolean; assignments: number }>;
  /** Hard delete, and deliberately so: only ever reached for a period with no history. */
  remove(cycleId: string): Promise<boolean>;
  /**
   * Ends a period in effect now, expiring the assignments it handed out. The sweeper's
   * job done on request, with the benefit ending at `at` rather than at valid_until.
   */
  closeNow(cycleId: string, at: Date): Promise<boolean>;
}

export interface AssignmentRepository {
  findActiveForResident(residentId: string): Promise<{
    id: string;
    cycleId: string;
    spotId: string;
    spotCode: string;
    level: string;
    type: string;
    state: AssignmentState;
    validFrom: Date;
    validUntil: Date;
  } | null>;
  listForRun(runId: string): Promise<readonly { residentId: string; spotId: string; spotCode: string }[]>;
  /**
   * UC-11: give up a bay, then promote the waitlist head in the same transaction. The
   * termination is computed by the domain policy and passed in, so the repository never
   * decides whether an allocation counted as served.
   */
  release(
    assignmentId: string,
    at: Date,
    termination: { benefitEndedAt: Date; countsAsServed: boolean; reason: TerminationReason },
  ): Promise<{ promotedResidentId: string | null }>;
  /** UC-14: expire assignments whose cycle has ended. */
  expireDue(now: Date): Promise<number>;
}

/** Cache port - DynamoDB in production, a no-op map in tests (ADR-017). */
export interface CachePort {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  invalidate(keyPrefix: string): Promise<void>;
}
