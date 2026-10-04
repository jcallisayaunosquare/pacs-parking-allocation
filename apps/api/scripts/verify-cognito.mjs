/**
 * Proves the asynchronous Cognito provisioning path of §10 end to end.
 *
 *   POST /residents  (api, inside the VPC, no route to Cognito)
 *     → resident row + ResidentCreated outbox row, one transaction
 *     → eager push to the pacs-events table
 *     → DynamoDB stream
 *     → integrations (outside the VPC) → AdminCreateUser + group + link#<sub>
 *     → first authenticated request claims the link
 *
 *   node scripts/verify-cognito.mjs
 */
import { randomBytes } from 'node:crypto';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminListGroupsForUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const STAGE = process.env.STAGE ?? 'dev';

const results = [];
const check = (label, pass, extra = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(label, fn, { attempts = 20, everyMs = 1500 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    const v = await fn().catch(() => null);
    if (v) {
      console.log(`      ${label} after ${i} attempt(s), ~${i * everyMs}ms`);
      return v;
    }
    await sleep(everyMs);
  }
  return null;
}

async function main() {
  const cfn = new CloudFormationClient({ region: REGION });
  const stack = await cfn.send(new DescribeStacksCommand({ StackName: `pacs-api-${STAGE}` }));
  const o = {};
  for (const x of stack.Stacks?.[0]?.Outputs ?? []) o[x.OutputKey] = x.OutputValue;

  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const eventsTable = `pacs-events-${STAGE}`;

  // ------------------------------------------------------------ admin token
  const adminEmail = `pacs-prov-admin-${Date.now()}@example.test`;
  const adminPassword = `Aa1!${randomBytes(18).toString('base64url')}`;
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: o.UserPoolId,
      Username: adminEmail,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: adminEmail },
        { Name: 'email_verified', Value: 'true' },
      ],
    }),
  );
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: o.UserPoolId,
      Username: adminEmail,
      Password: adminPassword,
      Permanent: true,
    }),
  );
  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: o.UserPoolId,
      Username: adminEmail,
      GroupName: 'ADMIN',
    }),
  );
  const auth = await cognito.send(
    new AdminInitiateAuthCommand({
      UserPoolId: o.UserPoolId,
      ClientId: o.UserPoolClientId,
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: adminEmail, PASSWORD: adminPassword },
    }),
  );
  const adminToken = auth.AuthenticationResult?.AccessToken;

  const call = async (method, path, body) => {
    const res = await fetch(`${o.ApiBaseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${adminToken}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };

  // ------------------------------------------------- create a resident by API
  const residentEmail = `pacs-resident-${Date.now()}@example.test`;
  const created = await call('POST', '/residents', {
    email: residentEmail,
    fullName: 'Provisioning Probe',
    unitNumber: '1203',
  });
  check('POST /residents returns 201 without waiting on Cognito',
    created.status === 201, `status=${created.status}`);
  const residentId = created.json?.id;
  if (!residentId) return finish(cognito, o.UserPoolId, [adminEmail]);

  check('the response carries no subject yet (provisioning is async)',
    created.json.externalSubject === null,
    `externalSubject=${JSON.stringify(created.json.externalSubject)}`);

  // ----------------------------------------- integrations does its work
  const user = await poll('cognito user appeared', () =>
    cognito.send(new AdminGetUserCommand({ UserPoolId: o.UserPoolId, Username: residentEmail })),
  );
  check('integrations created the Cognito user from outside the VPC', Boolean(user));
  if (!user) return finish(cognito, o.UserPoolId, [adminEmail]);

  const attr = (n) => user.UserAttributes?.find((a) => a.Name === n)?.Value;
  const subject = attr('sub');

  check('custom:resident_id matches the resident row',
    attr('custom:resident_id') === residentId,
    `claim=${attr('custom:resident_id')}`);
  check('the email is pre-verified so the invitation can be sent',
    attr('email_verified') === 'true');

  const groups = await cognito.send(
    new AdminListGroupsForUserCommand({ UserPoolId: o.UserPoolId, Username: residentEmail }),
  );
  check('the user is in the RESIDENT group',
    (groups.Groups ?? []).some((g) => g.GroupName === 'RESIDENT'),
    (groups.Groups ?? []).map((g) => g.GroupName).join(', '));

  const link = await poll('subject link written', async () => {
    const out = await doc.send(
      new GetCommand({ TableName: eventsTable, Key: { pk: `link#${subject}` } }),
    );
    return out.Item ?? null;
  });
  check('integrations wrote link#<sub> back to the event table', Boolean(link),
    link ? `residentId=${link.residentId}` : '');
  check('the link points at the right resident', link?.residentId === residentId);

  // ------------------------------- the resident claims the link on first login
  const residentPassword = `Aa1!${randomBytes(18).toString('base64url')}`;
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: o.UserPoolId,
      Username: residentEmail,
      Password: residentPassword,
      Permanent: true,
    }),
  );
  const residentAuth = await cognito.send(
    new AdminInitiateAuthCommand({
      UserPoolId: o.UserPoolId,
      ClientId: o.UserPoolClientId,
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: residentEmail, PASSWORD: residentPassword },
    }),
  );
  const residentToken = residentAuth.AuthenticationResult?.AccessToken;
  check('the provisioned resident can authenticate', Boolean(residentToken));

  const meRes = await fetch(`${o.ApiBaseUrl}/me`, {
    headers: { authorization: `Bearer ${residentToken}` },
  });
  const me = await meRes.json();
  check('GET /me resolves the resident from the token on first request',
    meRes.status === 200 && me.resident?.id === residentId,
    `resident=${me.resident?.id ?? 'null'}`);
  check('the resident holds only the RESIDENT role',
    Array.isArray(me.roles) && me.roles.includes('RESIDENT') && !me.roles.includes('ADMIN'),
    JSON.stringify(me.roles));

  const dash = await fetch(`${o.ApiBaseUrl}/me/dashboard`, {
    headers: { authorization: `Bearer ${residentToken}` },
  });
  const dashJson = await dash.json();
  check('GET /me/dashboard works for the provisioned resident',
    dash.status === 200 && dashJson.fairness?.drawWeight === 1,
    `drawWeight=${dashJson.fairness?.drawWeight}, explanation="${dashJson.fairness?.explanation}"`);

  const forbidden = await fetch(`${o.ApiBaseUrl}/residents`, {
    headers: { authorization: `Bearer ${residentToken}` },
  });
  check('a resident token cannot reach an admin route', forbidden.status === 403,
    `status=${forbidden.status}`);

  const linkGone = await doc.send(
    new GetCommand({ TableName: eventsTable, Key: { pk: `link#${subject}` } }),
  );
  check('the link item is consumed once and deleted', !linkGone.Item);

  await finish(cognito, o.UserPoolId, [adminEmail, residentEmail]);
}

async function finish(cognito, userPoolId, usernames) {
  for (const u of usernames) {
    await cognito
      .send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: u }))
      .catch(() => undefined);
  }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
