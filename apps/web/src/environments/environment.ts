/**
 * Development configuration: the deployed `dev` stack, the real user pool, real data.
 *
 * These are all public values - an API URL, a user pool id and a public SPA client id.
 * The client has no secret by design (authorization code + PKCE, §10), so there is
 * nothing here that needs hiding.
 *
 * The offline stub lives in `environment.offline.ts` and is reached with
 * `ng serve --configuration offline`. It used to be this file's default, and that was
 * wrong: a screen could look finished against a fake while the endpoint behind it did not
 * exist, and the gate camera cannot be exercised against a stub at all - the recognition
 * path is four AWS services long. The default is the real thing.
 */
export const environment = {
  production: false,
  /** Never true outside `environment.offline.ts`. See `core/auth/local-session.ts`. */
  localAuth: false,
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
