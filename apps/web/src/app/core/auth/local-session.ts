/**
 * The sign-in stub for working offline, paired with `apps/api/scripts/local-api.mjs`.
 *
 * It exists for one reason: the interface cannot be reviewed without a session, and the
 * only real issuer is a Cognito pool in an AWS account. Behind `environment.localAuth`
 * — true only in `environments/environment.ts`, which the production configuration
 * replaces — two accounts sign in with any password at all:
 *
 *   admin@local      the building administrator
 *   resident@local   a resident who holds a bay
 *
 * The token it mints is `local.<base64url json>` and carries no signature. That is not a
 * weakness hidden in the product: the stub API is the only thing that accepts it, it
 * runs on localhost, and the real API rejects it at the Cognito authorizer before any
 * handler sees it. The security boundary stays where it was — on the server.
 */

const KEY = 'pacs.localSession';

export interface LocalClaims {
  readonly sub: string;
  readonly email: string;
  readonly roles: readonly ('ADMIN' | 'RESIDENT')[];
  /** Which seeded register row to answer as; the stub falls back to its own default. */
  readonly residentId?: string;
}

const ACCOUNTS: readonly LocalClaims[] = [
  { sub: 'local-admin', email: 'admin@local', roles: ['ADMIN'] },
  { sub: 'local-resident', email: 'resident@local', roles: ['RESIDENT'] },
];

const encode = (claims: LocalClaims): string => {
  const json = JSON.stringify(claims);
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  // base64url, which is what the stub decodes with.
  return `local.${b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
};

/** Returns the minted token, or null when the email is not one of the two accounts. */
export function localSignIn(email: string): string | null {
  const account = ACCOUNTS.find((a) => a.email === email.trim().toLowerCase());
  if (!account) return null;
  const token = encode(account);
  try {
    localStorage.setItem(KEY, token);
  } catch {
    // A private window with storage blocked still signs in; it just forgets on reload.
  }
  return token;
}

export function localRestore(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function localSignOut(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

/** For the sign-in form, so the stub documents itself rather than needing a README. */
export const LOCAL_ACCOUNTS: readonly string[] = ACCOUNTS.map((a) => a.email);
