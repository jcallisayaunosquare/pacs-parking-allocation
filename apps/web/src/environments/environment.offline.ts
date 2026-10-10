/**
 * The offline configuration: the in-memory API and the sign-in stub.
 *
 *   pnpm --filter @pacs/api local      # the stub API on :4300
 *   pnpm --filter @pacs/web offline    # ng serve --configuration offline
 *
 * This exists for working on the interface with no network and no AWS bill, nothing more.
 * It is NOT the default any more: the system runs on the deployed stack, and a default
 * that pointed at a stub meant a screen could look finished while the endpoint behind it
 * did not exist. Reaching it now takes an explicit flag, which is the right amount of
 * friction for a fake.
 *
 * Accounts in the stub: `admin@local` (ADMIN) and `resident@local` (RESIDENT); any
 * password is accepted, because nothing here authenticates anything.
 */
export const environment = {
  production: false,
  localAuth: true,
  apiBaseUrl: 'http://localhost:4300',
  auth: {
    // Present so the shape matches; the stub never reaches Cognito.
    authority: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_NsdZ4M0mj',
    clientId: '2tu4q5vefr1g98u90u8dspmife',
    redirectUrl: 'http://localhost:4200/callback',
    postLogoutRedirectUri: 'http://localhost:4200',
    hostedUiDomain: 'https://pacs-dev-309887812390.auth.us-east-2.amazoncognito.com',
  },
  defaultLanguage: 'es',
  availableLanguages: ['es', 'en'],
} as const;
