/**
 * Two fairness rules the building settled after the first model shipped.
 *
 *   1. Missing a period costs your place in the queue. A resident who does not register
 *      for a period comes back with their waiting time at zero, as if they had just
 *      arrived. Their history is untouched: the count of bays they have held is
 *      permanent and never resets.
 *
 *   2. Withdrawing a registration counts as having held the bay. Registering and then
 *      pulling out is a decision about a bay, so it increments the same lifetime count a
 *      finished allocation does and restarts the same clock.
 *
 * Both follow the rule the whole model is built on: nothing about waiting time is stored
 * as a number somebody has to remember to update. A withdrawal records *when* it
 * happened and the arithmetic stays a subtraction at read time.
 *
 * Two knobs change with them:
 *
 *   - `decline_grace_hours` goes. Declining a bay you won used to be free inside a
 *     window; under rule 2 it cannot be, or withdrawing before the draw would cost more
 *     than rejecting the bay afterwards.
 *   - `absence_reset_months` becomes `absence_reset_periods`. The reset is counted in
 *     periods missed, not months elapsed, because that is the unit the rule is stated in
 *     and the only one a resident can act on. Default 1: miss one period, lose the
 *     clock. NULL still disables the reset.
 *
 * Deliberately not backfilled: registrations already withdrawn keep a NULL
 * `withdrawn_at` and cost nothing. The rule applies from here forward - charging people
 * for a decision taken under the old rule is exactly the retroactive rewrite the
 * versioned config exists to prevent.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export const shorthands: undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(/* sql */ `
    ALTER TABLE raffle_registration
      -- When the resident pulled out. NULL means they never did; the boolean stays as
      -- the question "are they in this draw", which re-registering flips back.
      ADD COLUMN withdrawn_at timestamptz;

    -- The forfeit lookup is per resident and ignores the cycle, so this is the shape the
    -- ranking snapshot reads: every withdrawal a resident has ever made, newest first.
    CREATE INDEX ix_registration_forfeit
      ON raffle_registration (resident_id, withdrawn_at DESC)
      WHERE withdrawn_at IS NOT NULL;

    ALTER TABLE allocation_config
      DROP COLUMN decline_grace_hours;

    ALTER TABLE allocation_config
      RENAME COLUMN absence_reset_months TO absence_reset_periods;

    ALTER TABLE allocation_config
      ALTER COLUMN absence_reset_periods SET DEFAULT 1;

    -- Every stored version is restated in the new unit. The column changed meaning, so
    -- leaving 3 in place would read as "three periods" and silently weaken the rule on
    -- every run that points at an old version.
    UPDATE allocation_config SET absence_reset_periods = 1 WHERE absence_reset_periods IS NOT NULL;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(/* sql */ `
    ALTER TABLE allocation_config
      RENAME COLUMN absence_reset_periods TO absence_reset_months;

    ALTER TABLE allocation_config
      ALTER COLUMN absence_reset_months SET DEFAULT NULL;

    UPDATE allocation_config SET absence_reset_months = 3 WHERE absence_reset_months IS NOT NULL;

    ALTER TABLE allocation_config
      ADD COLUMN decline_grace_hours int NOT NULL DEFAULT 48 CHECK (decline_grace_hours >= 0);

    DROP INDEX IF EXISTS ix_registration_forfeit;

    ALTER TABLE raffle_registration
      DROP COLUMN withdrawn_at;
  `);
}
