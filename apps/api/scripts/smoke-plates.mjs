/**
 * Post-deploy smoke test for the plate recognition module (M-7), against real AWS.
 *
 * This is the one part of the system that no unit test can stand in for: the path runs
 * through four services and two Lambdas that never touch each other in process - API
 * Gateway hands out a presigned PUT, the camera writes to S3, the bucket notification
 * wakes `plateRecognizer` outside the VPC, that calls Rekognition and writes to a
 * DynamoDB table, and the stream on that table wakes `plateIngest` inside the VPC, which
 * is what finally matches the plate against the vehicle register and writes the access
 * event. Every link in that chain is IAM, a trigger or a network boundary, and all of
 * those are exactly the things that pass in a unit test and fail in an account.
 *
 *   node scripts/smoke-plates.mjs
 *
 * Env: AWS_PROFILE (default hotel), AWS_REGION (default us-east-2), STAGE (default dev).
 *
 * What it proves and what it does not: the images in scripts/fixtures are rendered plate
 * text, not photographs, so a pass here is a statement about the WIRING and about the
 * matching rules - not about whether a plate on a moving car gets read. Only real gate
 * photographs can say that. Point PLATE_IMAGE at one to try it:
 *
 *   PLATE_IMAGE=./gate-01.jpg PLATE_EXPECT=1234ABC node scripts/smoke-plates.mjs
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * How long to wait for a capture to come back as a read.
 *
 * Two cold starts, a Rekognition call and a DynamoDB stream poll. The stream is the slow
 * part: a batch window of a few seconds is normal, so a 20 s budget would report a
 * working pipeline as broken on the first run of the day.
 */
const SETTLE_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 3_000;

const results = [];
const check = (label, pass, extra = '') => {
  results.push({ label, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The canonical form, which must agree with domain/vehicle.ts and the gate log. */
const canonical = (raw) =>
  [
    ...String(raw ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^0-9a-zA-Z]/g, '')
      .toUpperCase(),
  ]
    .map((c) => (c === 'O' || c === 'Q' ? '0' : c === 'I' ? '1' : c))
    .join('');

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

  /*
   * One camera id per run, so the listing can be filtered down to this run's frames.
   * Without it the assertions would read whichever row happened to be newest, and a
   * second person running the suite at the same time would make both of them pass or
   * both fail for the wrong reason.
   */
  const cameraId = `smoke-gate-${Date.now().toString(36)}`;
  console.log(`API    ${base}\npool   ${userPoolId}\ncamera ${cameraId}\n`);

  const registeredPlate = process.env.PLATE_EXPECT ?? '1234ABC';
  const registeredImage = process.env.PLATE_IMAGE
    ? resolve(process.env.PLATE_IMAGE)
    : resolve(HERE, 'fixtures/plate-1234ABC.png');
  // The second frame carries a plate nobody registered, which is the other half of the
  // module: an unmatched read must still be recorded and must still produce a decision.
  const strangerImage = resolve(HERE, 'fixtures/plate-3456XYZ.png');
  const contentTypeOf = (p) => (/\.png$/i.test(p) ? 'image/png' : 'image/jpeg');

  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const email = `pacs-plates-${Date.now()}@example.test`;
  // Generated here, used in memory, never logged.
  const password = `Aa1!${randomBytes(18).toString('base64url')}`;
  let token;

  /*
   * The resident this run creates, so the account the application provisions for them
   * can be removed again.
   *
   * It is not this script that creates that user: POST /residents emits ResidentCreated,
   * and `integrations` builds the Cognito account from the stream a second or two later.
   * So the script was deleting its own operator account and leaving the provisioned one
   * behind on every run - nine of them had collected in the pool.
   */
  let provisionedResident = null;

  const finish = async () => {
    try {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }));
    } catch {
      /* the user may never have been created */
    }

    // Waits for the stream, because a delete that runs straight away finds nothing and
    // the account appears afterwards with no one left to remove it.
    if (provisionedResident) {
      const deadline = Date.now() + 12_000;
      for (;;) {
        try {
          await cognito.send(
            new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: provisionedResident }),
          );
          break;
        } catch (e) {
          if (e?.name !== 'UserNotFoundException' || Date.now() > deadline) {
            console.log(`\ncould not remove the provisioned user ${provisionedResident}`);
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length > 0) {
      console.log('failed:');
      for (const f of failed) console.log(`  - ${f.label}`);
      process.exitCode = 1;
    }
  };

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
  } catch (e) {
    check('mint a Cognito access token for an ADMIN user', false, e.message);
  }
  if (!token) return finish();

  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
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
    return { status: res.status, json, text };
  };

  // ------------------------------------------------- a resident with a registered car
  const residentEmail = `plates-resident-${Date.now()}@example.test`;
  const resident = await call('POST', '/residents', {
    email: residentEmail,
    fullName: 'Plates Smoke Resident',
    unitNumber: '901',
    needsAccessibleSpot: false,
  });
  // Recorded even if the assertion below fails: the resident may well have been created
  // and the account provisioned, and a failed run is no reason to leave it behind.
  if (resident.status === 201) provisionedResident = residentEmail;
  check(
    'POST /residents creates the resident who owns the car',
    resident.status === 201 && Boolean(resident.json?.id),
    `status=${resident.status}`,
  );
  const residentId = resident.json?.id;
  if (!residentId) return finish();

  const vehicle = await call('POST', `/residents/${residentId}/vehicles`, {
    plate: registeredPlate,
    make: 'Toyota',
    model: 'Corolla',
    year: 2019,
    colour: 'white',
  });
  check(
    'POST /residents/{id}/vehicles registers the plate',
    vehicle.status === 201 && Boolean(vehicle.json?.id),
    `status=${vehicle.status}`,
  );
  const vehicleId = vehicle.json?.id;
  check(
    'the register stores the canonical form, not what was typed',
    vehicle.json?.plate === canonical(registeredPlate),
    `plate=${vehicle.json?.plate} display=${vehicle.json?.plateDisplay}`,
  );

  const byPlate = await call('GET', `/vehicles/by-plate/${encodeURIComponent(registeredPlate)}`);
  check(
    'GET /vehicles/by-plate finds it - the lookup the gate performs',
    byPlate.status === 200 && byPlate.json?.id === vehicleId,
    `status=${byPlate.status}`,
  );

  /*
   * The same plate punctuated differently, and with the confusables a camera actually
   * produces: O for 0 and I for 1. The register must find it anyway, because this is the
   * single assumption the whole match step rests on.
   */
  const confusable = registeredPlate.replace(/0/g, 'O').replace(/1/g, 'I');
  const fuzzy = await call('GET', `/vehicles/by-plate/${encodeURIComponent(confusable)}`);
  check(
    'a confusable, punctuated spelling of the plate finds the same vehicle',
    fuzzy.status === 200 && fuzzy.json?.id === vehicleId,
    `asked for ${confusable}`,
  );

  // ---------------------------------------------------------------- capture and upload
  const upload = async (imagePath) => {
    const contentType = contentTypeOf(imagePath);
    const ticket = await call('POST', '/captures', {
      cameraId,
      capturedAt: new Date().toISOString(),
      contentType,
    });
    if (ticket.status !== 201 || !ticket.json?.uploadUrl) {
      return { ticket, put: null };
    }
    const bytes = readFileSync(imagePath);
    const put = await fetch(ticket.json.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: bytes,
    });
    return { ticket, put, bytes: bytes.length };
  };

  const first = await upload(registeredImage);
  check(
    'POST /captures hands out a presigned PUT',
    first.ticket.status === 201 && Boolean(first.ticket.json?.uploadUrl),
    `status=${first.ticket.status} key=${first.ticket.json?.objectKey}`,
  );
  check(
    'the key is derived by the server under the camera prefix',
    typeof first.ticket.json?.objectKey === 'string' &&
      first.ticket.json.objectKey.startsWith(`raw/${cameraId}/`),
    first.ticket.json?.objectKey,
  );
  check(
    'the camera can PUT the frame with that URL',
    first.put?.status === 200,
    `status=${first.put?.status} bytes=${first.bytes}`,
  );

  const second = await upload(strangerImage);
  check(
    'a second frame, of a car nobody registered, uploads too',
    second.ticket.status === 201 && second.put?.status === 200,
  );

  // ----------------------------------------------------------------------- the pipeline
  //
  // Nothing here is synchronous. Poll the gate log for this camera until both frames
  // have become reads, rather than sleeping a fixed amount and hoping.
  const started = Date.now();
  let rows = [];
  while (Date.now() - started < SETTLE_TIMEOUT_MS) {
    const log = await call('GET', `/plate-reads?cameraId=${cameraId}&limit=10`);
    rows = log.json?.items ?? [];
    /*
     * Both rows AND both decisions. The read and its access event are two writes, and a
     * poll that stopped at the first could read a row whose decision was still a
     * moment away - which failed here as "no decision was written" on a pipeline that had
     * written one by the time anybody looked. A DISCARDED frame never gets a decision, so
     * it counts as settled on its own.
     */
    const settled = rows.filter((r) => r.decision !== null || r.status === 'DISCARDED');
    if (rows.length >= 2 && settled.length >= 2) break;
    await sleep(POLL_INTERVAL_MS);
  }
  const waited = Math.round((Date.now() - started) / 1000);
  check(
    'both frames reach the gate log as plate reads',
    rows.length >= 2,
    `${rows.length} row(s) after ${waited}s`,
  );

  const read = rows.find((r) => r.captureId === first.ticket.json?.captureId);
  const stranger = rows.find((r) => r.captureId === second.ticket.json?.captureId);

  check('the registered car produced a read', Boolean(read));
  if (read) {
    check('Rekognition returned text for it', typeof read.rawText === 'string' && read.rawText !== '',
      `raw=${JSON.stringify(read.rawText)}`);
    check(
      'the read canonicalises to the registered plate',
      read.plate === canonical(registeredPlate),
      `plate=${read.plate} expected=${canonical(registeredPlate)}`,
    );
    check(
      'the engine is recorded on the row',
      typeof read.engine === 'string' && read.engine.startsWith('rekognition'),
      `engine=${read.engine} version=${read.engineVersion}`,
    );
    check(
      'the fused score is the confidence weighted by quality',
      typeof read.fused === 'number' && read.fused > 0 && read.fused <= 1,
      `confidence=${read.confidence} quality=${read.quality} fused=${read.fused}`,
    );
    /*
     * Identified, which is not the same as opened.
     *
     * A fused score under the auto-allow threshold is MATCHED-but-REVIEW by design, and
     * the fixtures sit close enough to that line that pinning this to MATCHED would make
     * the suite a test of the threshold rather than of the match. What must hold is that
     * the frame was attributed to the right car.
     */
    check(
      'it resolved to the vehicle in the register, by exact match',
      read.vehicleId === vehicleId && read.matchKind === 'EXACT' && read.matchDistance === 0,
      `status=${read.status} vehicleId=${read.vehicleId} matchKind=${read.matchKind}`,
    );
    check(
      'and the outcome is either an opened barrier or a review, never a denial',
      (read.status === 'MATCHED' && read.decision === 'ALLOW') ||
        (read.status === 'REVIEW' && read.decision === 'REVIEW'),
      `status=${read.status} decision=${read.decision} reason=${read.reason} fused=${read.fused}`,
    );
    check(
      'the log names the resident, which is what an administrator reads it for',
      read.residentId === residentId && typeof read.residentName === 'string',
      `resident=${read.residentName}`,
    );
    /*
     * The arrivals board reads these off the same row. A board that showed a plate and a
     * name without the car would leave the one question recognition cannot answer -
     * whether the car in the lane is the car on file - to a second request nobody makes
     * while a car is rolling towards a barrier.
     */
    check(
      'and the car on file travels with it, for the arrivals board',
      read.unitNumber === '901' &&
        read.vehicleMake === 'Toyota' &&
        read.vehicleModel === 'Corolla' &&
        read.vehicleYear === 2019 &&
        read.vehicleColour === 'white',
      `unit=${read.unitNumber} car=${read.vehicleColour} ${read.vehicleMake} ${read.vehicleModel} ${read.vehicleYear}`,
    );
    check('an access decision was written', read.decision !== null, `decision=${read.decision} (${read.reason})`);
  }

  check('the unregistered car produced a read too', Boolean(stranger));
  if (stranger) {
    check(
      'it is recorded as unmatched rather than dropped',
      stranger.status === 'UNMATCHED' || stranger.status === 'REVIEW',
      `status=${stranger.status} plate=${stranger.plate}`,
    );
    check(
      'it is not attributed to anybody',
      stranger.vehicleId === null && stranger.residentId === null,
    );
    check(
      'and it still produced a decision, so the gate log accounts for every frame',
      stranger.decision !== null,
      `decision=${stranger.decision} (${stranger.reason})`,
    );
  }

  // The detail view is the only route that mints image URLs; an administrator cannot
  // review a doubtful read without seeing the frame.
  if (read?.id) {
    const detail = await call('GET', `/plate-reads/${read.id}`);
    check(
      'GET /plate-reads/{id} mints a short-lived URL for the frame',
      detail.status === 200 && typeof detail.json?.imageUrl === 'string',
      `status=${detail.status}`,
    );
  }

  const events = await call('GET', `/access-events?cameraId=${cameraId}&limit=10`);
  check(
    'GET /access-events lists what came through the gate',
    events.status === 200 && (events.json?.items?.length ?? 0) >= 2,
    `status=${events.status} items=${events.json?.items?.length}`,
  );

  // --------------------------------------------------------------------------- tidy up
  //
  // The vehicle goes, because an active row holding this plate would block the next run
  // of the suite - uniqueness is partial on is_active exactly so that removal frees it.
  if (vehicleId) {
    const gone = await call('DELETE', `/residents/${residentId}/vehicles/${vehicleId}`);
    check('the vehicle can be removed again', gone.status === 200 || gone.status === 204,
      `status=${gone.status}`);
  }
  console.log(
    `\nLeft in place (no API removes them): resident ${residentId}, ` +
      `and this run's frames under raw/${cameraId}/.`,
  );

  await finish();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
