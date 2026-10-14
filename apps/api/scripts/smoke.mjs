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
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
/*
 * What this run created, by the two names each thing has: the label or code a person
 * reads, and the id the API needs to undo it. The ids are what make the teardown below
 * possible without a database.
 */
const madeHere = {
  cycleLabels: [],
  spotCodes: [],
  residentEmails: [],
  cycleIds: [],
  spotIds: [],
  residentIds: [],
  /** Set once a draw has been committed, which makes the period undeletable by design. */
  cycleHasRun: false,
};

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
  if (created.json?.id) madeHere.residentIds.push(created.json.id);

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

  /*
   * The walk only proves anything when the register spans more than one page. A
   * register trimmed down to a couple of accounts (keep-only-users.mjs does exactly
   * that) fits on the first page, the cursor is never used, and the check failed on the
   * data rather than on the paging. So the run tops the register up to two pages with
   * residents of its own, tracked like every other row it makes and removed below.
   */
  const PAGE = 5;
  const before = await walk('name', 'asc');
  const fillers = before.error ? 0 : Math.max(0, PAGE + 1 - before.seen.length);
  for (let i = 0; i < fillers; i++) {
    const filler = await call('POST', '/residents', {
      body: {
        email: `smoke-paging-${Date.now()}-${i}@example.test`,
        fullName: `Smoke Paging ${String.fromCharCode(65 + i)}`,
        unitNumber: String(990 - i),
        needsAccessibleSpot: false,
      },
    });
    if (filler.json?.email) madeHere.residentEmails.push(filler.json.email);
    if (filler.json?.id) madeHere.residentIds.push(filler.json.id);
  }
  if (fillers > 0) console.log(`(added ${fillers} temporary residents so the register spans two pages)`);

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
  if (spot.json?.id) madeHere.spotIds.push(spot.json.id);

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
  if (cycle.json?.id) madeHere.cycleIds.push(cycle.json.id);

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

    /*
     * Running the draw is gated on being able to undo it, and the gate is DATABASE_URL.
     *
     * A committed run is a record: cycleRemovalBlocker refuses to delete a period that
     * has one, deliberately, because a past draw has to stay explainable to the resident
     * who lost it. So a run here means the period can never be removed through the API,
     * and in the pipeline - which has no route to the database - it stays in the register
     * for good. One of them reached an administrator's screen as "2235-Q1, ready to draw".
     *
     * Where the suite can reach the database it still proves the whole thing and clears
     * it afterwards. Where it cannot, the write path is left to the 214 unit tests, and
     * the read paths below are pointed at a run that already exists instead - which costs
     * nothing and still exercises the deployed stack.
     */
    const canUndoARun = Boolean(process.env.DATABASE_URL);

    let runIdForAudit = null;
    let cycleIdForReport = null;

    /*
     * Which draw check runs depends on the environment, because only one of the two can
     * be true of it: either an allocation is in force or it is not.
     *
     * A draw is refused while another period is in effect (drawBlocker), and dev usually
     * has one - 2026-Q4 is in force until the end of the year. Asserting the success
     * path there would fail on a rule working correctly, and closing the period in effect
     * to get past it would expire the bays of real residents to satisfy a test. So the
     * suite asserts whichever is true: the refusal, naming the period in the way, or the
     * run itself when nothing is in the way.
     */
    const cycles = await call('GET', '/cycles');
    const inEffect = (cycles.json?.items ?? []).find(
      (c) => c.state === 'ACTIVE' && c.id !== cycleId,
    );

    if (canUndoARun && inEffect) {
      const refused = await call('POST', `/cycles/${cycleId}/runs`, {
        headers: { 'idempotency-key': randomUUID() },
      });
      check('a draw is refused while another period is in effect',
        refused.status === 422 && refused.json?.error === 'INVALID_CYCLE_STATE',
        `status=${refused.status}`);
      check('and the refusal names the period that is in the way',
        typeof refused.json?.message === 'string' && refused.json.message.includes(inEffect.label),
        `message=${refused.json?.message}`);
      // No run was committed, so the period is still deletable and the teardown will
      // remove it. The success path is covered by the unit tests, which do not need a
      // building to be between periods to be true.
      console.log(`\n${inEffect.label} is in effect, so the draw was asserted as refused`);
      // The audit and report checks still have something real to read: the draw that put
      // that period in effect.
      const existing = await call('GET', '/runs?limit=1');
      runIdForAudit = existing.json?.items?.[0]?.runId ?? null;
      cycleIdForReport = existing.json?.items?.[0]?.cycleId ?? null;
    } else if (canUndoARun) {
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

      runIdForAudit = run.json?.runId ?? null;
      cycleIdForReport = cycleId;
      /*
       * Only when a run was actually committed. Setting this on the attempt was wrong: a
       * refused draw left the teardown believing the period held a record, so it skipped
       * the delete and the period stayed in the register - the exact thing all of this
       * was for.
       */
      if (run.status === 200 && run.json?.runId) madeHere.cycleHasRun = true;
    } else {
      console.log('\nDATABASE_URL is not set, so no draw is run: a committed run cannot be');
      console.log('removed afterwards. The audit and report checks read an existing run.');
      const runs = await call('GET', '/runs?limit=1');
      check('GET /runs lists the draws already on record',
        runs.status === 200 && Array.isArray(runs.json?.items),
        `status=${runs.status}`);
      const existing = runs.json?.items?.[0];
      runIdForAudit = existing?.runId ?? null;
      cycleIdForReport = existing?.cycleId ?? null;
      if (!runIdForAudit) {
        console.log('no run exists yet, so the audit and report checks are skipped');
      }
    }

    if (runIdForAudit) {
      const detail = await call('GET', `/runs/${runIdForAudit}`);
      /*
       * The seed is a hex string, not a number. And checking only that some seed came
       * back would pass on a run that committed to one seed and then drew with another,
       * which is the single thing the commitment exists to rule out - so the commitment
       * published before the candidate list was read has to hash back to it.
       */
      const seedHex = detail.json?.randomSeedHex;
      check('GET /runs/{id} exposes the seed for audit',
        detail.status === 200 && typeof seedHex === 'string' && /^[0-9a-f]{2,}$/.test(seedHex));
      check('the published commitment hashes back to that seed',
        typeof seedHex === 'string' &&
          createHash('sha256').update(seedHex).digest('hex') === detail.json?.seedCommitmentHex);
    }

    if (cycleIdForReport) {
      const report = await call('GET', `/reports/quarterly/${cycleIdForReport}?format=csv`);
      check('the quarterly report serves CSV',
        report.status === 200 && (report.contentType ?? '').includes('text/csv'));
    }
  }

  // --------------------------------------------------------------- metrics
  const metrics = await call('GET', '/metrics/fairness');
  check('GET /metrics/fairness returns the distribution',
    metrics.status === 200 && typeof metrics.json?.residents === 'number',
    `residents=${metrics.json?.residents}, avgWaitHours=${metrics.json?.averageWaitHours}`);

  const cached = await call('GET', '/metrics/fairness');
  check('the cached second read agrees with the first',
    cached.status === 200 && cached.json?.residents === metrics.json?.residents);

  // ----------------------------------------------------------- error shape
  const missing = await call('GET', `/runs/${randomUUID()}`);
  check('a 404 carries the standard error shape with a traceId',
    missing.status === 404 && missing.json?.error === 'NOT_FOUND' && Boolean(missing.json?.traceId));

  const notARoute = await call('GET', '/no/such/route');
  check('an unknown route is 404, not a stack trace', notARoute.status === 404);

  /*
   * Teardown through the API, with the administrator's token and nothing else.
   *
   * This runs everywhere, the pipeline included, because it needs no database and no
   * network route into the VPC. It is not a complete undo and does not pretend to be:
   * the period is deleted, while DELETE /residents deactivates rather than deletes and
   * there is no DELETE for a bay at all, so those two are taken out of the screens and
   * their rows remain. What matters is that nothing the suite made is visible to an
   * administrator afterwards. clean-smoke-data.mjs removes the rows from a machine the
   * database admits.
   */
  for (const id of madeHere.cycleIds) {
    if (madeHere.cycleHasRun) {
      console.log(`\nperiod ${id} holds a committed draw, so it is kept - as the rule intends`);
      continue;
    }
    const gone = await call('DELETE', `/cycles/${id}`);
    check('DELETE /cycles/{id} removes a period that never drew', gone.status === 204 || gone.status === 200,
      `status=${gone.status}`);
    if (gone.status === 204 || gone.status === 200) {
      madeHere.cycleIds = madeHere.cycleIds.filter((x) => x !== id);
      madeHere.cycleLabels = [];
    }
  }

  for (const id of madeHere.residentIds) {
    const gone = await call('DELETE', `/residents/${id}`);
    check('DELETE /residents/{id} takes the resident out of the register',
      gone.status === 204 || gone.status === 200, `status=${gone.status}`);
  }

  /*
   * Deleted, not retired. Retiring was what this used to do, and it was not enough: the
   * inventory screen lists inactive bays by default, so every run added a row an
   * administrator could see. These bays were never assigned - no draw ran on the period
   * they were made for - so the removal rule allows it.
   *
   * The codes and the ids are pushed together, so the index is what pairs them: a bay
   * that is gone must not be named in the list of rows left behind.
   */
  const spotsStillThere = [];
  for (const [i, id] of madeHere.spotIds.entries()) {
    const gone = await call('DELETE', `/spots/${id}`);
    check('DELETE /spots/{id} removes a bay that was never assigned',
      gone.status === 204 || gone.status === 200, `status=${gone.status}`);
    if (!(gone.status === 204 || gone.status === 200)) spotsStillThere.push(madeHere.spotCodes[i]);
  }
  madeHere.spotCodes = spotsStillThere;

  await finish(cognito, userPoolId, email);
}

/**
 * Removes the rows the API teardown in main() cannot: a deactivated resident, a retired
 * bay, and a period that a draw has committed to.
 *
 * It reaches past the API because §11 puts ON DELETE RESTRICT on anything the audit trail
 * references, and the application's own role is denied DELETE on allocation_history on
 * purpose. This connects as the owner instead, which is why it is a script run by a
 * person rather than a step in the pipeline.
 *
 * Needs DATABASE_URL. Without it the run still passes - main() has already taken
 * everything out of the administrator's screens - and this says which rows are left.
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
      return 'removed';
    } catch (e) {
      if (e?.name !== 'UserNotFoundException') return 'failed';
      /*
       * No account by that address. Two different situations, and the difference matters
       * to whoever reads the output:
       *
       * Within the window it means the stream has not got there yet, so wait and look
       * again. After it, the likeliest explanation is that no account was ever made -
       * main() deactivates the resident before this runs, and integrations declines to
       * provision an account for a resident who is already gone. Reporting that as a
       * failure sends someone looking for an orphan that does not exist.
       *
       * It is not a certainty, which is why clean-smoke-data.mjs sweeps the pool by
       * pattern as well: an account provisioned after this gives up would otherwise have
       * nobody left to remove it.
       */
      if (Date.now() > deadline) return 'absent';
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function tidyUp(cognito, userPoolId) {
  const url = process.env.DATABASE_URL;
  /*
   * What main() could not take away through the API, and so may still be a row.
   *
   * The residents are not in this list any more. DELETE /residents deletes the row when
   * nothing in the record names the resident, and hides it when something does - and a
   * resident the suite just made has never registered and never held a bay, so the row
   * is gone. Naming them here as "left in place" was telling the reader to go and clear
   * something that is not there.
   *
   * The cycles and bays are listed only when their own DELETE was refused, which the
   * teardown in main() checks; a successful one takes them off these lists.
   */
  const left = [
    ...madeHere.cycleLabels.map((l) => `cycle ${l}`),
    ...madeHere.spotCodes.map((c) => `bay ${c}`),
  ];
  if (left.length === 0 && madeHere.residentEmails.length === 0) return;

  /*
   * The Cognito users go first, and unconditionally.
   *
   * Deleting them needs an IAM permission and nothing else - no database, no network
   * route into the VPC - so it works in exactly the place the rest of this cleanup
   * cannot: CodeBuild, whose addresses the database's security group does not admit.
   * It used to sit after the SQL, behind the `return` below, so every pipeline run left
   * its users in the pool: nineteen of them had piled up by the time anyone looked.
   */
  const outcome = { removed: 0, absent: 0, failed: [] };
  for (const mail of madeHere.residentEmails) {
    const r = await deleteProvisionedUser(cognito, userPoolId, mail);
    if (r === 'removed') outcome.removed++;
    else if (r === 'absent') outcome.absent++;
    else outcome.failed.push(mail);
  }
  if (outcome.removed > 0) console.log(`\nremoved ${outcome.removed} Cognito account(s)`);
  if (outcome.absent > 0) {
    console.log(`${outcome.absent} resident(s) had no account to remove`);
  }
  if (outcome.failed.length > 0) {
    console.log(`could not remove ${outcome.failed.length}: ${outcome.failed.join(', ')}`);
  }

  if (!url) {
    if (left.length > 0) {
      console.log(`\nDATABASE_URL is not set, so these rows were left in place:\n  ${left.join('\n  ')}`);
    } else {
      console.log('\nnothing left behind: everything this run created was removed through the API');
    }
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
    // The Cognito users are already gone - removed above, before this function could
    // return early for want of a DATABASE_URL.

    for (const mail of madeHere.residentEmails) {
      await client.query('update resident set deactivated_at = now() where email = $1', [mail]);
      // There is no fairness_state table to clear: migration waiting-time-fairness drops
      // it in `up` and recreates it only in `down`, because fairness is now derived from
      // allocation_history rather than stored. The query that used to be here threw
      // 42P01, the catch below reported "cleanup failed", and everything after it in this
      // loop was skipped - so the rows this was meant to tidy survived anyway.
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
