/**
 * Initial PACS schema — the physical form of analisis.html §11.
 *
 * Written as raw SQL rather than the node-pg-migrate DSL because the design leans on
 * features the DSL does not express well: partial unique indexes (the run lock),
 * citext columns, and table-level privilege revocation on the append-only history.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export const shorthands: undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(/* sql */ `
    CREATE EXTENSION IF NOT EXISTS citext;

    -- ---------------------------------------------------------------- enums
    CREATE TYPE spot_type        AS ENUM ('STANDARD', 'ACCESSIBLE', 'EV');
    CREATE TYPE cycle_state      AS ENUM ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ACTIVE', 'CLOSED');
    CREATE TYPE run_state        AS ENUM ('RUNNING', 'COMPLETED', 'COMPLETED_EMPTY', 'FAILED');
    CREATE TYPE assignment_state AS ENUM ('ACTIVE', 'RELEASED', 'REVOKED', 'EXPIRED');
    CREATE TYPE waitlist_state   AS ENUM ('WAITING', 'PROMOTED', 'LAPSED');
    CREATE TYPE draw_outcome     AS ENUM ('ASSIGNED', 'WAITLISTED', 'SKIPPED');

    -- ------------------------------------------------------------- resident
    CREATE TABLE resident (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      external_subject      varchar(255) UNIQUE,
      email                 citext NOT NULL UNIQUE,
      full_name             varchar(200) NOT NULL,
      unit_number           varchar(40) NOT NULL,
      is_eligible           boolean NOT NULL DEFAULT true,
      ineligible_reason     varchar(500),
      needs_accessible_spot boolean NOT NULL DEFAULT false,
      created_at            timestamptz NOT NULL DEFAULT now(),
      deactivated_at        timestamptz,
      CONSTRAINT ck_resident_ineligible_has_reason
        CHECK (is_eligible OR ineligible_reason IS NOT NULL)
    );

    CREATE TABLE vehicle (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      resident_id   uuid NOT NULL REFERENCES resident (id) ON DELETE CASCADE,
      plate         varchar(20) NOT NULL UNIQUE,
      make          varchar(80),
      colour        varchar(40),
      registered_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_vehicle_plate_normalised CHECK (plate = upper(plate))
    );

    -- --------------------------------------------------------- parking_spot
    CREATE TABLE parking_spot (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      spot_code      varchar(40) NOT NULL UNIQUE,
      level          varchar(20) NOT NULL,
      type           spot_type NOT NULL DEFAULT 'STANDARD',
      is_active      boolean NOT NULL DEFAULT true,
      notes          text,
      created_at     timestamptz NOT NULL DEFAULT now(),
      deactivated_at timestamptz
    );

    -- ------------------------------------------------------ allocation_cycle
    CREATE TABLE allocation_cycle (
      id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      label                   varchar(20) NOT NULL UNIQUE,
      starts_on               date NOT NULL,
      ends_on                 date NOT NULL,
      state                   cycle_state NOT NULL DEFAULT 'DRAFT',
      registration_opens_at   timestamptz NOT NULL,
      registration_closes_at  timestamptz NOT NULL,
      created_at              timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_cycle_dates CHECK (ends_on > starts_on),
      CONSTRAINT ck_cycle_registration_window CHECK (registration_closes_at > registration_opens_at)
    );

    -- --------------------------------------------------- raffle_registration
    CREATE TABLE raffle_registration (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cycle_id      uuid NOT NULL REFERENCES allocation_cycle (id) ON DELETE CASCADE,
      resident_id   uuid NOT NULL REFERENCES resident (id) ON DELETE CASCADE,
      registered_at timestamptz NOT NULL DEFAULT now(),
      withdrawn     boolean NOT NULL DEFAULT false,
      CONSTRAINT uq_registration_per_cycle UNIQUE (cycle_id, resident_id)
    );

    -- -------------------------------------------------------- allocation_run
    CREATE TABLE allocation_run (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cycle_id          uuid NOT NULL REFERENCES allocation_cycle (id) ON DELETE CASCADE,
      state             run_state NOT NULL DEFAULT 'RUNNING',
      random_seed       bigint NOT NULL,
      algorithm_version varchar(60) NOT NULL,
      idempotency_key   varchar(200) NOT NULL UNIQUE,
      entrants_count    int NOT NULL DEFAULT 0,
      spots_count       int NOT NULL DEFAULT 0,
      assigned_count    int NOT NULL DEFAULT 0,
      started_at        timestamptz NOT NULL DEFAULT now(),
      finished_at       timestamptz,
      error_detail      text
    );

    -- The run lock (FR-03): at most one run in flight across the whole system.
    -- A partial unique index needs no infrastructure and survives process restarts.
    CREATE UNIQUE INDEX uq_single_running_run
      ON allocation_run ((state)) WHERE state = 'RUNNING';

    -- ------------------------------------------------------- spot_assignment
    CREATE TABLE spot_assignment (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cycle_id    uuid NOT NULL REFERENCES allocation_cycle (id) ON DELETE CASCADE,
      run_id      uuid NOT NULL REFERENCES allocation_run (id) ON DELETE CASCADE,
      resident_id uuid NOT NULL REFERENCES resident (id) ON DELETE RESTRICT,
      spot_id     uuid NOT NULL REFERENCES parking_spot (id) ON DELETE RESTRICT,
      state       assignment_state NOT NULL DEFAULT 'ACTIVE',
      valid_from  timestamptz NOT NULL,
      valid_until timestamptz NOT NULL,
      released_at timestamptz,
      CONSTRAINT uq_one_spot_per_resident_per_cycle UNIQUE (cycle_id, resident_id),
      CONSTRAINT uq_one_resident_per_spot_per_cycle UNIQUE (cycle_id, spot_id),
      CONSTRAINT ck_assignment_validity CHECK (valid_until > valid_from)
    );

    -- --------------------------------------------------------- waitlist_entry
    CREATE TABLE waitlist_entry (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cycle_id    uuid NOT NULL REFERENCES allocation_cycle (id) ON DELETE CASCADE,
      run_id      uuid NOT NULL REFERENCES allocation_run (id) ON DELETE CASCADE,
      resident_id uuid NOT NULL REFERENCES resident (id) ON DELETE CASCADE,
      position    int NOT NULL,
      state       waitlist_state NOT NULL DEFAULT 'WAITING',
      CONSTRAINT uq_waitlist_position UNIQUE (cycle_id, position),
      CONSTRAINT uq_waitlist_resident UNIQUE (cycle_id, resident_id),
      CONSTRAINT ck_waitlist_position_positive CHECK (position > 0)
    );

    -- ------------------------------------------------------ allocation_history
    -- Append-only (BR-05). Snapshots the fairness score so a past run stays explainable.
    CREATE TABLE allocation_history (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id                 uuid NOT NULL REFERENCES allocation_run (id) ON DELETE RESTRICT,
      cycle_id               uuid NOT NULL REFERENCES allocation_cycle (id) ON DELETE RESTRICT,
      resident_id            uuid NOT NULL REFERENCES resident (id) ON DELETE RESTRICT,
      spot_id                uuid REFERENCES parking_spot (id) ON DELETE RESTRICT,
      result                 draw_outcome NOT NULL,
      fairness_score_at_draw numeric(10, 2) NOT NULL,
      waitlist_position      int,
      recorded_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_history_spot_when_assigned
        CHECK ((result = 'ASSIGNED') = (spot_id IS NOT NULL)),
      CONSTRAINT ck_history_position_when_waitlisted
        CHECK ((result = 'WAITLISTED') = (waitlist_position IS NOT NULL))
    );

    -- --------------------------------------------------------- fairness_state
    CREATE TABLE fairness_state (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      resident_id         uuid NOT NULL UNIQUE REFERENCES resident (id) ON DELETE CASCADE,
      score               numeric(10, 2) NOT NULL DEFAULT 0,
      consecutive_misses  int NOT NULL DEFAULT 0,
      total_registrations int NOT NULL DEFAULT 0,
      total_wins          int NOT NULL DEFAULT 0,
      last_won_cycle_id   uuid REFERENCES allocation_cycle (id) ON DELETE SET NULL,
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_fairness_score_non_negative CHECK (score >= 0)
    );

    -- ----------------------------------------------------------- event_outbox
    -- §15: domain events are written in the same transaction as the state change,
    -- then relayed after commit. No event can exist for a rolled-back change.
    CREATE TABLE event_outbox (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type     varchar(80) NOT NULL,
      aggregate_type varchar(60) NOT NULL,
      aggregate_id   uuid NOT NULL,
      payload        jsonb NOT NULL,
      occurred_at    timestamptz NOT NULL DEFAULT now(),
      published_at   timestamptz,
      attempts       int NOT NULL DEFAULT 0,
      last_error     text
    );

    -- ---------------------------------------------------------------- indexes
    CREATE INDEX ix_registration_cycle      ON raffle_registration (cycle_id) WHERE withdrawn = false;
    CREATE INDEX ix_spot_assignable         ON parking_spot (type) WHERE is_active = true;
    CREATE INDEX ix_assignment_resident_now ON spot_assignment (resident_id, state) WHERE state = 'ACTIVE';
    CREATE INDEX ix_assignment_cycle        ON spot_assignment (cycle_id);
    CREATE INDEX ix_history_resident_recent ON allocation_history (resident_id, recorded_at DESC);
    CREATE INDEX ix_waitlist_next           ON waitlist_entry (cycle_id, position) WHERE state = 'WAITING';
    CREATE INDEX ix_fairness_rank           ON fairness_state (score DESC);
    CREATE INDEX ix_resident_active         ON resident (unit_number) WHERE deactivated_at IS NULL;
    CREATE INDEX ix_cycle_state             ON allocation_cycle (state);
    CREATE INDEX ix_run_cycle               ON allocation_run (cycle_id, started_at DESC);
    CREATE INDEX ix_outbox_unpublished      ON event_outbox (occurred_at) WHERE published_at IS NULL;
  `);

  // The application role. History is append-only at the database level, not by convention:
  // even a compromised application credential cannot rewrite the audit trail (§11, BR-05).
  pgm.sql(/* sql */ `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user NOLOGIN;
      END IF;
    END
    $$;

    GRANT USAGE ON SCHEMA public TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

    REVOKE UPDATE, DELETE ON allocation_history FROM app_user;
    REVOKE UPDATE, DELETE ON allocation_run FROM app_user;
    GRANT UPDATE (state, finished_at, error_detail, entrants_count, spots_count, assigned_count)
      ON allocation_run TO app_user;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(/* sql */ `
    DROP TABLE IF EXISTS event_outbox;
    DROP TABLE IF EXISTS allocation_history;
    DROP TABLE IF EXISTS waitlist_entry;
    DROP TABLE IF EXISTS spot_assignment;
    DROP TABLE IF EXISTS fairness_state;
    DROP TABLE IF EXISTS allocation_run;
    DROP TABLE IF EXISTS raffle_registration;
    DROP TABLE IF EXISTS allocation_cycle;
    DROP TABLE IF EXISTS parking_spot;
    DROP TABLE IF EXISTS vehicle;
    DROP TABLE IF EXISTS resident;

    DROP TYPE IF EXISTS draw_outcome;
    DROP TYPE IF EXISTS waitlist_state;
    DROP TYPE IF EXISTS assignment_state;
    DROP TYPE IF EXISTS run_state;
    DROP TYPE IF EXISTS cycle_state;
    DROP TYPE IF EXISTS spot_type;
  `);
}
