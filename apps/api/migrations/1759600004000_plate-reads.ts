/**
 * The plate-recognition log: what the gate camera read, and what was decided about it.
 *
 * Two tables, and the split between them is the point. `plate_read` is the record of a
 * capture - one row per frame, what the engine read, how sure it was, and whether a
 * human has since corrected it. `access_event` is the record of a decision - who was let
 * in or refused, append-only, because it is the row somebody reaches for when an entry is
 * disputed. Keeping them apart means a mis-read can be corrected without rewriting the
 * access log, which must not change after the fact (the same rule as `allocation_history`,
 * BR-05).
 *
 * `vehicle` is not touched. It already is the register of plates, and
 * `src/modules/residents/domain/vehicle.ts` already owns the canonical form - this module
 * imports `normalizePlate` rather than restating it, so "already registered" and
 * "recognised at the gate" cannot disagree.
 *
 * Raw SQL, like the three migrations before it: enums, partial indexes, jsonb CHECK
 * constraints and expression predicates are not things the DSL expresses well.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export const shorthands: undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(/* sql */ `
    CREATE TYPE plate_read_status AS ENUM ('MATCHED', 'UNMATCHED', 'REVIEW', 'DISCARDED');
    CREATE TYPE plate_match_kind  AS ENUM ('EXACT', 'FUZZY', 'MANUAL', 'NONE');
    CREATE TYPE access_decision   AS ENUM ('ALLOW', 'DENY', 'REVIEW');

    /*
     * The recognition thresholds, versioned and append-only.
     *
     * MODULO-PLACAS.md section 5 puts these in allocation_config, and that is the one
     * place this migration departs from it. allocation_config is written by the
     * allocation module's own insert, which lists its columns explicitly and builds each
     * new version from the one in force; three columns it does not know about would be
     * filled from their DEFAULTs on every policy edit, so an administrator changing the
     * period length would silently reset a calibration somebody spent a week measuring.
     *
     * Same table shape, same append-only discipline, own table - so the two policies
     * version independently, which is also truer: a bias in hours and an OCR confidence
     * floor have nothing to do with each other and are set by different evidence.
     */
    CREATE TABLE plate_config (
      version       integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      -- Automatic ALLOW at or above this fused confidence.
      min_fused     numeric(5,4) NOT NULL DEFAULT 0.8500
                      CHECK (min_fused BETWEEN 0 AND 1),
      -- Below this a read is unreadable and produces no access event at all.
      review_fused  numeric(5,4) NOT NULL DEFAULT 0.5500
                      CHECK (review_fused BETWEEN 0 AND 1),
      -- The largest edit distance a lone fuzzy match may have and still open the gate.
      max_fuzzy_distance smallint NOT NULL DEFAULT 1
                      CHECK (max_fuzzy_distance BETWEEN 0 AND 2),
      -- The dedupe window per (camera, plate), in seconds.
      cooldown_seconds integer NOT NULL DEFAULT 30
                      CHECK (cooldown_seconds BETWEEN 0 AND 3600),
      changed_by    uuid REFERENCES resident (id) ON DELETE SET NULL,
      changed_at    timestamptz NOT NULL DEFAULT now(),
      -- A review floor above the allow floor would make the band empty and every
      -- middling read either open the gate or vanish. Stated as a constraint because it
      -- is the one way these two numbers can be set to something incoherent.
      CONSTRAINT ck_plate_config_band CHECK (review_fused <= min_fused)
    );

    -- Version 1, the starting point of section 5. Honestly a starting point: it is
    -- replaced by the measurement procedure of section 8, which is an INSERT here.
    INSERT INTO plate_config (min_fused, review_fused, max_fuzzy_distance, cooldown_seconds)
    VALUES (0.8500, 0.5500, 1, 30);

    CREATE TABLE plate_read (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      -- The idempotency key, and the reason the whole pipeline can be at-least-once.
      -- It is minted by the capture client (a ULID) and travels in the S3 object's
      -- metadata. UNIQUE, not "we try not to duplicate": an S3 notification retry, a
      -- replayed DynamoDB stream shard and a redeployed consumer all arrive at the same
      -- INSERT, and ON CONFLICT DO NOTHING turns three deliveries into one row.
      capture_id      varchar(40) NOT NULL UNIQUE,

      camera_id       varchar(64) NOT NULL,
      captured_at     timestamptz NOT NULL,
      received_at     timestamptz NOT NULL DEFAULT now(),

      -- What the OCR actually returned, untouched. Kept for audit and for recalibrating
      -- a threshold later against what was really on the wire.
      raw_text        varchar(64),
      -- The canonical form, produced by the SAME normalizePlate() that writes
      -- vehicle.plate. Nullable because an unreadable frame is still a row.
      plate           varchar(20),
      CONSTRAINT ck_plate_read_canonical
        CHECK (plate IS NULL OR plate ~ '^[A-Z0-9]{2,20}$'),

      confidence      numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
      -- Sharpness/geometry of the plate crop. An independent signal from OCR confidence:
      -- a blurred crop the engine is certain about is the dangerous read, and only two
      -- separate numbers can say so.
      quality         numeric(5,4) CHECK (quality IS NULL OR quality BETWEEN 0 AND 1),

      status          plate_read_status NOT NULL,
      -- ON DELETE SET NULL, never CASCADE: a read is evidence and outlives the resident
      -- removing the car from the register.
      vehicle_id      uuid REFERENCES vehicle (id) ON DELETE SET NULL,
      match_kind      plate_match_kind NOT NULL DEFAULT 'NONE',
      -- Damerau-Levenshtein distance to the matched vehicle's plate. 0 on EXACT.
      match_distance  smallint CHECK (match_distance IS NULL OR match_distance BETWEEN 0 AND 4),

      -- The candidate list as the engine ranked it. jsonb rather than a child table
      -- because nothing ever queries inside it: it is read whole, by one review screen.
      candidates      jsonb NOT NULL DEFAULT '[]'::jsonb,
      CONSTRAINT ck_plate_read_candidates_array CHECK (jsonb_typeof(candidates) = 'array'),

      image_key       varchar(512) NOT NULL,       -- the S3 object holding the frame
      crop_key        varchar(512),                -- the plate crop, when one was written
      engine          varchar(40)  NOT NULL,
      engine_version  varchar(40),
      latency_ms      integer CHECK (latency_ms IS NULL OR latency_ms >= 0),

      -- Human review. All NULL until somebody has looked.
      reviewed_by     uuid REFERENCES resident (id) ON DELETE SET NULL,
      reviewed_at     timestamptz,
      review_note     text,
      -- What the administrator asserted the plate really was. Every one of these is a
      -- ground-truth label, which is how the evaluation set builds itself from day one.
      corrected_plate varchar(20),
      CONSTRAINT ck_plate_read_corrected_canonical
        CHECK (corrected_plate IS NULL OR corrected_plate ~ '^[A-Z0-9]{2,20}$'),
      CONSTRAINT ck_plate_read_review_complete
        CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL))
    );

    -- The review queue: what is pending, oldest first. A doubtful read loses its value
    -- once the car has gone, so the queue is read in arrival order.
    CREATE INDEX ix_plate_read_review_queue
      ON plate_read (captured_at) WHERE status = 'REVIEW' AND reviewed_at IS NULL;
    -- "when did this car come in": history by plate.
    CREATE INDEX ix_plate_read_plate_time ON plate_read (plate, captured_at DESC)
      WHERE plate IS NOT NULL;
    -- The gate log, and the dedupe window.
    CREATE INDEX ix_plate_read_camera_time ON plate_read (camera_id, captured_at DESC);
    CREATE INDEX ix_plate_read_vehicle ON plate_read (vehicle_id) WHERE vehicle_id IS NOT NULL;
    -- The gate log unfiltered, newest first. Without it the default listing is a sort of
    -- the whole table; with it the first page is an index scan.
    CREATE INDEX ix_plate_read_time ON plate_read (captured_at DESC);

    CREATE TABLE access_event (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      plate_read_id  uuid NOT NULL REFERENCES plate_read (id) ON DELETE RESTRICT,
      -- Denormalised deliberately: the resident may remove the vehicle, and the log still
      -- has to say which plate came through.
      plate          varchar(20) NOT NULL,
      vehicle_id     uuid REFERENCES vehicle (id) ON DELETE SET NULL,
      resident_id    uuid REFERENCES resident (id) ON DELETE SET NULL,
      -- The bay the resident held in the period in force, when they held one. It answers
      -- the administrator's real question: an authorised car parked in someone else's bay.
      spot_id        uuid REFERENCES parking_spot (id) ON DELETE SET NULL,

      decision       access_decision NOT NULL,
      -- A stable code, translatable in the frontend. Never prose.
      reason         varchar(48) NOT NULL,
      camera_id      varchar(64) NOT NULL,
      occurred_at    timestamptz NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),

      -- When an administrator overturns a decision, the new row is linked from here and
      -- the original is never edited.
      superseded_by  uuid REFERENCES access_event (id) ON DELETE SET NULL
    );

    /*
     * One live decision per read.
     *
     * MODULO-PLACAS.md section 2 writes this as UNIQUE (plate_read_id, superseded_by),
     * and that constraint does not hold the rule: in Postgres two NULLs are distinct
     * inside a unique constraint, so the superseded_by IS NULL rows - exactly the ones
     * that must be unique - are the ones it fails to constrain. A partial unique index on
     * plate_read_id over the live rows is the version that actually enforces it, and it
     * also expresses the history correctly: a read may accumulate any number of
     * superseded rows and has at most one standing decision at a time.
     *
     * The consequence for the writer: a correction must point the old row at the new one
     * BEFORE inserting it, which is why resolve() mints the new id itself rather than
     * letting the default fill it in. See kysely-plate-read.repository.ts.
     */
    CREATE UNIQUE INDEX ux_access_event_live_per_read
      ON access_event (plate_read_id) WHERE superseded_by IS NULL;

    CREATE INDEX ix_access_event_time ON access_event (occurred_at DESC);
    CREATE INDEX ix_access_event_resident ON access_event (resident_id, occurred_at DESC)
      WHERE resident_id IS NOT NULL;
    CREATE INDEX ix_access_event_denied ON access_event (occurred_at DESC)
      WHERE decision = 'DENY';
    CREATE INDEX ix_access_event_read ON access_event (plate_read_id);
  `);

  /*
   * The grants, on the same principle as allocation_history (BR-05): the application
   * role may add to the record and never rewrite it.
   *
   * plate_read gets UPDATE because review is an update of the read - the status, the
   * corrected plate and who looked. access_event does not: a decision is overturned by
   * inserting a new row, so the only UPDATE it would ever need is the superseded_by
   * link, and granting UPDATE for that would also grant the ability to rewrite a
   * decision. The link is therefore written by the same INSERT path through a
   * SECURITY-free route: see below.
   */
  pgm.sql(/* sql */ `
    GRANT SELECT, INSERT         ON plate_config TO app_user;
    GRANT USAGE ON SEQUENCE plate_config_version_seq TO app_user;
    GRANT SELECT, INSERT, UPDATE ON plate_read   TO app_user;
    GRANT SELECT, INSERT         ON access_event TO app_user;
    -- The one column app_user may change on an access event: the link to the row that
    -- replaced it. Column-level, so the decision, the reason and the timestamps stay
    -- immutable to the application even during a correction.
    GRANT UPDATE (superseded_by) ON access_event TO app_user;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(/* sql */ `
    DROP TABLE IF EXISTS access_event;
    DROP TABLE IF EXISTS plate_read;
    DROP TABLE IF EXISTS plate_config;

    DROP TYPE IF EXISTS access_decision;
    DROP TYPE IF EXISTS plate_match_kind;
    DROP TYPE IF EXISTS plate_read_status;
  `);
}
