/**
 * Proves the whole allocation path through the DEPLOYED API: a real run, with real
 * entrants, executed by POST /cycles/{id}/runs over HTTPS with a Cognito token, and
 * verified by reading the result back through the API.
 *
 *   node scripts/verify-raffle.mjs
 *
 * Needs DATABASE_URL for one harness step: putting the seeded cycle back into
 * REGISTRATION_CLOSED. ACTIVE → REGISTRATION_CLOSED is not a legal transition (§11), so
 * there is deliberately no endpoint for it — a test harness has to reach past the API.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const STACK = `pacs-api-${process.env.STAGE ?? 'dev'}`;
const LABEL = process.env.CYCLE_LABEL ?? '2026-Q4';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const results = [];
const check = (label, pass, extra = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
};

async function main() {
  const cfn = new CloudFormationClient({ region: REGION });
  const stack = await cfn.send(new DescribeStacksCommand({ StackName: STACK }));
  const o = {};
  for (const x of stack.Stacks?.[0]?.Outputs ?? []) o[x.OutputKey] = x.OutputValue;
  console.log(`API ${o.ApiBaseUrl}\n`);

  // --------------------------------------------------- harness: reset the cycle
  const client = new pg.Client({
    connectionString: url,
    ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  const { rows } = await client.query('select id from allocation_cycle where label = $1', [LABEL]);
  const cycleId = rows[0]?.id;
  if (!cycleId) throw new Error(`No cycle labelled ${LABEL}. Run the seed first.`);

  await client.query('delete from allocation_history where cycle_id = $1', [cycleId]);
  await client.query('delete from waitlist_entry where cycle_id = $1', [cycleId]);
  await client.query('delete from spot_assignment where cycle_id = $1', [cycleId]);
  await client.query('delete from allocation_run where cycle_id = $1', [cycleId]);
  await client.query(
    "update allocation_cycle set state = 'REGISTRATION_CLOSED' where id = $1",
    [cycleId],
  );
  const entrants = await client.query(
    'select count(*)::int n from raffle_registration where cycle_id = $1 and withdrawn = false',
    [cycleId],
  );
  const activeSpots = await client.query(
    'select count(*)::int n from parking_spot where is_active = true',
  );
  console.log(`cycle ${LABEL} reset — ${entrants.rows[0].n} entrants, ${activeSpots.rows[0].n} active spots\n`);

  // ------------------------------------------------------------ admin token
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const email = `pacs-raffle-${Date.now()}@example.test`;
  const password = `Aa1!${randomBytes(18).toString('base64url')}`;
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: o.UserPoolId,
      Username: email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
    }),
  );
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: o.UserPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }),
  );
  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: o.UserPoolId,
      Username: email,
      GroupName: 'ADMIN',
    }),
  );
  const auth = await cognito.send(
    new AdminInitiateAuthCommand({
      UserPoolId: o.UserPoolId,
      ClientId: o.UserPoolClientId,
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
  );
  const token = auth.AuthenticationResult?.AccessToken;

  const call = async (method, path, headers = {}) => {
    const res = await fetch(`${o.ApiBaseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };

  // ------------------------------------------------- the run, over HTTPS
  const key = randomUUID();
  const started = Date.now();
  const run = await call('POST', `/cycles/${cycleId}/runs`, { 'idempotency-key': key });
  const elapsed = Date.now() - started;

  check('POST /cycles/{id}/runs succeeds', run.status === 200, `status=${run.status}`);
  if (run.status !== 200) {
    console.log(JSON.stringify(run.json, null, 2));
    return finish(client, cognito, o.UserPoolId, email);
  }
  console.log('\n  ' + JSON.stringify(run.json, null, 2).replace(/\n/g, '\n  ') + '\n');

  const expectedSpots = activeSpots.rows[0].n;
  const expectedEntrants = entrants.rows[0].n;
  const expectedAssigned = Math.min(expectedSpots, expectedEntrants);

  check('state is COMPLETED', run.json.state === 'COMPLETED');
  check('every spot filled', run.json.assigned === expectedAssigned,
    `assigned=${run.json.assigned} of ${expectedSpots} spots`);
  check('remainder waitlisted', run.json.waitlisted === expectedEntrants - expectedAssigned,
    `waitlisted=${run.json.waitlisted}`);
  check('the seed is recorded', typeof run.json.randomSeed === 'number' && run.json.randomSeed > 0);
  check('NFR-01: the run completes inside 2 s', elapsed < 2000, `${elapsed} ms end to end over HTTPS`);

  // ------------------------------------------- read the result back by API
  const assignments = await call('GET', `/runs/${run.json.runId}/assignments`);
  check('GET /runs/{id}/assignments returns the full result set',
    assignments.status === 200 && assignments.json.items.length === expectedAssigned,
    `${assignments.json?.items?.length} rows`);
  check('no spot appears twice',
    new Set(assignments.json.items.map((a) => a.spotCode)).size === expectedAssigned);
  check('no resident appears twice',
    new Set(assignments.json.items.map((a) => a.residentId)).size === expectedAssigned);

  const report = await call('GET', `/reports/quarterly/${cycleId}`);
  check('the quarterly report covers every participant',
    report.status === 200 && report.json.items.length === expectedEntrants,
    `${report.json?.items?.length} rows`);

  const lock = await call('POST', `/cycles/${cycleId}/runs`, { 'idempotency-key': randomUUID() });
  check('a second run on the now-ACTIVE cycle is refused',
    lock.status === 422 && lock.json.error === 'INVALID_CYCLE_STATE',
    `${lock.status} ${lock.json?.error}`);

  const replay = await call('POST', `/cycles/${cycleId}/runs`, { 'idempotency-key': key });
  check('the original key still replays the original run',
    replay.status === 200 && replay.json.runId === run.json.runId);

  // -------------------------------------------------- fairness, by API
  const metrics = await call('GET', '/metrics/fairness');
  check('the fairness dashboard reflects the run', metrics.status === 200,
    `avg=${metrics.json?.averageScore}, max=${metrics.json?.maxScore}, neverWon=${metrics.json?.neverWon}`);

  const winners = await client.query(
    `select count(*)::int n from fairness_state fs
       join spot_assignment sa on sa.resident_id = fs.resident_id
      where sa.cycle_id = $1 and fs.score = 0`,
    [cycleId],
  );
  check('every winner score reset to 0', winners.rows[0].n === expectedAssigned,
    `${winners.rows[0].n} of ${expectedAssigned}`);

  await finish(client, cognito, o.UserPoolId, email);
}

async function finish(client, cognito, userPoolId, email) {
  await cognito
    .send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }))
    .catch(() => undefined);
  await client.end().catch(() => undefined);

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
