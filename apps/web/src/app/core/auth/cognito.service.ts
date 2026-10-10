import { Injectable, signal } from '@angular/core';
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { environment } from '../../../environments/environment';
import { localRestore, localSignIn, localSignOut } from './local-session';

/**
 * Sign-in against Cognito from our own form, replacing the hosted page.
 *
 * The hosted UI is an AWS-branded screen in the middle of this product: the visitor
 * leaves, sees someone else's design, and comes back. Owning the form means owning every
 * state it can be in, which is the point - a wrong password, a first sign-in that must
 * set a new one, and an expired session are product moments, not someone else's.
 *
 * The flow is SRP (`USER_SRP_AUTH`), which proves knowledge of the password without ever
 * sending it, cyphered or otherwise. `USER_PASSWORD_AUTH` would be a dozen fewer lines
 * and does send it; it is not worth the trade and would need enabling on the app client.
 *
 * Tokens live where this library puts them, in localStorage, which is what the OIDC
 * client it replaces did too. That is the normal arrangement for a public SPA client with
 * no secret, and the server remains the boundary: a token in storage buys nothing the
 * API does not independently authorise.
 */

/** What the form has to render. Every one of these is a state a real sign-in reaches. */
export type AuthOutcome =
  | { kind: 'signed-in' }
  | { kind: 'new-password-required'; requiredAttributes: readonly string[] }
  | { kind: 'mfa-required'; destination: string | null }
  | { kind: 'failed'; message: string };

@Injectable({ providedIn: 'root' })
export class CognitoService {
  private readonly pool = new CognitoUserPool({
    UserPoolId: userPoolId(environment.auth.authority),
    ClientId: environment.auth.clientId,
  });

  /** Held between steps so a challenge can be answered on the same user object. */
  private pending: CognitoUser | null = null;

  private readonly _session = signal<CognitoUserSession | null>(null);
  readonly session = this._session.asReadonly();

  /**
   * The offline stub, when `environment.localAuth` is on. It is checked in the four
   * methods that touch the issuer rather than hidden behind a swapped provider, because
   * every other method here — the new-password challenge, MFA, the reset codes — is a
   * real Cognito flow that the stub has no business pretending to own.
   */
  private readonly localToken = signal<string | null>(null);

  async signIn(email: string, password: string): Promise<AuthOutcome> {
    if (environment.localAuth) {
      const token = localSignIn(email);
      if (!token) {
        return {
          kind: 'failed',
          message: 'Offline mode: sign in as admin@local or resident@local, any password.',
        };
      }
      this.localToken.set(token);
      return { kind: 'signed-in' };
    }

    const user = new CognitoUser({ Username: email, Pool: this.pool });
    // Explicit: the library still defaults to the older flow in some builds.
    user.setAuthenticationFlowType('USER_SRP_AUTH');
    this.pending = user;

    const details = new AuthenticationDetails({ Username: email, Password: password });

    return new Promise<AuthOutcome>((resolve) => {
      user.authenticateUser(details, {
        onSuccess: (session) => {
          this._session.set(session);
          this.pending = null;
          resolve({ kind: 'signed-in' });
        },
        onFailure: (err) => resolve({ kind: 'failed', message: readableError(err) }),
        newPasswordRequired: (attributes: Record<string, unknown>) => {
          // Cognito refuses these back; they are read-only on the challenge.
          delete attributes['email_verified'];
          delete attributes['phone_number_verified'];
          delete attributes['email'];
          resolve({
            kind: 'new-password-required',
            requiredAttributes: Object.keys(attributes),
          });
        },
        mfaRequired: (_name, challenge: { CODE_DELIVERY_DESTINATION?: string }) =>
          resolve({
            kind: 'mfa-required',
            destination: challenge?.CODE_DELIVERY_DESTINATION ?? null,
          }),
        totpRequired: () => resolve({ kind: 'mfa-required', destination: null }),
      });
    });
  }

  /** The first sign-in of an account the administration created. */
  async completeNewPassword(password: string): Promise<AuthOutcome> {
    const user = this.pending;
    if (!user) return { kind: 'failed', message: 'That sign-in attempt has expired. Start again.' };

    return new Promise<AuthOutcome>((resolve) => {
      user.completeNewPasswordChallenge(
        password,
        {},
        {
          onSuccess: (session) => {
            this._session.set(session);
            this.pending = null;
            resolve({ kind: 'signed-in' });
          },
          onFailure: (err) => resolve({ kind: 'failed', message: readableError(err) }),
        },
      );
    });
  }

  async submitMfaCode(code: string): Promise<AuthOutcome> {
    const user = this.pending;
    if (!user) return { kind: 'failed', message: 'That sign-in attempt has expired. Start again.' };

    return new Promise<AuthOutcome>((resolve) => {
      user.sendMFACode(code, {
        onSuccess: (session) => {
          this._session.set(session);
          this.pending = null;
          resolve({ kind: 'signed-in' });
        },
        onFailure: (err) => resolve({ kind: 'failed', message: readableError(err) }),
      });
    });
  }

  /** Step one of a reset: Cognito mails the code. */
  async requestPasswordReset(email: string): Promise<{ ok: boolean; message: string }> {
    const user = new CognitoUser({ Username: email, Pool: this.pool });
    this.pending = user;
    return new Promise((resolve) => {
      user.forgotPassword({
        onSuccess: () => resolve({ ok: true, message: 'Code sent.' }),
        onFailure: (err) => resolve({ ok: false, message: readableError(err) }),
        inputVerificationCode: () =>
          resolve({ ok: true, message: 'Check your email for the code.' }),
      });
    });
  }

  async confirmPasswordReset(
    email: string,
    code: string,
    password: string,
  ): Promise<{ ok: boolean; message: string }> {
    const user = this.pending ?? new CognitoUser({ Username: email, Pool: this.pool });
    return new Promise((resolve) => {
      user.confirmPassword(code, password, {
        onSuccess: () => resolve({ ok: true, message: 'Password changed. Sign in with it.' }),
        onFailure: (err) => resolve({ ok: false, message: readableError(err) }),
      });
    });
  }

  /**
   * Re-establishes the session on a reload, refreshing it when the access token has
   * expired but the refresh token has not. Resolves false rather than throwing: "not
   * signed in" is the ordinary case on a first visit, not an error.
   */
  async restore(): Promise<boolean> {
    if (environment.localAuth) {
      const token = localRestore();
      this.localToken.set(token);
      return token !== null;
    }

    const user = this.pool.getCurrentUser();
    if (!user) return false;

    return new Promise<boolean>((resolve) => {
      user.getSession((err: Error | null, session: CognitoUserSession | null) => {
        if (err || !session?.isValid()) {
          this._session.set(null);
          resolve(false);
          return;
        }
        this._session.set(session);
        resolve(true);
      });
    });
  }

  /**
   * The bearer token for the API. Refreshed on demand when it has expired, so a tab left
   * open overnight does not start returning 401s to a signed-in person.
   */
  async accessToken(): Promise<string | null> {
    if (environment.localAuth) return this.localToken() ?? localRestore();

    const session = this._session();
    if (session?.isValid()) return session.getAccessToken().getJwtToken();
    const restored = await this.restore();
    return restored ? (this._session()?.getAccessToken().getJwtToken() ?? null) : null;
  }

  signOut(): void {
    if (environment.localAuth) {
      localSignOut();
      this.localToken.set(null);
      return;
    }

    this.pool.getCurrentUser()?.signOut();
    this._session.set(null);
    this.pending = null;
  }
}

/** The pool id is the tail of the issuer URL the OIDC configuration already carries. */
function userPoolId(authority: string): string {
  return authority.split('/').filter(Boolean).pop() ?? '';
}

/**
 * Cognito's messages are written for a developer reading a log. These are written for a
 * person who is trying to get into the car park, and they name the recovery.
 */
function readableError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  const message = (err as { message?: string })?.message ?? 'Sign-in failed.';

  switch (code) {
    case 'NotAuthorizedException':
      return 'That email and password do not match. Check both and try again.';
    case 'UserNotFoundException':
      // Deliberately the same answer as a wrong password: confirming which emails exist
      // in the register is a disclosure the sign-in screen has no reason to make.
      return 'That email and password do not match. Check both and try again.';
    case 'PasswordResetRequiredException':
      return 'This account needs a new password. Use "Forgot password" below.';
    case 'UserNotConfirmedException':
      return 'This account has not been confirmed yet. Ask the building administration.';
    case 'TooManyRequestsException':
    case 'LimitExceededException':
      return 'Too many attempts. Wait a minute and try again.';
    case 'InvalidPasswordException':
      return 'That password does not meet the rules for this building.';
    case 'CodeMismatchException':
      return 'That code is not right. Check it, or ask for a new one.';
    case 'ExpiredCodeException':
      return 'That code has expired. Ask for a new one.';
    default:
      return message;
  }
}
