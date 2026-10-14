/**
 * Remove every period from the dev database, with everything that hangs off them.
 *
 *   node scripts/reset-periods.mjs            # show what would go
 *   node scripts/reset-periods.mjs --apply    # remove it
 *
 * The product refuses this on purpose: a period that handed out a bay is part of the
 * allocation record, and DELETE /cycles answers INVALID_CYCLE_STATE. That rule is right
 * for a building. It is wrong for a development database being cleared before a demo, so
 * this exists as an operator's script - run by hand, from the one address the database's
 * security group admits, never from the API and never from the pipeline.
 *
 * What goes, per period: its allocation history, waitlist, bay assignments (which frees
 * the bays), registrations, the draw runs and their candidate rows, and the period. What
 * stays: residents, bays, vehicles, rules, gate reads. Waiting time is derived from the
 * history, so every resident's wait starts again from nothing.
 *
 * Before deleting, it reads from the live database which tables reference a period or a
 * run, and stops if one is not handled here. The migration files are not a safe source
 * for this schema - see the project notes - and a table this script did not know about
 * would otherwise either block the delete or, worse, keep rows pointing at nothing.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const APPLY = process.argv.includes('--apply');

// The connection string comes from apps/api/.env, as for clean-smoke-data.mjs: it holds a
// password and does not belong in a command line or a chat window.
const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Put it in apps/api/.env (gitignored).');
  process.exit(2);
}

/** The tables this script clears, keyed by the column that points at a period or a run. */
const HANDLED = new Set([
  'allocation_history.cycle_id',
  'allocation_history.run_id',
  'waitlist_entry.cycle_id',
  'waitlist_entry.run_id',
  'spot_assignment.cycle_id',
  'spot_assignment.run_id',
  'raffle_registration.cycle_id',
  'allocation_run.cycle_id',
  'allocation_run_candidate.run_id',
]);

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

try {
  // Every foreign key in the database that points at allocation_cycle or allocation_run.
  const { rows: refs } = await client.query(`
    select tc.table_name as tbl, kcu.column_name as col, ccu.table_name as target
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
     where tc.constraint_type = 'FOREIGN KEY'
       and ccu.table_name in ('allocation_cycle', 'allocation_run')
     order by 1, 2`);

  const unknown = refs.filter((r) => !HANDLED.has(`${r.tbl}.${r.col}`));
  if (unknown.length > 0) {
    console.error('Stopped: these tables reference a period or a run and are not handled here:');
    for (const r of unknown) console.error(`  ${r.tbl}.${r.col} -> ${r.target}`);
    console.error('Nothing was changed. Add them to the script before running it again.');
    process.exit(3);
  }

  const { rows: cycles } = await client.query(`
    select c.id, c.label, c.state, c.starts_on,
      (select count(*)::int from spot_assignment s where s.cycle_id = c.id) as assignments,
      (select count(*)::int from allocation_history h where h.cycle_id = c.id) as history,
      (select count(*)::int from raffle_registration r where r.cycle_id = c.id) as registrations,
      (select count(*)::int from waitlist_entry w where w.cycle_id = c.id) as waitlist,
      (select count(*)::int from allocation_run a where a.cycle_id = c.id) as runs
      from allocation_cycle c
     order by c.starts_on`);

  if (cycles.length === 0) {
    console.log('There are no periods. Nothing to do.');
    process.exit(0);
  }

  console.log(`${cycles.length} period(s):`);
  for (const c of cycles) {
    console.log(
      `  ${c.label} (${c.state}) - ${c.assignments} bay assignment(s), ${c.history} history row(s), ` +
        `${c.registrations} registration(s), ${c.waitlist} waitlist row(s), ${c.runs} draw run(s)`,
    );
  }

  if (!APPLY) {
    console.log('\nDry run. Nothing was changed. Pass --apply to remove all of the above.');
    process.exit(0);
  }

  // One transaction: half a reset leaves assignments pointing at a period that is gone.
  // Children before parents - the keys are RESTRICT, deliberately.
  await client.query('begin');
  const runsOf = 'select id from allocation_run where cycle_id = $1';
  for (const c of cycles) {
    // By period, and by run as well: a row is named by both, and the run's key is
    // RESTRICT, so anything still pointing at one of this period's runs would block it.
    for (const table of ['allocation_history', 'waitlist_entry', 'spot_assignment']) {
      await client.query(`delete from ${table} where cycle_id = $1`, [c.id]);
      await client.query(`delete from ${table} where run_id in (${runsOf})`, [c.id]);
    }
    await client.query('delete from raffle_registration where cycle_id = $1', [c.id]);
    await client.query(`delete from allocation_run_candidate where run_id in (${runsOf})`, [c.id]);
    await client.query('delete from allocation_run where cycle_id = $1', [c.id]);
    await client.query('delete from allocation_cycle where id = $1', [c.id]);
  }
  await client.query('commit');
  console.log(`\nRemoved ${cycles.length} period(s) and everything that referenced them.`);
} catch (e) {
  await client.query('rollback').catch(() => {});
  throw e;
} finally {
  await client.end();
}
