/**
 * The vehicle register: the cars a resident may bring into the building.
 *
 * `vehicle` already exists - the init migration created a stub of it (plate, make,
 * colour, registered_at) that nothing ever wrote to. This migration expands that stub
 * rather than dropping and recreating the table, because the table is referenced by the
 * `app_user` grants of migration 1 and a DROP/CREATE would silently reset them. Expand
 * in place, and the grants, the primary key and the foreign key survive untouched.
 *
 * What this exists for: license-plate recognition at the gate. A camera reads a plate,
 * the plates module normalises it the same way this table does and looks it up. That is
 * the whole reason plate and plate_display are two columns - see below.
 *
 * Raw SQL for the same reasons as the two migrations before it: partial unique indexes,
 * jsonb CHECK constraints and column renames are not things the DSL expresses well.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export const shorthands: undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(/* sql */ `
    ALTER TABLE vehicle
      -- Two plate columns, deliberately.
      --
      -- plate is the canonical key: uppercase, no separators, confusable glyphs folded
      -- (O and Q to 0, I to 1 - the rule lives in
      -- src/modules/residents/domain/vehicle.ts and is the single definition of it).
      -- It is what a recognised plate is matched against, so it must not depend on how
      -- the resident chose to punctuate it.
      --
      -- plate_display is what the resident typed, trimmed and uppercased but otherwise
      -- untouched. It is what the register shows them. Folding the display form would
      -- print "ABC 123" back as "ABC123" with the O they typed turned into a zero, and
      -- a resident who cannot find their own plate in the list stops trusting the list.
      ADD COLUMN plate_display varchar(20),
      ADD COLUMN model         varchar(80),
      -- smallint: a model year, not a date. The upper bound is a static 2100 rather than
      -- 'next year', because a CHECK constraint has to be immutable and now() is not.
      -- The tighter rule - at most next model year - is enforced in the domain, where the
      -- clock is injected and the resident gets a field-level message instead of a 500.
      ADD COLUMN year          smallint,
      ADD COLUMN notes         text,
      -- Object keys or URLs, nothing more. There is no upload pipeline behind this yet:
      -- the intended follow-up is an S3 presigned PUT per photo, with the key written
      -- here once the client reports the upload finished. Until that exists, whatever
      -- the caller sends is stored verbatim and the API does not pretend to host images.
      ADD COLUMN photos        jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN is_active     boolean NOT NULL DEFAULT true,
      ADD COLUMN updated_at    timestamptz NOT NULL DEFAULT now();

    -- registered_at was always this table's creation stamp; name it like every other
    -- table's so the repository layer has one convention rather than two.
    ALTER TABLE vehicle RENAME COLUMN registered_at TO created_at;

    -- Backfill before tightening: the stub's rows, if any exist, have no display form.
    UPDATE vehicle SET plate_display = plate WHERE plate_display IS NULL;

    ALTER TABLE vehicle
      ALTER COLUMN plate_display SET NOT NULL,
      ADD CONSTRAINT ck_vehicle_year_sane
        CHECK (year IS NULL OR year BETWEEN 1900 AND 2100),
      ADD CONSTRAINT ck_vehicle_photos_array
        CHECK (jsonb_typeof(photos) = 'array');

    -- The stub only promised uppercase. The canonical form promises more than that: no
    -- spaces, no dashes, no dots, nothing outside A-Z and 0-9. Stated as a constraint so
    -- a writer that bypasses the domain cannot poison the lookup key.
    ALTER TABLE vehicle
      DROP CONSTRAINT IF EXISTS ck_vehicle_plate_normalised;
    ALTER TABLE vehicle
      ADD CONSTRAINT ck_vehicle_plate_canonical CHECK (plate ~ '^[A-Z0-9]{2,20}$');

    /*
     * Uniqueness across the building, partial on is_active - and that is the decision
     * worth stating.
     *
     * The rule being enforced is "two residents cannot have the same plate registered at
     * the same time", not "this plate may only ever be registered once in the history of
     * the building". Those differ in two situations that actually happen:
     *
     *   - a resident sells the car to a neighbour, who then cannot register it, because a
     *     removed row from 2026 still owns the plate;
     *   - a resident removes a vehicle by mistake and cannot put it back.
     *
     * Both would read as a bug, and the only fix available to an administrator would be
     * a DELETE, which is exactly what removal is designed to avoid. So removal is a
     * deactivation and the index ignores deactivated rows.
     *
     * The cost is that the full history of plates is not unique. Nothing needs it to be:
     * the gate lookup only ever asks about active rows, and the recognition module stores
     * its own events against the plate text rather than against a vehicle id.
     */
    /*
     * The constraint, not the index. vehicle_plate_key is the index Postgres built to
     * enforce a UNIQUE constraint of the same name, and it refuses to drop it on its own
     * ("cannot drop index vehicle_plate_key because constraint ... requires it").
     * Dropping the constraint takes its index with it; the IF EXISTS after it covers a
     * database where the name is a bare index instead.
     */
    ALTER TABLE vehicle DROP CONSTRAINT IF EXISTS vehicle_plate_key;
    DROP INDEX IF EXISTS vehicle_plate_key;
    CREATE UNIQUE INDEX ux_vehicle_plate_active ON vehicle (plate) WHERE is_active;

    -- The two queries this table has: one resident's cars, and one plate at the gate.
    CREATE INDEX ix_vehicle_resident_active ON vehicle (resident_id) WHERE is_active;
  `);

  /*
   * The foreign key stays ON DELETE CASCADE, as the init migration wrote it.
   *
   * CASCADE rather than RESTRICT because a vehicle is not an audit record: it has no
   * meaning apart from the resident who registered it, nothing points at a vehicle row
   * (allocation history and the recognition log both key on their own data), and a
   * resident is never hard-deleted in normal operation anyway - removal sets
   * deactivated_at and the row stays. So the cascade only ever fires during a genuine
   * data repair or a test teardown, and in both of those RESTRICT would leave orphans
   * blocking the very operation being attempted, for no audit value gained.
   */
  pgm.sql(/* sql */ `
    GRANT SELECT, INSERT, UPDATE, DELETE ON vehicle TO app_user;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(/* sql */ `
    DROP INDEX IF EXISTS ix_vehicle_resident_active;
    DROP INDEX IF EXISTS ux_vehicle_plate_active;

    ALTER TABLE vehicle
      DROP CONSTRAINT IF EXISTS ck_vehicle_plate_canonical,
      DROP CONSTRAINT IF EXISTS ck_vehicle_photos_array,
      DROP CONSTRAINT IF EXISTS ck_vehicle_year_sane;

    -- Back to the init shape. A deactivated duplicate plate would fail the restored
    -- UNIQUE, so the deactivated rows go: they are the rows this migration's partial
    -- index made possible in the first place, and keeping them would make down() fail
    -- rather than reverse.
    DELETE FROM vehicle WHERE NOT is_active;

    ALTER TABLE vehicle
      DROP COLUMN IF EXISTS updated_at,
      DROP COLUMN IF EXISTS is_active,
      DROP COLUMN IF EXISTS photos,
      DROP COLUMN IF EXISTS notes,
      DROP COLUMN IF EXISTS year,
      DROP COLUMN IF EXISTS model,
      DROP COLUMN IF EXISTS plate_display;

    ALTER TABLE vehicle RENAME COLUMN created_at TO registered_at;

    ALTER TABLE vehicle
      ADD CONSTRAINT vehicle_plate_key UNIQUE (plate),
      ADD CONSTRAINT ck_vehicle_plate_normalised CHECK (plate = upper(plate));
  `);
}
