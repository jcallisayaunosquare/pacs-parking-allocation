/**
 * M-6 — who is calling, derived from the token and nothing else.
 *
 * API Gateway's native JWT authorizer has already verified the signature, issuer,
 * audience and expiry before the Lambda runs (§10), so this module only maps verified
 * claims onto a Principal. It never reads an id from the query string or body — that is
 * what makes cross-resident access structurally impossible rather than merely checked.
 */
export type Role = 'ADMIN' | 'RESIDENT';

export interface Principal {
  readonly subject: string;
  readonly email: string | null;
  readonly roles: readonly Role[];
  /** Set from the `custom:resident_id` claim. Admins may legitimately have none. */
  readonly residentId: string | null;
}

export const isAdmin = (p: Principal): boolean => p.roles.includes('ADMIN');

export const isResident = (p: Principal): boolean => p.roles.includes('RESIDENT');

type Claims = Record<string, unknown>;

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Cognito puts groups in `cognito:groups`, as an array or a space-delimited string. */
function parseGroups(claims: Claims): Role[] {
  const raw = claims['cognito:groups'] ?? claims['groups'];
  const list = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string'
      ? raw.replace(/^\[|\]$/g, '').split(/[\s,]+/)
      : [];

  const roles = list
    .map((g) => g.trim().toUpperCase())
    .filter((g): g is Role => g === 'ADMIN' || g === 'RESIDENT');

  // A verified token with no recognised group is still a resident; the resident-scoped
  // routes then gate on residentId, and the admin routes reject.
  return roles.length > 0 ? [...new Set(roles)] : ['RESIDENT'];
}

export function principalFromClaims(claims: Claims | undefined): Principal | null {
  if (!claims) return null;
  const subject = asString(claims.sub);
  if (!subject) return null;

  return {
    subject,
    email: asString(claims.email),
    roles: parseGroups(claims),
    residentId: asString(claims['custom:resident_id']),
  };
}
