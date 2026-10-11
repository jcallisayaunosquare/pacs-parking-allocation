import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely's view of the section 11 schema. Hand-written rather than generated so the repository
 * layer compiles against the migration without a codegen step in CI; `pnpm migrate:up`
 * and this file are reviewed together.
 *
 * Note on types: `Generated<ColumnType<...>>` does not unwrap correctly, so DB-defaulted
 * timestamps are `Generated<Date>` and numerics spell their three modes out explicitly.
 * numeric(10,2) comes back from pg as a string - callers wrap it in Number().
 */

/** select string - insert number|string (required) */
type NumericRequired = ColumnType<string, number | string, number | string>;
/** select string|null - insert number|string|null|undefined */
type NumericNullable = ColumnType<string | null, number | string | null | undefined, number | string | null>;

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
export type PlateReadStatusDb = 'MATCHED' | 'UNMATCHED' | 'REVIEW' | 'DISCARDED';
export type PlateMatchKindDb = 'EXACT' | 'FUZZY' | 'MANUAL' | 'NONE';
export type AccessDecisionDb = 'ALLOW' | 'DENY' | 'REVIEW';

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
  /** Rule C's anchor for a resident who never held a bay. */
  participation_started_at: Generated<Date>;
  participation_reset_at: Date | null;
  has_electric_vehicle: Generated<boolean>;
  /** Separation of duties: an admin account never holds a bay or enters the draw. */
  is_admin: Generated<boolean>;
}

/**
 * A resident's registered car. `plate` is the canonical form - uppercase, no separators,
 * confusable glyphs folded - and is what a recognised plate is matched against;
 * `plate_display` is what the resident typed, which is what the register shows them.
 */
export interface VehicleTable {
  id: Generated<string>;
  resident_id: string;
  plate: string;
  plate_display: string;
  make: string | null;
  model: string | null;
  year: number | null;
  colour: string | null;
  notes: string | null;
  /**
   * Object keys or URLs. Written as a JSON string, read back as a parsed array by pg.
   * There is no upload pipeline behind it yet: S3 presigned PUT is the intended
   * follow-up, and until it exists the API stores what the caller sends and nothing more.
   */
  photos: ColumnType<string[], string, string>;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
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
  /** When the resident pulled out. Counts as having held a bay; never cleared. */
  withdrawn_at: Date | null;
}

export interface AllocationRunTable {
  id: Generated<string>;
  cycle_id: string;
  state: Generated<RunStateDb>;
  /** bytea: 32 bytes of seed. The repository converts to and from lowercase hex. */
  random_seed: Buffer;
  /** sha256(seed), published when registration closes and revealed with the result. */
  seed_commitment: Buffer;
  /** The one instant every priority key in the run was computed against. */
  decided_at: Generated<Date>;
  config_version: number;
  input_hash: Buffer | null;
  result_hash: Buffer | null;
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
  /** The instant benefit actually stopped. Materialised, never derived in a query. */
  benefit_ended_at: Date | null;
  /** The one column the ranking query reasons about. Written once, at termination. */
  counts_as_served: Generated<boolean>;
  termination_reason: string | null;
  make_whole: Generated<boolean>;
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
  /** Legacy: the weighted-lottery score. Nullable and no longer written. */
  fairness_score_at_draw: NumericNullable;
  waitlist_position: number | null;
  recorded_at: Generated<Date>;
}

/**
 * The contestable record. One row per candidate per run, append-only: this is what
 * answers "why did I lose?" without recomputing from data that has since moved.
 */
export interface AllocationRunCandidateTable {
  run_id: string;
  resident_id: string;
  anchor_at: Date;
  raw_wait_quanta: NumericRequired;
  /** Negative exactly when the Early-Waiting Bias applied. */
  effective_wait_quanta: NumericRequired;
  bias_applied: boolean;
  first_time: boolean;
  served_count: number;
  /** numeric(39,0): a 128-bit token, exact. Carried as a decimal string. */
  raffle_token: NumericRequired;
  final_rank: number;
  pool: string | null;
  outcome: DrawOutcomeDb;
  spot_id: string | null;
}

/** Rule A, versioned. A new version is an insert; rows are never edited. */
export interface AllocationConfigTable {
  version: Generated<number>;
  allocation_duration_months: Generated<number>;
  early_waiting_bias_hours: Generated<number>;
  wait_quantum_minutes: Generated<number>;
  /** Periods missed before waiting restarts. null disables the reset. */
  absence_reset_periods: number | null;
  total_bays: Generated<number>;
  changed_by: string | null;
  changed_at: Generated<Date>;
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

/**
 * The recognition thresholds, versioned and append-only like `allocation_config` - and
 * deliberately not part of it. The allocation module builds each new policy version from
 * the one in force and lists its own columns, so threshold columns living there would be
 * reset to their defaults every time an administrator changed the period length.
 */
export interface PlateConfigTable {
  version: Generated<number>;
  min_fused: Generated<NumericRequired>;
  review_fused: Generated<NumericRequired>;
  max_fuzzy_distance: Generated<number>;
  cooldown_seconds: Generated<number>;
  changed_by: string | null;
  changed_at: Generated<Date>;
}

/**
 * One row per captured frame: what the gate camera read, how sure the engine was, and
 * what a human later said it really was. The decision lives in `access_event`, not here,
 * so correcting a mis-read never rewrites the access log.
 *
 * `plate` carries the canonical form produced by `normalizePlate` - the same function
 * that writes `vehicle.plate` - which is what makes the gate lookup an index hit on
 * `ux_vehicle_plate_active`.
 */
export interface PlateReadTable {
  id: Generated<string>;
  /** The capture client's ULID, unique. The idempotency key of the whole pipeline. */
  capture_id: string;
  camera_id: string;
  captured_at: Date;
  received_at: Generated<Date>;
  raw_text: string | null;
  plate: string | null;
  /** numeric(5,4): comes back from pg as a string, written as a number. */
  confidence: NumericRequired;
  quality: NumericNullable;
  status: PlateReadStatusDb;
  vehicle_id: string | null;
  match_kind: Generated<PlateMatchKindDb>;
  match_distance: number | null;
  /** The ranked candidate list. Written as a JSON string, read back parsed by pg. */
  candidates: ColumnType<unknown, string, string>;
  image_key: string;
  crop_key: string | null;
  engine: string;
  engine_version: string | null;
  latency_ms: number | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  /** The administrator's ground truth. Every one of these is an evaluation label. */
  corrected_plate: string | null;
}

/**
 * The access log. Append-only for the same reason `allocation_history` is: it is the
 * record somebody reaches for when an entry is disputed. A decision is overturned by
 * inserting a new row and pointing the old one's `superseded_by` at it.
 */
export interface AccessEventTable {
  id: Generated<string>;
  plate_read_id: string;
  /** Denormalised: the resident may remove the car, and the log still names the plate. */
  plate: string;
  vehicle_id: string | null;
  resident_id: string | null;
  spot_id: string | null;
  decision: AccessDecisionDb;
  /** A stable code the frontend translates. Never prose. */
  reason: string;
  camera_id: string;
  occurred_at: Date;
  created_at: Generated<Date>;
  superseded_by: string | null;
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
  allocation_run_candidate: AllocationRunCandidateTable;
  allocation_config: AllocationConfigTable;
  event_outbox: EventOutboxTable;
  plate_config: PlateConfigTable;
  plate_read: PlateReadTable;
  access_event: AccessEventTable;
}
