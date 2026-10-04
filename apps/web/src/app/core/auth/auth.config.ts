import { LogLevel, type PassedInitialConfig } from 'angular-auth-oidc-client';
import { environment } from '../../../environments/environment';

/**
 * Cognito through standards-based OIDC: authorization code + PKCE, no client secret,
 * tokens kept in memory (§10, §18). No Amplify, so no vendor SDK reaches the domain.
 *
 * Discovery works out of the box here because the user pool has a hosted domain — its
 * `.well-known/openid-configuration` carries the authorization, token, revocation and
 * end-session endpoints. Without a domain Cognito omits them and they have to be
 * configured by hand.
 *
 * `silentRenew` with a refresh token rather than an iframe: Cognito does not support
 * prompt=none, and third-party cookie blocking has made iframe renewal unreliable.
 */
export const authConfig: PassedInitialConfig = {
  config: {
    authority: environment.auth.authority,
    redirectUrl: environment.auth.redirectUrl,
    postLogoutRedirectUri: environment.auth.postLogoutRedirectUri,
    clientId: environment.auth.clientId,
    scope: 'openid email profile',
    responseType: 'code',
    // Memory only. An access token in localStorage is an XSS payload (§18).
    silentRenew: true,
    useRefreshToken: true,
    renewTimeBeforeTokenExpiresInSeconds: 60,
    // Cognito access tokens last 15 minutes by design, so renewal is routine.
    ignoreNonceAfterRefresh: true,
    triggerAuthorizationResultEvent: true,
    autoUserInfo: false,
    logLevel: environment.production ? LogLevel.Error : LogLevel.Warn,
    // Only the API gets the bearer token — never a third-party origin.
    secureRoutes: [environment.apiBaseUrl],
  },
};

/**
 * Cognito's `end_session_endpoint` is not the RP-initiated logout of the spec: it wants
 * `client_id` and `logout_uri` instead of `id_token_hint` and
 * `post_logout_redirect_uri`. Built here so the odd shape stays in one place.
 */
export function cognitoLogoutUrl(): string {
  const params = new URLSearchParams({
    client_id: environment.auth.clientId,
    logout_uri: environment.auth.postLogoutRedirectUri,
  });
  return `${environment.auth.hostedUiDomain}/logout?${params.toString()}`;
}
