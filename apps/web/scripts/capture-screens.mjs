/**
 * Signs in as a throwaway administrator and photographs every screen.
 *
 * Useful for reviewing the interface without clicking through it, and for seeing what a
 * change actually did — a screenshot catches what a passing test never will.
 *
 *   node scripts/capture-screens.mjs
 *
 * Also exercises the admin path that adds someone to the resident register, so the
 * pictures show real rows rather than an empty table. Everything it creates is removed
 * at the end.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
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
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'diagnose-out', 'screens');

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const problems = [];

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

  const email = `pw-admin-${Date.now()}@example.test`;
  const password = `Aa1!${randomBytes(18).toString('base64url')}`;

  const created = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: o.UserPoolId,
      Username: email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: 'Screenshot Admin' },
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
  for (const group of ['ADMIN', 'RESIDENT']) {
    await cognito.send(
      new AdminAddUserToGroupCommand({ UserPoolId: o.UserPoolId, Username: email, GroupName: group }),
    );
  }

  // A resident row as well, so the resident screens have something to show.
  const db = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();
  const { rows } = await db.query(
    `insert into resident (email, full_name, unit_number, external_subject)
     values ($1, 'Screenshot Admin', '000', $2)
     on conflict (email) do update set external_subject = excluded.external_subject
     returning id`,
    [email, sub],
  );
  const residentId = rows[0].id;
  await db.query(
    'insert into fairness_state (resident_id) values ($1) on conflict (resident_id) do nothing',
    [residentId],
  );

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[console] ${m.text().slice(0, 200)}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().includes('execute-api')) {
      problems.push(`${r.request().method()} ${new URL(r.url()).pathname} -> ${r.status()}`);
    }
  });

  const shot = async (name) => {
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
    console.log(`  ${name}.png`);
  };

  try {
    await page.goto(APP, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/amazoncognito\.com/);
    await page.locator('input[name="username"]').first().fill(email);
    await page.locator('input[name="password"]').first().fill(password);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL((u) => u.hostname === 'localhost', { timeout: 40_000 });
    await page.waitForTimeout(2500);

    console.log('capturing:');
    await shot('01-dashboard');

    await page.goto(`${APP}/history`, { waitUntil: 'networkidle' });
    await shot('02-history');

    await page.goto(`${APP}/admin/residents`, { waitUntil: 'networkidle' });
    await shot('03-residents');

    // The screen that answers "where does a resident get registered".
    await page.getByRole('button', { name: /add resident/i }).click();
    await page.waitForTimeout(600);
    await shot('04-add-resident-dialog');
    await page.keyboard.press('Escape');

    await page.goto(`${APP}/admin/spots`, { waitUntil: 'networkidle' });
    await shot('05-bays');

    await page.goto(`${APP}/admin/cycles`, { waitUntil: 'networkidle' });
    await shot('06-cycles');

    await page.goto(`${APP}/admin/metrics`, { waitUntil: 'networkidle' });
    await shot('07-fairness');

    // Narrow viewport: the resident screen has to work on a phone.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(APP, { waitUntil: 'networkidle' });
    await shot('08-dashboard-phone');
  } catch (e) {
    problems.push(`FLOW: ${e instanceof Error ? e.message : String(e)}`);
    await shot('error').catch(() => undefined);
  } finally {
    await browser.close();
    await cognito
      .send(new AdminDeleteUserCommand({ UserPoolId: o.UserPoolId, Username: email }))
      .catch(() => undefined);
    await db.query('delete from fairness_state where resident_id = $1', [residentId]).catch(() => undefined);
    await db.query('delete from resident where id = $1', [residentId]).catch(() => undefined);
    await db.end().catch(() => undefined);

    console.log(`\nproblems: ${problems.length}`);
    [...new Set(problems)].slice(0, 20).forEach((p) => console.log('  ' + p));
    console.log('cleaned up');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
