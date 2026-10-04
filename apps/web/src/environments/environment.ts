/**
 * Development configuration. Points at the deployed `dev` stack, so the app runs
 * against the real API and the real user pool without anything to stand up locally.
 *
 * These are all public values — an API URL, a user pool id and a public SPA client id.
 * The client has no secret by design (authorization code + PKCE, §10), so there is
 * nothing here that needs hiding.
 */
export const environment = {
  production: false,
  apiBaseUrl: 'https://frd8e8nkhl.execute-api.us-east-2.amazonaws.com',
  auth: {
    authority: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_NsdZ4M0mj',
    clientId: '2tu4q5vefr1g98u90u8dspmife',
    redirectUrl: 'http://localhost:4200/callback',
    postLogoutRedirectUri: 'http://localhost:4200',
    /** Cognito's hosted login, used for the logout redirect it does not advertise. */
    hostedUiDomain: 'https://pacs-dev-309887812390.auth.us-east-2.amazoncognito.com',
  },
  defaultLanguage: 'es',
  availableLanguages: ['es', 'en'],
} as const;
