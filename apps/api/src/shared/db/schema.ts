import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely's view of the §11 schema. Hand-written rather than generated so the repository
 * layer compiles against the migration without a codegen step in CI; `pnpm migrate:up`
 * and this file are reviewed together.
 *
 * Note on types: `Generated<ColumnType<…>>` does not unwrap correctly, so DB-defaulted
 * timestamps are `Generated<Date>` and numerics spell their three modes out explicitly.
 * numeric(10,2) comes back from pg as a string — callers wrap it in Number().
 */

/** select string · insert number|string|undefined (DB default) · update number|string */
type NumericWithDefault = ColumnType<string, number | string | undefined, number | string>;
/** select string · insert number|string (required) */
type NumericRequired = ColumnType<string, number | string, number | string>;

export type SpotTypeDb = 'STANDARD' | 'ACCESSIBLE' | 'EV';
export type CycleStateDb =
  | 'DRAFT'
  | 'REGISTRATION_OPEN'
  | 'REGISTRATION_CLOSED'
  | 'ACTIVE'
  | 'CLOSED';
export type RunStateDb = 'RUNNING' | 'COMPLETED' | 'COMPLETED_EMPTY' | 'FAILED';
export type AssignmentStateDb = 'ACTIVE' | 'RELEASED' | 'REVOKED' | 'EXPIRED';
export type WaitlistStateDb = 'WAITING' | 'PROMOTED' | 'LAPSED';
export type DrawOutcomeDb = 'ASSIGNED' | 'WAITLISTED' | 'SKIPPED';

export interface ResidentTable {
  id: Generated<string>;
  external_subject: string | null;
  email: string;
  full_name: string;
  unit_number: string;
  is_eligible: Generated<boolean>;
  ineligible_reason: string | null;
  needs_accessible_spot: Generated<boolean>;
  created_at: Generated<Date>;
  deactivated_at: Date | null;
}

export interface VehicleTable {
  id: Generated<string>;
  resident_id: string;
  plate: string;
  make: string | null;
  colour: string | null;
  registered_at: Generated<Date>;
}

export interface ParkingSpotTable {
  id: Generated<string>;
  spot_code: string;
  level: string;
  type: Generated<SpotTypeDb>;
  is_active: Generated<boolean>;
  notes: string | null;
  created_at: Generated<Date>;
  deactivated_at: Date | null;
}

export interface AllocationCycleTable {
  id: Generated<string>;
  label: string;
  starts_on: Date;
  ends_on: Date;
  state: Generated<CycleStateDb>;
  registration_opens_at: Date;
  registration_closes_at: Date;
  created_at: Generated<Date>;
}

export interface RaffleRegistrationTable {
  id: Generated<string>;
  cycle_id: string;
  resident_id: string;
  registered_at: Generated<Date>;
  withdrawn: Generated<boolean>;
}

export interface AllocationRunTable {
  id: Generated<string>;
  cycle_id: string;
  state: Generated<RunStateDb>;
  /** bigint comes back as a string; the repository converts to BigInt. */
  random_seed: ColumnType<string, string | number | bigint, string | number | bigint>;
  algorithm_version: string;
  idempotency_key: string;
  entrants_count: Generated<number>;
  spots_count: Generated<number>;
  assigned_count: Generated<number>;
  started_at: Generated<Date>;
  finished_at: Date | null;
  error_detail: string | null;
}

export interface SpotAssignmentTable {
  id: Generated<string>;
  cycle_id: string;
  run_id: string;
  resident_id: string;
  spot_id: string;
  state: Generated<AssignmentStateDb>;
  valid_from: Date;
  valid_until: Date;
  released_at: Date | null;
}

export interface WaitlistEntryTable {
  id: Generated<string>;
  cycle_id: string;
  run_id: string;
  resident_id: string;
  position: number;
  state: Generated<WaitlistStateDb>;
}

export interface AllocationHistoryTable {
  id: Generated<string>;
  run_id: string;
  cycle_id: string;
  resident_id: string;
  spot_id: string | null;
  result: DrawOutcomeDb;
  fairness_score_at_draw: NumericRequired;
  waitlist_position: number | null;
  recorded_at: Generated<Date>;
}

export interface FairnessStateTable {
  id: Generated<string>;
  resident_id: string;
  score: NumericWithDefault;
  consecutive_misses: Generated<number>;
  total_registrations: Generated<number>;
  total_wins: Generated<number>;
  last_won_cycle_id: string | null;
  updated_at: Generated<Date>;
}

export interface EventOutboxTable {
  id: Generated<string>;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  /** Written as a JSON string, read back as a parsed object by pg. */
  payload: ColumnType<unknown, string, string>;
  occurred_at: Generated<Date>;
  published_at: Date | null;
  attempts: Generated<number>;
  last_error: string | null;
}

export interface Database {
  resident: ResidentTable;
  vehicle: VehicleTable;
  parking_spot: ParkingSpotTable;
  allocation_cycle: AllocationCycleTable;
  raffle_registration: RaffleRegistrationTable;
  allocation_run: AllocationRunTable;
  spot_assignment: SpotAssignmentTable;
  waitlist_entry: WaitlistEntryTable;
  allocation_history: AllocationHistoryTable;
  fairness_state: FairnessStateTable;
  event_outbox: EventOutboxTable;
}
