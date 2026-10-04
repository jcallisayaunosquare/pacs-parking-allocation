/**
 * Production configuration. The redirect URLs must match the CloudFront domain and be
 * registered on the Cognito app client, or the login round trip fails with
 * `redirect_mismatch` — the most common deployment mistake with PKCE.
 *
 * Replaced into the build by the `production` configuration in angular.json.
 */
export const environment = {
  production: true,
  apiBaseUrl: 'https://frd8e8nkhl.execute-api.us-east-2.amazonaws.com',
  auth: {
    authority: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_NsdZ4M0mj',
    clientId: '2tu4q5vefr1g98u90u8dspmife',
    // TODO replace with the CloudFront domain once the web bucket is deployed, and add
    // the same URLs to the Cognito client's CallbackURLs / LogoutURLs.
    redirectUrl: 'https://localhost/callback',
    postLogoutRedirectUri: 'https://localhost',
    hostedUiDomain: 'https://pacs-dev-309887812390.auth.us-east-2.amazoncognito.com',
  },
  defaultLanguage: 'es',
  availableLanguages: ['es', 'en'],
} as const;
