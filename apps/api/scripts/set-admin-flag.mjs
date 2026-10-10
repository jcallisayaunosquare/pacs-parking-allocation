/**
 * Flag a resident row as an administrator, or clear the flag.
 *
 *   node scripts/set-admin-flag.mjs admin@example.com          # show what would change
 *   node scripts/set-admin-flag.mjs admin@example.com --apply
 *   node scripts/set-admin-flag.mjs admin@example.com --clear --apply
 *
 * Why this exists: the ADMIN role lives in a Cognito group, and `resident.is_admin` is a
 * second, independent record of the same fact. The two can disagree, and when they do the
 * building administrator shows up in the residents table and in the fairness figures as
 * an ordinary resident - which is what happened on dev, where the flag was never set on
 * the account that operates the draw.
 *
 * `is_admin` is what excludes an account from the allocation:
 *   - kysely-fairness.read-model.ts filters `r.is_admin = false` out of the snapshot
 *   - kysely-allocation.repository.ts leaves the flagged rows out of the candidate pool
 *   - cycle.use-cases.ts refuses the registration outright
 * The role on the token refuses a registration too, so the two are belt and braces.
 *
 * Nothing in the web client sends `isAdmin`, so the only ways to set it are PATCH
 * /residents/{id} with a token, and this. It applies the same rule the use case does: a
 * resident holding a bay cannot be made an administrator until the bay is released.
 *
 * Needs DATABASE_URL in apps/api/.env, and an address the database's security group
 * admits.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CLEAR = args.includes('--clear');
const email = args.find((a) => !a.startsWith('--'));

if (!email) {
  console.error('Usage: node scripts/set-admin-flag.mjs <email> [--clear] [--apply]');
  process.exit(2);
}

const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Put it in apps/api/.env.');
  process.exit(2);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

try {
  const { rows } = await client.query(
    'select id, email, full_name, unit_number, is_admin from resident where email = $1',
    [email],
  );
  if (rows.length === 0) {
    console.error(`No resident row with email ${email}.`);
    process.exit(1);
  }
  const r = rows[0];
  const target = !CLEAR;
  console.log(`${r.email} - ${r.full_name}, unit ${r.unit_number}`);
  console.log(`  is_admin: ${r.is_admin} -> ${target}`);

  if (r.is_admin === target) {
    console.log('\nAlready in that state. Nothing to do.');
    process.exit(0);
  }

  /*
   * The same rule as resident.use-cases.ts: an administrator is out of the draw, so the
   * flag cannot go on while they hold a bay. Released or revoked rows do not count.
   */
  if (target) {
    const { rows: held } = await client.query(
      `select s.spot_code, c.label from spot_assignment sa
         join parking_spot s on s.id = sa.spot_id
         join allocation_cycle c on c.id = sa.cycle_id
        where sa.resident_id = $1 and sa.state = 'ACTIVE'`,
      [r.id],
    );
    if (held.length > 0) {
      console.error(
        `\nThis resident holds ${held.map((h) => `${h.spot_code} (${h.label})`).join(', ')}.\n` +
          'Release the bay before making the account an administrator.',
      );
      process.exit(1);
    }
  }

  if (!APPLY) {
    console.log('\nDry run. Pass --apply to write it.');
    process.exit(0);
  }

  await client.query('update resident set is_admin = $1 where id = $2', [target, r.id]);
  console.log(`\nDone. is_admin is now ${target}.`);
} finally {
  await client.end();
}
