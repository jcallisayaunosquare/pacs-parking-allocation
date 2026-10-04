/**
 * Applies the PACS branding to Cognito's managed login page.
 *
 * The login page is the one screen the app does not render itself — §10 chose managed
 * login so passwords never pass through our code — which is exactly why it has to be
 * branded, or the first impression of the product is a default AWS form.
 *
 *   node scripts/apply-login-branding.mjs
 *
 * Requires the domain to be on managed login version 2; version 1 is the old hosted UI
 * and ignores all of this.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CognitoIdentityProviderClient,
  CreateManagedLoginBrandingCommand,
  DescribeManagedLoginBrandingByClientCommand,
  UpdateManagedLoginBrandingCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const STACK = `pacs-api-${process.env.STAGE ?? 'dev'}`;
const HERE = dirname(fileURLToPath(import.meta.url));
const BRANDING = join(HERE, '..', 'branding');

const cognito = new CognitoIdentityProviderClient({ region: REGION });

async function outputs() {
  const cfn = new CloudFormationClient({ region: REGION });
  const res = await cfn.send(new DescribeStacksCommand({ StackName: STACK }));
  const map = {};
  for (const o of res.Stacks?.[0]?.Outputs ?? []) map[o.OutputKey] = o.OutputValue;
  return map;
}

function assets() {
  // Raw bytes, not base64. The SDK base64-encodes blob members itself, so handing it a
  // base64 string encodes it twice and the service sniffs the result as text/plain.
  //
  // Two files because Cognito enforces aspect ratios: a logo must be between 1:1 and
  // 4:1, and a favicon exactly 1:1. It also strips `role` and `aria-label` from the
  // root <svg>, so the accessible name comes from <title>.
  const logo = new Uint8Array(readFileSync(join(BRANDING, 'logo.svg')));
  const favicon = new Uint8Array(readFileSync(join(BRANDING, 'favicon.svg')));

  return [
    { Category: 'FORM_LOGO', ColorMode: 'LIGHT', Extension: 'SVG', Bytes: logo },
    { Category: 'FORM_LOGO', ColorMode: 'DARK', Extension: 'SVG', Bytes: logo },
    { Category: 'FAVICON_SVG', ColorMode: 'LIGHT', Extension: 'SVG', Bytes: favicon },
    { Category: 'FAVICON_SVG', ColorMode: 'DARK', Extension: 'SVG', Bytes: favicon },
  ];
}

async function main() {
  const o = await outputs();
  const userPoolId = o.UserPoolId;
  const clientId = o.UserPoolClientId;
  if (!userPoolId || !clientId) throw new Error('Stack outputs are incomplete.');

  const settings = JSON.parse(readFileSync(join(BRANDING, 'managed-login-settings.json'), 'utf8'));

  let brandingId;
  try {
    const existing = await cognito.send(
      new DescribeManagedLoginBrandingByClientCommand({
        UserPoolId: userPoolId,
        ClientId: clientId,
      }),
    );
    brandingId = existing.ManagedLoginBranding?.ManagedLoginBrandingId;
  } catch {
    brandingId = undefined;
  }

  if (brandingId) {
    await cognito.send(
      new UpdateManagedLoginBrandingCommand({
        UserPoolId: userPoolId,
        ManagedLoginBrandingId: brandingId,
        // Explicitly off: with it on, the settings below are ignored.
        UseCognitoProvidedValues: false,
        Settings: settings,
        Assets: assets(),
      }),
    );
    console.log(`updated branding ${brandingId}`);
  } else {
    const created = await cognito.send(
      new CreateManagedLoginBrandingCommand({
        UserPoolId: userPoolId,
        ClientId: clientId,
        UseCognitoProvidedValues: false,
        Settings: settings,
        Assets: assets(),
      }),
    );
    console.log(`created branding ${created.ManagedLoginBranding?.ManagedLoginBrandingId}`);
  }

  console.log(`\nSign-in page: ${o.CognitoHostedUi}/login?client_id=${clientId}` +
    `&response_type=code&scope=openid+email+profile&redirect_uri=http://localhost:4200/callback`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
