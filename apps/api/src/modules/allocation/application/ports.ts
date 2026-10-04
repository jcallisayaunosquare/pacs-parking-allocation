import type {
  AssignmentState,
  CycleState,
  DrawOutcome,
  Entrant,
  DrawableSpot,
  RunState,
} from '../domain/types';
import type { FairnessState } from '../../fairness/domain/fairness';

/**
 * Ports the allocation use cases depend on. Everything here is an interface; the Kysely
 * and DynamoDB implementations live in the infrastructure ring and are wired in the
 * composition root (§10, ADR-012).
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
  readonly randomSeed: bigint;
  readonly algorithmVersion: string;
  readonly idempotencyKey: string;
  readonly entrantsCount: number;
  readonly spotsCount: number;
  readonly assignedCount: number;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly errorDetail: string | null;
}

/** Everything the draw needs, read inside one transaction so it is a consistent snapshot. */
export interface RunSnapshot {
  readonly entrants: readonly Entrant[];
  readonly spots: readonly DrawableSpot[];
  /** Registered residents excluded at snapshot time — recorded as SKIPPED (FR-21). */
  readonly skippedResidentIds: readonly string[];
}

export interface HistoryRow {
  readonly residentId: string;
  readonly spotId: string | null;
  readonly result: DrawOutcome;
  readonly fairnessScoreAtDraw: number;
  readonly waitlistPosition: number | null;
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
   * Inserts a RUNNING run. Rejects with RunLockHeldError when another run is in flight —
   * the partial unique index is the lock (§12, guard 1).
   */
  openRun(input: {
    cycleId: string;
    seed: bigint;
    algorithmVersion: string;
    idempotencyKey: string;
  }): Promise<RunRecord>;

  snapshotInputs(cycleId: string): Promise<RunSnapshot>;

  /** The one transaction of §12: assignments, waitlist, history, fairness, run, cycle, outbox. */
  commitRun(input: {
    runId: string;
    cycleId: string;
    validFrom: Date;
    validUntil: Date;
    assignments: readonly AssignmentRow[];
    waitlist: readonly WaitlistRow[];
    history: readonly HistoryRow[];
    fairness: readonly FairnessState[];
    entrantsCount: number;
    spotsCount: number;
    events: readonly DomainEvent[];
  }): Promise<void>;

  markRunFailed(runId: string, detail: string): Promise<void>;
  markRunCompletedEmpty(runId: string, events: readonly DomainEvent[]): Promise<void>;

  countActiveSpots(): Promise<number>;

  /** Sweeper: runs stuck in RUNNING past the timeout are failed and the lock freed (§12). */
  failStaleRuns(olderThan: Date): Promise<number>;
}

export interface RegistrationRepository {
  register(cycleId: string, residentId: string): Promise<{ created: boolean }>;
  withdraw(cycleId: string, residentId: string): Promise<boolean>;
  isRegistered(cycleId: string, residentId: string): Promise<boolean>;
}

export interface CycleRepository {
  create(input: Omit<CycleRecord, 'id' | 'state'>): Promise<CycleRecord>;
  list(): Promise<readonly CycleRecord[]>;
  transition(cycleId: string, to: CycleState): Promise<CycleRecord | null>;
  findByState(state: CycleState): Promise<readonly CycleRecord[]>;
  /** Next cycle a resident can register for, for the dashboard (§16). */
  findUpcoming(now: Date): Promise<CycleRecord | null>;
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
  /** UC-11: give up a spot, then promote the waitlist head in the same transaction. */
  release(assignmentId: string, at: Date): Promise<{ promotedResidentId: string | null }>;
  /** UC-14: expire assignments whose cycle has ended. */
  expireDue(now: Date): Promise<number>;
}

/** Cache port — DynamoDB in production, a no-op map in tests (ADR-017). */
export interface CachePort {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  invalidate(keyPrefix: string): Promise<void>;
}
