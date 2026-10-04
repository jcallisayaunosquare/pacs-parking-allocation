/**
 * Drives the real sign-in flow in a real browser and reports what breaks.
 *
 * This exists because the HTTP smoke suite cannot see this class of bug: Node's fetch
 * does not preflight, does not run JavaScript, and does not follow an OIDC redirect
 * chain. Every check passed while the app was unusable in a browser.
 *
 *   node scripts/diagnose-login.mjs
 *
 * Creates a throwaway resident, signs in as them, captures the console, the failed
 * requests and a screenshot at each step, then deletes the user again. The password is
 * generated here and never printed.
 *
 * Env: AWS_PROFILE, AWS_REGION, DATABASE_URL, APP_URL (default http://localhost:4200).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import pg from 'pg';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const STACK = `pacs-api-${process.env.STAGE ?? 'dev'}`;
const APP = process.env.APP_URL ?? 'http://localhost:4200';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'diagnose-out');

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const console_ = [];
const failures = [];

async function outputs() {
  const cfn = new CloudFormationClient({ region: REGION });
  const res = await cfn.send(new DescribeStacksCommand({ StackName: STACK }));
  const map = {};
  for (const o of res.Stacks?.[0]?.Outputs ?? []) map[o.OutputKey] = o.OutputValue;
  return map;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const o = await outputs();

  const email = `pw-probe-${Date.now()}@example.test`;
  const password = `Aa1!${randomBytes(18).toString('base64url')}`;

  // ------------------------------------------------- a resident to sign in as
  const created = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: o.UserPoolId,
      Username: email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: 'Playwright Probe' },
      ],
    }),
  );
  const sub = created.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;

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
      GroupName: 'RESIDENT',
    }),
  );

  const db = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();
  const { rows } = await db.query(
    `insert into resident (email, full_name, unit_number, external_subject)
     values ($1, 'Playwright Probe', '999', $2)
     on conflict (email) do update set external_subject = excluded.external_subject
     returning id`,
    [email, sub],
  );
  const residentId = rows[0].id;
  await db.query(
    'insert into fairness_state (resident_id) values ($1) on conflict (resident_id) do nothing',
    [residentId],
  );
  console.log(`probe resident ${residentId} linked to ${sub}\n`);

  // ----------------------------------------------------------------- browser
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  page.on('console', (m) => {
    console_.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => {
    console_.push(`[pageerror] ${e.message}`);
  });
  page.on('requestfailed', (r) => {
    failures.push(`${r.method()} ${r.url()} -> ${r.failure()?.errorText}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) failures.push(`${r.request().method()} ${r.url()} -> ${r.status()}`);
  });

  const shot = async (name) => {
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
    console.log(`  shot ${name}.png  url=${page.url()}`);
  };

  try {
    console.log('1. open the app');
    await page.goto(APP, { waitUntil: 'networkidle', timeout: 30_000 });
    await shot('1-landing');

    console.log('2. sign in');
    const signIn = page.getByRole('button', { name: /sign in/i });
    if (await signIn.count()) {
      await signIn.click();
      await page.waitForURL(/amazoncognito\.com/, { timeout: 30_000 });
    }
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await shot('2-cognito');

    console.log('3. fill credentials');
    // Managed login names its fields `username` and `password`.
    await page.locator('input[name="username"]').first().fill(email);
    await page.locator('input[name="password"]').first().fill(password);
    await page.locator('button[type="submit"]').first().click();

    console.log('4. wait for the app to take over');
    await page.waitForURL((u) => u.hostname === 'localhost', { timeout: 40_000 });
    await shot('4-after-redirect');

    // The symptom being chased: the callback bar never going away.
    console.log('5. watch the callback for 20s');
    for (let i = 1; i <= 4; i++) {
      await page.waitForTimeout(5000);
      console.log(`   t+${i * 5}s  url=${page.url()}`);
    }
    await shot('5-settled');

    const body = await page.locator('body').innerText().catch(() => '');
    writeFileSync(join(OUT, 'final-text.txt'), body, 'utf8');
    console.log(`\nfinal url : ${page.url()}`);
    console.log(`final text: ${body.slice(0, 300).replace(/\n+/g, ' | ')}`);
  } catch (e) {
    console.error(`\nFLOW FAILED: ${e instanceof Error ? e.message : String(e)}`);
    await shot('error').catch(() => undefined);
  } finally {
    writeFileSync(join(OUT, 'console.log'), console_.join('\n'), 'utf8');
    writeFileSync(join(OUT, 'failures.log'), failures.join('\n'), 'utf8');

    console.log(`\n--- console (${console_.length}) ---`);
    console_.slice(-40).forEach((l) => console.log('  ' + l));
    console.log(`\n--- failed or 4xx/5xx requests (${failures.length}) ---`);
    [...new Set(failures)].slice(0, 30).forEach((l) => console.log('  ' + l));

    await browser.close();

    // Tidy up: the probe must not become more litter in the real pool.
    await cognito
      .send(new AdminDeleteUserCommand({ UserPoolId: o.UserPoolId, Username: email }))
      .catch(() => undefined);
    await db.query('delete from fairness_state where resident_id = $1', [residentId]).catch(() => undefined);
    await db.query('delete from resident where id = $1', [residentId]).catch(() => undefined);
    await db.end().catch(() => undefined);
    console.log('\nprobe cleaned up');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
