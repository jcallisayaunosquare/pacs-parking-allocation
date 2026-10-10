/**
 * Remove what the smoke suites leave behind in the dev database.
 *
 *   node scripts/clean-smoke-data.mjs            # show what would go
 *   node scripts/clean-smoke-data.mjs --apply    # remove it
 *
 * Needs DATABASE_URL, and needs to run from an address the database's security group
 * admits - which today is one IP, the developer's. That is also why this exists as a
 * script rather than as a step in the pipeline: CodeBuild runs outside the VPC on
 * addresses that change, so the smoke stage cannot tidy up after itself there. It says
 * what it left instead, and this clears it.
 *
 * Why there is anything to clear at all: `smoke.mjs` has to create a cycle, a bay and a
 * resident to exercise the routes that create them, and it cannot assert on rows it did
 * not make. `smoke-plates.mjs` does the same with a resident and a vehicle. Run on every
 * deployment, those accumulate - and they are not inert. A cycle in REGISTRATION_CLOSED
 * is what the "ready to draw" banner points at, so a test fixture ended up at the top of
 * the administrator's screen telling them a period called 2235-Q1 was ready to run.
 *
 * The patterns below match only what the suites generate. Nothing else is touched, the
 * default is a dry run, and every statement is scoped by those patterns rather than by
 * a date or a count.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const APPLY = process.argv.includes('--apply');

/*
 * The connection string comes from apps/api/.env when there is one.
 *
 * It holds a database password, so it does not belong in a shell command that lands in
 * terminal history, in a CI variable, or in a chat window. `.env` is in .gitignore and
 * has been since the repository was created.
 */
const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

/**
 * What the suites make, as SQL patterns.
 *
 * `smoke.mjs` builds its labels from a random year in the far future, its bays as
 * SMK-#### and its residents as smoke-resident-<timestamp>@example.test;
 * `smoke-plates.mjs` uses plates-resident-<timestamp>@example.test and registers the
 * plate 1234ABC against it. The year pattern is the loosest of them, so it is bounded:
 * no real period in this building starts after 2100.
 */
const PATTERNS = {
  cycles: { sql: "label ~ '^(2[1-9][0-9]{2}|[3-9][0-9]{3})-Q[1-4]$'", what: 'periods labelled past 2100' },
  spots: { sql: "spot_code like 'SMK-%'", what: 'bays named SMK-' },
  residents: {
    sql: "email like 'smoke-resident-%@example.test' or email like 'plates-resident-%@example.test'",
    what: 'residents created by a suite',
  },
};

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const list = async (table, where, column) => {
  const { rows } = await client.query(`select id, ${column} as label from ${table} where ${where} order by ${column}`);
  return rows;
};

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL is not set.\n\n' +
      'Put it in apps/api/.env as one line:\n' +
      '  DATABASE_URL=postgresql://USER:PASSWORD@hotel-db.c94uguqg6e4o.us-east-2.rds.amazonaws.com:5432/pacs_dev\n\n' +
      'That file is gitignored. The database only admits one address, so this has to\n' +
      'run from the machine whose IP is in the security group.',
  );
  process.exit(2);
}

await client.connect();

try {
  const cycles = await list('allocation_cycle', PATTERNS.cycles.sql, 'label');
  const spots = await list('parking_spot', PATTERNS.spots.sql, 'spot_code');
  const residents = await list('resident', PATTERNS.residents.sql, 'email');

  console.log(`${cycles.length} ${PATTERNS.cycles.what}`);
  for (const c of cycles) console.log(`  ${c.label}`);
  console.log(`${spots.length} ${PATTERNS.spots.what}`);
  for (const s of spots) console.log(`  ${s.label}`);
  console.log(`${residents.length} ${PATTERNS.residents.what}`);
  for (const r of residents) console.log(`  ${r.label}`);

  if (!APPLY) {
    console.log('\nDry run. Pass --apply to remove them.');
    process.exit(0);
  }

  /*
   * One transaction: a half-finished clean-up leaves a cycle without its assignments,
   * which is a worse state than the one being cleaned.
   *
   * Children before parents, because these foreign keys are RESTRICT rather than
   * CASCADE - deliberately, since allocation history is an audit record and the schema
   * refuses to let it disappear quietly behind a deleted row.
   */
  await client.query('begin');

  for (const c of cycles) {
    await client.query('delete from allocation_history where cycle_id = $1', [c.id]);
    await client.query('delete from waitlist_entry where cycle_id = $1', [c.id]);
    await client.query('delete from spot_assignment where cycle_id = $1', [c.id]);
    await client.query('delete from raffle_registration where cycle_id = $1', [c.id]);
    // The candidate rows hold the draw's inputs per run, and their FK to the run is
    // RESTRICT, so they go before the runs do.
    await client.query(
      'delete from allocation_run_candidate where run_id in (select id from allocation_run where cycle_id = $1)',
      [c.id],
    );
    await client.query('delete from allocation_run where cycle_id = $1', [c.id]);
    await client.query('delete from allocation_cycle where id = $1', [c.id]);
  }

  for (const r of residents) {
    await client.query('delete from vehicle where resident_id = $1', [r.id]);
    await client.query('delete from allocation_history where resident_id = $1', [r.id]);
    await client.query('delete from waitlist_entry where resident_id = $1', [r.id]);
    await client.query('delete from spot_assignment where resident_id = $1', [r.id]);
    await client.query('delete from raffle_registration where resident_id = $1', [r.id]);
    await client.query('delete from allocation_run_candidate where resident_id = $1', [r.id]);
    // These three columns say who changed a setting or reviewed a read. The FK on
    // allocation_config.changed_by has no ON DELETE clause, so it is NO ACTION and would
    // refuse the delete outright; the other two are SET NULL already, and are cleared
    // here only so the intent is in one place.
    await client.query('update allocation_config set changed_by = null where changed_by = $1', [r.id]);
    await client.query('update plate_config set changed_by = null where changed_by = $1', [r.id]);
    await client.query('update plate_read set reviewed_by = null where reviewed_by = $1', [r.id]);
    await client.query('delete from resident where id = $1', [r.id]);
  }

  // Bays are retired rather than deleted: a bay may be named in the history of a real
  // period, and that record is not ours to rewrite.
  for (const s of spots) {
    await client.query(
      `update parking_spot
          set is_active = false, deactivated_at = now(), notes = 'Retired: created by the smoke suite'
        where id = $1`,
      [s.id],
    );
  }

  await client.query('commit');
  console.log('\nRemoved. Bays were retired rather than deleted, since history may name them.');
} catch (e) {
  await client.query('rollback').catch(() => {});
  throw e;
} finally {
  await client.end();
}
