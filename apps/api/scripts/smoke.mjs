/**
 * Post-deploy smoke test against the deployed API (§23).
 *
 * Exercises the real HTTP surface with a real Cognito token: authentication, RBAC,
 * validation, the cycle state machine, the run endpoint and its idempotency. Creates a
 * throwaway admin user in the dev pool, generates its password locally and never prints
 * it, and tidies up the user afterwards.
 *
 *   node scripts/smoke.mjs
 *
 * Env: AWS_PROFILE (default hotel), AWS_REGION (default us-east-2), STAGE (default dev).
 */
import { randomBytes, randomUUID } from 'node:crypto';
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
const STAGE = process.env.STAGE ?? 'dev';
const STACK = `pacs-api-${STAGE}`;
/** Must match the origin in serverless.yml's httpApi.cors.allowedOrigins. */
const ALLOWED_ORIGIN = 'http://localhost:4200';

const results = [];
const check = (label, pass, extra = '') => {
  results.push({ label, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
};

/**
 * What this run created, so it can be tidied up afterwards.
 *
 * Earlier versions left everything behind: five cycles with implausible labels, retired
 * bays and throwaway residents accumulated in the real admin screens, and because
 * `runnable()` picks the first cycle in REGISTRATION_CLOSED, the "ready to draw" banner
 * ended up pointing at a cycle invented by a test. A suite that dirties the system it
 * checks is worse than no suite.
 */
const madeHere = { cycleLabels: [], spotCodes: [], residentEmails: [] };

async function outputs() {
  const cfn = new CloudFormationClient({ region: REGION });
  const out = await cfn.send(new DescribeStacksCommand({ StackName: STACK }));
  const map = {};
  for (const o of out.Stacks?.[0]?.Outputs ?? []) map[o.OutputKey] = o.OutputValue;
  return map;
}

async function main() {
  const o = await outputs();
  const base = o.ApiBaseUrl;
  const userPoolId = o.UserPoolId;
  const clientId = o.UserPoolClientId;
  if (!base || !userPoolId || !clientId) throw new Error('Stack outputs are incomplete.');
  console.log(`API  ${base}\npool ${userPoolId}\n`);

  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const email = `pacs-smoke-${Date.now()}@example.test`;
  // Generated here, used in memory, never logged.
  const password = `Aa1!${randomBytes(18).toString('base64url')}`;

  let token;
  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
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
        UserPoolId: userPoolId,
        Username: email,
        Password: password,
        Permanent: true,
      }),
    );
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: email,
        GroupName: 'ADMIN',
      }),
    );
    const auth = await cognito.send(
      new AdminInitiateAuthCommand({
        UserPoolId: userPoolId,
        ClientId: clientId,
        AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: email, PASSWORD: password },
      }),
    );
    token = auth.AuthenticationResult?.AccessToken;
    check('mint a Cognito access token for an ADMIN user', Boolean(token));
    if (!token) return finish(cognito, userPoolId, email);
  } catch (e) {
    check('mint a Cognito access token for an ADMIN user', false, e.message);
    return finish(cognito, userPoolId, email);
  }

  const call = async (method, path, { body, headers = {}, raw = false } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, contentType: res.headers.get('content-type'), raw };
  };

  // ------------------------------------------------------------------- cors
  //
  // These exist because the suite missed a bug that made the whole app unusable in a
  // browser while every other check passed. The route was declared with method '*',
  // which creates an ANY route that also matches the CORS preflight; a preflight
  // carries no Authorization header by specification, so the Cognito authorizer
  // answered OPTIONS with 401 and the browser never sent the real request.
  //
  // Node's fetch does not preflight, so nothing here noticed. These checks preflight
  // explicitly.
  const preflight = async (path, method, headers) =>
    fetch(`${base}${path}`, {
      method: 'OPTIONS',
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': method,
        'access-control-request-headers': headers,
      },
    });

  const pfMe = await preflight('/me', 'GET', 'authorization');
  check(
    'a CORS preflight on an authenticated route is not rejected',
    pfMe.status >= 200 && pfMe.status < 300,
    `status=${pfMe.status}`,
  );
  check(
    'the preflight allows our origin',
    pfMe.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN,
    pfMe.headers.get('access-control-allow-origin') ?? '(no header)',
  );

  const pfRun = await preflight(
    '/cycles/00000000-0000-0000-0000-000000000000/runs',
    'POST',
    'authorization,content-type,idempotency-key',
  );
  const allowedHeaders = (pfRun.headers.get('access-control-allow-headers') ?? '').toLowerCase();
  check(
    'the preflight allows Idempotency-Key, which the run endpoint requires',
    allowedHeaders.includes('idempotency-key'),
    allowedHeaders || '(no header)',
  );

  const pfEvil = await fetch(`${base}/me`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example.test', 'access-control-request-method': 'GET' },
  });
  check(
    'a preflight from an unknown origin is not granted one',
    pfEvil.headers.get('access-control-allow-origin') === null,
    pfEvil.headers.get('access-control-allow-origin') ?? '(no header, as it should be)',
  );

  // ------------------------------------------------------------------- auth
  const anon = await fetch(`${base}/health`);
  check('GET /health is public', anon.status === 200);

  const noToken = await fetch(`${base}/me`);
  check('GET /me without a token is 401', noToken.status === 401);

  const badToken = await fetch(`${base}/residents`, {
    headers: { authorization: 'Bearer not-a-jwt' },
  });
  check('a malformed token is 401', badToken.status === 401);

  const me = await call('GET', '/me');
  check('GET /me returns the principal', me.status === 200 && me.json?.roles?.includes('ADMIN'),
    `roles=${JSON.stringify(me.json?.roles)}`);

  // -------------------------------------------------------------- residents
  const created = await call('POST', '/residents', {
    body: {
      email: `smoke-resident-${Date.now()}@example.test`,
      fullName: 'Smoke Resident',
      unitNumber: '999',
      needsAccessibleSpot: false,
    },
  });
  check('POST /residents creates a resident', created.status === 201 && Boolean(created.json?.id),
    `status=${created.status}`);
  const residentId = created.json?.id;
  if (created.json?.email) madeHere.residentEmails.push(created.json.email);

  const dupe = await call('POST', '/residents', {
    body: { email: created.json?.email, fullName: 'Dupe', unitNumber: '998' },
  });
  check('a duplicate email is rejected with 400', dupe.status === 400 &&
    dupe.json?.error === 'VALIDATION_FAILED');

  const badBody = await call('POST', '/residents', { body: { email: 'not-an-email' } });
  check('an invalid body is 400 with field details', badBody.status === 400 &&
    Array.isArray(badBody.json?.details));

  const list = await call('GET', '/residents?limit=5');
  check('GET /residents is a cursor page capped at the limit',
    list.status === 200 && Array.isArray(list.json?.items) && list.json.items.length <= 5);

  const overLimit = await call('GET', '/residents?limit=5000');
  check('a limit above the ceiling of 100 is 400', overLimit.status === 400);

  // ---------------------------------------------------- sorting and paging
  //
  // A cursor anchored on the wrong column is the classic way to get this wrong: the
  // first page looks right, and the second repeats rows or drops them. So the check
  // walks the whole register a page at a time and insists it saw every resident once,
  // in order.
  const walk = async (sort, dir) => {
    const seen = [];
    const keys = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ limit: '5', sort, dir });
      if (cursor) qs.set('cursor', cursor);
      const res = await call('GET', `/residents?${qs}`);
      if (res.status !== 200) return { error: `status ${res.status}` };
      for (const r of res.json.items) {
        seen.push(r.id);
        keys.push(sort === 'name' ? r.fullName : sort === 'unit' ? r.unitNumber : r.email);
      }
      cursor = res.json.nextCursor;
      if (!cursor) break;
    }
    return { seen, keys };
  };

  const byName = await walk('name', 'asc');
  check('paging a sorted list returns every resident', !byName.error && byName.seen.length > 5,
    byName.error ?? `${byName.seen.length} rows`);
  check('paging a sorted list never repeats a resident',
    new Set(byName.seen).size === byName.seen.length,
    `${byName.seen.length} rows, ${new Set(byName.seen).size} distinct`);
  check('the order holds across page boundaries',
    byName.keys.every((k, i) => i === 0 || byName.keys[i - 1].localeCompare(k) <= 0),
    byName.keys.slice(0, 3).join(' <= '));

  const desc = await walk('unit', 'desc');
  check('descending order holds across page boundaries too',
    !desc.error && desc.keys.every((k, i) => i === 0 || desc.keys[i - 1].localeCompare(k) >= 0),
    desc.error ?? desc.keys.slice(0, 3).join(' >= '));

  const badSort = await call('GET', '/residents?sort=full_name;drop');
  check('an unknown sort key is rejected rather than reaching a query',
    badSort.status === 400, `status=${badSort.status}`);

  const badUuid = await call('GET', '/residents/not-a-uuid');
  check('a malformed id is rejected before it reaches a query', badUuid.status === 400 &&
    badUuid.json?.details?.[0]?.field === 'id');

  if (residentId) {
    const noReason = await call('PATCH', `/residents/${residentId}/eligibility`, {
      body: { isEligible: false },
    });
    check('marking ineligible without a reason is 400 (FR-15)', noReason.status === 400);

    const withReason = await call('PATCH', `/residents/${residentId}/eligibility`, {
      body: { isEligible: false, reason: 'Unpaid dues' },
    });
    check('marking ineligible with a reason succeeds',
      withReason.status === 200 && withReason.json?.isEligible === false);
  }

  // ------------------------------------------------------------------ spots
  const spotCode = `SMK-${Math.floor(Math.random() * 9000 + 1000)}`;
  const spot = await call('POST', '/spots', { body: { spotCode, level: 'B9', type: 'EV' } });
  check('POST /spots creates a spot', spot.status === 201 && spot.json?.spotCode === spotCode);
  if (spot.status === 201) madeHere.spotCodes.push(spotCode);

  const badType = await call('POST', '/spots', {
    body: { spotCode: `${spotCode}X`, level: 'B9', type: 'HELICOPTER' },
  });
  check('an unknown spot type is 400', badType.status === 400);

  const spots = await call('GET', '/spots?activeOnly=true');
  check('GET /spots lists the inventory', spots.status === 200 && spots.json?.items?.length > 0,
    `${spots.json?.items?.length} spots`);

  // ----------------------------------------------------------------- cycles
  const q = Math.floor(Math.random() * 9000 + 1000);
  const cycle = await call('POST', '/cycles', {
    body: {
      label: `2${String(q).slice(0, 3)}-Q1`,
      startsOn: '2027-01-01',
      endsOn: '2027-03-31',
      registrationOpensAt: '2026-12-01T00:00:00Z',
      registrationClosesAt: '2026-12-25T00:00:00Z',
    },
  });
  check('POST /cycles creates a cycle in DRAFT',
    cycle.status === 201 && cycle.json?.state === 'DRAFT', `status=${cycle.status}`);
  const cycleId = cycle.json?.id;
  if (cycle.json?.label) madeHere.cycleLabels.push(cycle.json.label);

  const badDates = await call('POST', '/cycles', {
    body: {
      startsOn: '2027-03-31',
      endsOn: '2027-01-01',
      registrationOpensAt: '2026-12-01T00:00:00Z',
      registrationClosesAt: '2026-12-25T00:00:00Z',
    },
  });
  check('a cycle that ends before it starts is 400', badDates.status === 400);

  if (cycleId) {
    const runTooEarly = await call('POST', `/cycles/${cycleId}/runs`, {
      headers: { 'idempotency-key': randomUUID() },
    });
    check('a run from DRAFT is 422 INVALID_CYCLE_STATE',
      runTooEarly.status === 422 && runTooEarly.json?.error === 'INVALID_CYCLE_STATE',
      `status=${runTooEarly.status}`);

    const open = await call('POST', `/cycles/${cycleId}/open-registration`);
    check('DRAFT → REGISTRATION_OPEN', open.status === 200 && open.json?.state === 'REGISTRATION_OPEN');

    const reopen = await call('POST', `/cycles/${cycleId}/open-registration`);
    check('an illegal repeat transition is 422', reopen.status === 422);

    const close = await call('POST', `/cycles/${cycleId}/close-registration`);
    check('REGISTRATION_OPEN → REGISTRATION_CLOSED',
      close.status === 200 && close.json?.state === 'REGISTRATION_CLOSED');

    const noKey = await call('POST', `/cycles/${cycleId}/runs`);
    check('a run without Idempotency-Key is 400', noKey.status === 400 &&
      noKey.json?.details?.[0]?.field === 'Idempotency-Key');

    const key = randomUUID();
    const run = await call('POST', `/cycles/${cycleId}/runs`, {
      headers: { 'idempotency-key': key },
    });
    // Nobody registered for this brand-new cycle, so the §12 empty path is the
    // expected outcome — and it must not touch anyone's fairness score.
    check('a run with no entrants ends COMPLETED_EMPTY',
      run.status === 200 && run.json?.state === 'COMPLETED_EMPTY',
      `state=${run.json?.state}`);

    const replay = await call('POST', `/cycles/${cycleId}/runs`, {
      headers: { 'idempotency-key': key },
    });
    check('replaying the idempotency key returns the same run',
      replay.status === 200 && replay.json?.runId === run.json?.runId);

    if (run.json?.runId) {
      const detail = await call('GET', `/runs/${run.json.runId}`);
      check('GET /runs/{id} exposes the seed for audit',
        detail.status === 200 && typeof detail.json?.randomSeed === 'number');
    }

    const report = await call('GET', `/reports/quarterly/${cycleId}?format=csv`);
    check('the quarterly report serves CSV',
      report.status === 200 && (report.contentType ?? '').includes('text/csv'));
  }

  // --------------------------------------------------------------- metrics
  const metrics = await call('GET', '/metrics/fairness');
  check('GET /metrics/fairness returns the distribution',
    metrics.status === 200 && typeof metrics.json?.residents === 'number',
    `residents=${metrics.json?.residents}, avg=${metrics.json?.averageScore}`);

  const cached = await call('GET', '/metrics/fairness');
  check('the cached second read agrees with the first',
    cached.status === 200 && cached.json?.residents === metrics.json?.residents);

  // ----------------------------------------------------------- error shape
  const missing = await call('GET', `/runs/${randomUUID()}`);
  check('a 404 carries the standard error shape with a traceId',
    missing.status === 404 && missing.json?.error === 'NOT_FOUND' && Boolean(missing.json?.traceId));

  const notARoute = await call('GET', '/no/such/route');
  check('an unknown route is 404, not a stack trace', notARoute.status === 404);

  await finish(cognito, userPoolId, email);
}

/**
 * Removes what this run created. The API has no delete endpoints for cycles, bays or
 * residents — deliberately, since §11 puts ON DELETE RESTRICT on anything the audit
 * trail references — so cleanup reaches past the API, and retires rather than deletes
 * whatever a draw has already touched.
 *
 * Needs DATABASE_URL. Without it the run still passes, but says what it left behind
 * instead of leaving it to be discovered in the admin screens later.
 */

/**
 * Deletes the Cognito user a resident's provisioning creates, once it exists.
 *
 * integrations builds that user from the pacs-events stream a second or two after the
 * resident is created, so a cleanup that runs straight away deletes nothing and the
 * account turns up afterwards with no one left to remove it. This waits for it.
 */
async function deleteProvisionedUser(cognito, userPoolId, email, waitMs = 12_000) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }));
      return true;
    } catch (e) {
      // Not provisioned yet: wait and look again, until the budget runs out.
      if (e?.name !== 'UserNotFoundException' || Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function tidyUp(cognito, userPoolId) {
  const url = process.env.DATABASE_URL;
  const left = [
    ...madeHere.cycleLabels.map((l) => `cycle ${l}`),
    ...madeHere.spotCodes.map((c) => `bay ${c}`),
    ...madeHere.residentEmails.map((e) => `resident ${e}`),
  ];
  if (left.length === 0) return;

  if (!url) {
    console.log(`\nDATABASE_URL is not set, so these were left in place:\n  ${left.join('\n  ')}`);
    return;
  }

  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: url,
    ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    for (const label of madeHere.cycleLabels) {
      const { rows } = await client.query('select id from allocation_cycle where label = $1', [label]);
      const id = rows[0]?.id;
      if (!id) continue;
      await client.query('delete from allocation_history where cycle_id = $1', [id]);
      await client.query('delete from waitlist_entry where cycle_id = $1', [id]);
      await client.query('delete from spot_assignment where cycle_id = $1', [id]);
      await client.query('delete from allocation_run where cycle_id = $1', [id]);
      await client.query('delete from raffle_registration where cycle_id = $1', [id]);
      await client.query('delete from allocation_cycle where id = $1', [id]);
    }
    // Retire rather than delete: a bay or resident a draw has touched is referenced by
    // allocation_history, and the schema refuses to let that be rewritten.
    for (const code of madeHere.spotCodes) {
      await client.query(
        `update parking_spot set is_active = false, deactivated_at = now(),
                notes = 'Retired by the smoke suite'
          where spot_code = $1`,
        [code],
      );
      await client.query('delete from parking_spot where spot_code = $1 and id not in (select spot_id from spot_assignment where spot_id is not null union select spot_id from allocation_history where spot_id is not null)', [code]);
    }
    // The Cognito user too, waiting for the stream to produce it first.
    for (const mail of madeHere.residentEmails) {
      await deleteProvisionedUser(cognito, userPoolId, mail);
    }

    for (const mail of madeHere.residentEmails) {
      await client.query('update resident set deactivated_at = now() where email = $1', [mail]);
      await client.query('delete from fairness_state where resident_id in (select id from resident where email = $1) and resident_id not in (select resident_id from allocation_history)', [mail]);
      await client.query('delete from resident where email = $1 and id not in (select resident_id from allocation_history union select resident_id from spot_assignment)', [mail]);
    }
    console.log(`\ncleaned up ${left.length} item(s) created by this run`);
  } catch (e) {
    console.log(`\ncleanup failed (${e.message}); left behind:\n  ${left.join('\n  ')}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function finish(cognito, userPoolId, email) {
  await cognito
    .send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }))
    .catch(() => undefined);

  await tidyUp(cognito, userPoolId);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('failed:');
    for (const f of failed) console.log(`  - ${f.label}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
