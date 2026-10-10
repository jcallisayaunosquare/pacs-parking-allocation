/**
 * Production configuration. The redirect URLs must match the CloudFront domain and be
 * registered on the Cognito app client, or the login round trip fails with
 * `redirect_mismatch` — the most common deployment mistake with PKCE.
 *
 * Replaced into the build by the `production` configuration in angular.json.
 */
export const environment = {
  production: true,
  /** Never on in a deployed build: the real issuer is the Cognito pool below. */
  localAuth: false,
  apiBaseUrl: 'https://frd8e8nkhl.execute-api.us-east-2.amazonaws.com',
  auth: {
    authority: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_NsdZ4M0mj',
    clientId: '2tu4q5vefr1g98u90u8dspmife',
    // The CloudFront domain from pipeline/dev/web-hosting.yml (its SiteUrl output).
    // These two strings must match the Cognito client's CallbackURLs and LogoutURLs
    // character for character, which is why both are generated from one value in
    // serverless.yml - custom.webOrigin.
    redirectUrl: 'https://d2gamvhpvfk16e.cloudfront.net/callback',
    postLogoutRedirectUri: 'https://d2gamvhpvfk16e.cloudfront.net',
    hostedUiDomain: 'https://pacs-dev-309887812390.auth.us-east-2.amazoncognito.com',
  },
  defaultLanguage: 'es',
  availableLanguages: ['es', 'en'],
} as const;
