/**
 * Remove every user except those whose email starts with a given prefix - from the dev
 * database and from the Cognito user pool.
 *
 *   node scripts/keep-only-users.mjs --keep <prefix>            # show who stays and who goes
 *   node scripts/keep-only-users.mjs --keep <prefix> --apply    # remove the ones who go
 *
 * An operator's script for clearing a development environment before a demo, run by hand
 * from the address the database's security group admits. The product never deletes a
 * resident who is named in the allocation record; this does, with everything that names
 * them, because the point is to start again from data the operator entered.
 *
 * The prefix is required and has no default. A default is how the wrong people get
 * deleted. The dry run prints both lists, so a mistyped prefix shows up as "nobody stays"
 * before anything is removed - and the script refuses outright if nobody would stay.
 *
 * Before deleting, it reads from the live database which tables reference a resident or
 * a vehicle, and stops if one is not handled here: the migration files are not a safe
 * source for this schema.
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
const APPLY = process.argv.includes('--apply');

const keepAt = process.argv.indexOf('--keep');
const PREFIX = keepAt >= 0 ? (process.argv[keepAt + 1] ?? '').trim().toLowerCase() : '';
if (!PREFIX || PREFIX.startsWith('--')) {
  console.error('Pass the prefix to keep: --keep <prefix>. There is no default, on purpose.');
  process.exit(2);
}
const keeps = (email) => (email ?? '').toLowerCase().startsWith(PREFIX);

// Credentials from apps/api/.env, as the other operator scripts: never on a command line.
const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Put it in apps/api/.env (gitignored).');
  process.exit(2);
}

/**
 * Every reference to a resident or a vehicle this script knows how to clear, and how:
 * 'delete' removes the referencing row, 'null' clears the column (the row is a record of
 * something else - a setting, a camera read - that should outlive who touched it).
 */
const HANDLED = {
  'vehicle.resident_id': 'delete',
  'allocation_history.resident_id': 'delete',
  'waitlist_entry.resident_id': 'delete',
  'spot_assignment.resident_id': 'delete',
  'raffle_registration.resident_id': 'delete',
  'allocation_run_candidate.resident_id': 'delete',
  'allocation_config.changed_by': 'null',
  'plate_config.changed_by': 'null',
  'plate_read.reviewed_by': 'null',
  // The gate's access log. A record of a barrier decision, so it outlives the resident
  // it named - unattributed - where the column allows it (see nullable() below).
  'access_event.resident_id': 'null',
};
const HANDLED_VEHICLE = {
  'plate_read.vehicle_id': 'null',
  'access_event.vehicle_id': 'null',
};

const listPoolUsers = async () => {
  const cfn = new CloudFormationClient({ region: REGION });
  const out = await cfn.send(new DescribeStacksCommand({ StackName: `pacs-api-${STAGE}` }));
  const poolId = (out.Stacks?.[0]?.Outputs ?? []).find((o) => o.OutputKey === 'UserPoolId')
    ?.OutputValue;
  if (!poolId) throw new Error(`stack pacs-api-${STAGE} has no UserPoolId output`);
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const users = [];
  let token;
  do {
    const page = await cognito.send(
      new ListUsersCommand({ UserPoolId: poolId, Limit: 60, PaginationToken: token }),
    );
    for (const u of page.Users ?? []) {
      const email = u.Attributes?.find((a) => a.Name === 'email')?.Value ?? null;
      users.push({ username: u.Username, email, poolId });
    }
    token = page.PaginationToken;
  } while (token);
  return { cognito, users };
};

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

try {
  const { rows: refs } = await client.query(`
    select tc.table_name as tbl, kcu.column_name as col, ccu.table_name as target
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
     where tc.constraint_type = 'FOREIGN KEY'
       and ccu.table_name in ('resident', 'vehicle')
     order by 1, 2`);
  /*
   * Whether each referencing column admits null, read from the live schema. A 'null'
   * reference on a NOT NULL column cannot be cleared - the update would fail and roll
   * the whole reset back - so for those the referencing row is deleted instead.
   */
  const { rows: cols } = await client.query(`
    select table_name, column_name, is_nullable = 'YES' as nullable
      from information_schema.columns
     where table_schema = current_schema()`);
  const nullableSet = new Set(
    cols.filter((c) => c.nullable).map((c) => `${c.table_name}.${c.column_name}`),
  );
  const how = (ref, declared) => (declared === 'null' && !nullableSet.has(ref) ? 'delete' : declared);

  const unknown = refs.filter((r) => {
    const key = `${r.tbl}.${r.col}`;
    return r.target === 'resident' ? !(key in HANDLED) : !(key in HANDLED_VEHICLE);
  });
  if (unknown.length > 0) {
    console.error('Stopped: these tables reference a resident or a vehicle and are not handled here:');
    for (const r of unknown) console.error(`  ${r.tbl}.${r.col} -> ${r.target}`);
    console.error('Nothing was changed.');
    process.exit(3);
  }

  const { rows: residents } = await client.query(
    'select id, email from resident order by email',
  );
  const stayRows = residents.filter((r) => keeps(r.email));
  const goRows = residents.filter((r) => !keeps(r.email));

  let pool = { cognito: null, users: [] };
  let poolError = null;
  try {
    pool = await listPoolUsers();
  } catch (e) {
    poolError = e.message;
  }
  const stayUsers = pool.users.filter((u) => keeps(u.email));
  const goUsers = pool.users.filter((u) => !keeps(u.email));

  console.log(`Keeping emails that start with "${PREFIX}".\n`);
  console.log('For each user that goes, rows that reference them are:');
  for (const r of refs) {
    const ref = `${r.tbl}.${r.col}`;
    const declared = r.target === 'resident' ? HANDLED[ref] : HANDLED_VEHICLE[ref];
    console.log(`  ${ref.padEnd(38)} ${how(ref, declared) === 'delete' ? 'deleted' : 'kept, reference cleared'}`);
  }
  console.log('');
  console.log(`Database - ${stayRows.length} stay:`);
  for (const r of stayRows) console.log(`  + ${r.email}`);
  console.log(`Database - ${goRows.length} go:`);
  for (const r of goRows) console.log(`  - ${r.email}`);
  if (poolError) {
    console.log(`\nCognito - could not read the pool (${poolError}); no accounts examined.`);
  } else {
    console.log(`\nCognito - ${stayUsers.length} stay:`);
    for (const u of stayUsers) console.log(`  + ${u.email ?? `(no email) ${u.username}`}`);
    console.log(`Cognito - ${goUsers.length} go:`);
    for (const u of goUsers) console.log(`  - ${u.email ?? `(no email) ${u.username}`}`);
  }

  // A prefix that keeps nobody is a typo, not an instruction: it would remove the
  // operator's own sign-in along with everyone else's.
  if (stayRows.length === 0 && stayUsers.length === 0) {
    console.error('\nRefused: nobody would stay. Check the prefix. Nothing was changed.');
    process.exit(4);
  }

  if (!APPLY) {
    console.log('\nDry run. Nothing was changed. Pass --apply to remove the "go" lists.');
    process.exit(0);
  }

  // The rows in one transaction; Cognito after the commit, since it cannot roll back.
  await client.query('begin');
  for (const r of goRows) {
    for (const [ref, declared] of Object.entries(HANDLED_VEHICLE)) {
      const [table, column] = ref.split('.');
      // Only references the live schema actually has.
      if (!refs.some((x) => x.tbl === table && x.col === column)) continue;
      const vehicles = 'select id from vehicle where resident_id = $1';
      await client.query(
        how(ref, declared) === 'delete'
          ? `delete from ${table} where ${column} in (${vehicles})`
          : `update ${table} set ${column} = null where ${column} in (${vehicles})`,
        [r.id],
      );
    }
    for (const [ref, declared] of Object.entries(HANDLED)) {
      const [table, column] = ref.split('.');
      if (!refs.some((x) => x.tbl === table && x.col === column)) continue;
      await client.query(
        how(ref, declared) === 'delete'
          ? `delete from ${table} where ${column} = $1`
          : `update ${table} set ${column} = null where ${column} = $1`,
        [r.id],
      );
    }
    await client.query('delete from resident where id = $1', [r.id]);
  }
  await client.query('commit');
  console.log(`\nRemoved ${goRows.length} resident row(s) and what referenced them.`);

  let failed = 0;
  for (const u of goUsers) {
    try {
      await pool.cognito.send(
        new AdminDeleteUserCommand({ UserPoolId: u.poolId, Username: u.username }),
      );
    } catch (e) {
      console.log(`  could not remove ${u.email ?? u.username}: ${e.message}`);
      failed++;
    }
  }
  if (goUsers.length > 0) {
    console.log(`Removed ${goUsers.length - failed} of ${goUsers.length} Cognito account(s).`);
  }
} catch (e) {
  await client.query('rollback').catch(() => {});
  throw e;
} finally {
  await client.end();
}
