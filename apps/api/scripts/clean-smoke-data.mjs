/**
 * Remove what the smoke suites leave behind: the rows in the dev database, and the
 * accounts in the Cognito user pool.
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
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const STAGE = process.env.STAGE ?? 'dev';

/**
 * The accounts a suite leaves in the user pool.
 *
 * They are not all created by the scripts: a resident created over the API is given a
 * Cognito account by `integrations`, from the pacs-events stream. So the pool collects
 * rows the database patterns above describe, plus the operator accounts the suites make
 * for themselves, which no database row ever mentions.
 *
 * Kept here with the SQL rather than in a second script, because "remove what the suites
 * left" is one job: splitting it is how nineteen accounts went unnoticed while the rows
 * were being tidied by hand.
 */
const USER_PATTERNS = [
  /^smoke-resident-\d+@example\.test$/,
  /^plates-resident-\d+@example\.test$/,
  /^pacs-resident-\d+@example\.test$/,
  /^pacs-plates-\d+@example\.test$/,
  /^pw-admin-\d+@example\.test$/,
];

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

/**
 * The suite accounts in the pool, by the patterns above.
 *
 * The pool id comes from the stack output rather than an environment variable, for the
 * same reason create-gate-user.mjs reads it there: one less thing to get wrong, and it
 * cannot point at the production pool by accident.
 *
 * Returns an empty list rather than failing when AWS is unreachable or the credentials
 * are missing - the database half of this clean-up is still worth doing, and it says so.
 */
const listSuiteUsers = async () => {
  try {
    const cfn = new CloudFormationClient({ region: REGION });
    const out = await cfn.send(new DescribeStacksCommand({ StackName: `pacs-api-${STAGE}` }));
    const poolId = (out.Stacks?.[0]?.Outputs ?? []).find((o) => o.OutputKey === 'UserPoolId')
      ?.OutputValue;
    if (!poolId) {
      console.log('\nThe stack has no UserPoolId output, so no accounts were examined.');
      return [];
    }
    const cognito = new CognitoIdentityProviderClient({ region: REGION });
    const found = [];
    let token;
    do {
      const page = await cognito.send(
        new ListUsersCommand({ UserPoolId: poolId, Limit: 60, PaginationToken: token }),
      );
      for (const u of page.Users ?? []) {
        const email = u.Attributes?.find((a) => a.Name === 'email')?.Value;
        if (email && USER_PATTERNS.some((p) => p.test(email))) {
          found.push({ email, username: u.Username, poolId });
        }
      }
      token = page.PaginationToken;
    } while (token);
    return found;
  } catch (e) {
    console.log(`\nCould not read the user pool (${e.message}); no accounts were examined.`);
    return [];
  }
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

  const users = await listSuiteUsers();
  console.log(`${users.length} Cognito account(s) created by a suite`);
  for (const u of users) console.log(`  ${u.email}`);

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

  /*
   * The accounts, after the commit rather than inside it.
   *
   * Cognito is not in the transaction and cannot be rolled back, so the rows are made
   * safe first. If an account then fails to delete it is said plainly and the next one is
   * still attempted: a pool with one account left over is a smaller problem than a run
   * that stops at the first error and leaves the rest.
   */
  let failed = 0;
  const cognito = users.length > 0 ? new CognitoIdentityProviderClient({ region: REGION }) : null;
  for (const u of users) {
    try {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: u.poolId, Username: u.username }));
    } catch (e) {
      console.log(`  could not remove ${u.email}: ${e.message}`);
      failed++;
    }
  }
  if (users.length > 0) {
    console.log(`Removed ${users.length - failed} of ${users.length} Cognito account(s).`);
  }
} catch (e) {
  await client.query('rollback').catch(() => {});
  throw e;
} finally {
  await client.end();
}
