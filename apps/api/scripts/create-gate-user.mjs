/**
 * Provision one gate account in the dev user pool: a CAMERA user for one lane.
 *
 *   GATE_PASSWORD='<chosen here, not by this script>' node scripts/create-gate-user.mjs gate-main
 *
 * Env: AWS_PROFILE (default hotel), AWS_REGION (default us-east-2), STAGE (default dev),
 *      GATE_PASSWORD (required).
 *
 * Why CAMERA is its own account rather than a shared administrator's: the only route the
 * server serves this role is `POST /captures`, so a device bolted to a wall in a car park
 * holds a credential that can do exactly one thing - hand over a frame. If it is stolen,
 * nothing in the register, the draw or the gate log is reachable with it, and rotating it
 * is one command that touches no resident.
 *
 * The password is taken from the environment and never generated, printed or logged here.
 * A gate credential is long-lived: it is typed into a device once and then lives there,
 * so whoever installs the camera should be the only party that ever sees it. A script
 * that invented it would have to print it to be useful, and then it would exist in a
 * terminal's scrollback and in whatever collected that output.
 */
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const STAGE = process.env.STAGE ?? 'dev';
const STACK = `pacs-api-${STAGE}`;

/** Must match CAMERA_ID_PATTERN in the capture use case, or the gate's frames are refused. */
const GATE_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

const gate = process.argv[2];
const password = process.env.GATE_PASSWORD;

if (!gate || !GATE_PATTERN.test(gate)) {
  console.error(
    'Usage: node scripts/create-gate-user.mjs <gate-id>\n' +
      '  <gate-id>: lower case letters, digits and hyphens, 3 to 64 characters, e.g. gate-main.\n' +
      '  It is the camera id the device sends, so name the lane rather than the hardware.',
  );
  process.exit(2);
}
if (!password) {
  console.error(
    'GATE_PASSWORD is not set. Choose the gate password yourself and pass it in the\n' +
      'environment - this script will not invent one, because a generated password has to\n' +
      'be printed to be usable and then it lives in your terminal history.',
  );
  process.exit(2);
}

const cfn = new CloudFormationClient({ region: REGION });
const out = await cfn.send(new DescribeStacksCommand({ StackName: STACK }));
const outputs = {};
for (const o of out.Stacks?.[0]?.Outputs ?? []) outputs[o.OutputKey] = o.OutputValue;
const userPoolId = outputs.UserPoolId;
if (!userPoolId) throw new Error(`${STACK} has no UserPoolId output.`);

/*
 * The username is an e-mail because the pool is configured with e-mail as the sign-in
 * attribute. `.invalid` is reserved by RFC 2606 precisely so an address that must never
 * receive mail cannot collide with a real one - and a gate has no inbox. Nothing is sent
 * to it either way: MessageAction SUPPRESS.
 */
const username = `${gate}@gate.pacs.invalid`;

const cognito = new CognitoIdentityProviderClient({ region: REGION });

try {
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: username,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: username },
        { Name: 'email_verified', Value: 'true' },
      ],
    }),
  );
  console.log(`created ${username}`);
} catch (e) {
  if (e instanceof UsernameExistsException) {
    // Rotating a gate's password is the same operation as creating it, minus this step.
    console.log(`${username} already exists — setting its password and group`);
  } else {
    throw e;
  }
}

await cognito.send(
  new AdminSetUserPasswordCommand({
    UserPoolId: userPoolId,
    Username: username,
    Password: password,
    // Permanent: a device cannot answer a NEW_PASSWORD_REQUIRED challenge, and a gate
    // that has to be re-enrolled by hand after a restart is a gate that stops working.
    Permanent: true,
  }),
);

await cognito.send(
  new AdminAddUserToGroupCommand({
    UserPoolId: userPoolId,
    Username: username,
    GroupName: 'CAMERA',
  }),
);

console.log(
  `\n${username} is in the CAMERA group.\n` +
    `Sign the device in with it and set the gate name to "${gate}" on the gate camera screen.\n` +
    'Its only permission is POST /captures: it cannot read the gate log, the register or anything else.',
);
