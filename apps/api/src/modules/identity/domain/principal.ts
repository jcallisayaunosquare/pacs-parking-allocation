/**
 * M-6 — who is calling, derived from the token and nothing else.
 *
 * API Gateway's native JWT authorizer has already verified the signature, issuer,
 * audience and expiry before the Lambda runs (§10), so this module only maps verified
 * claims onto a Principal. It never reads an id from the query string or body — that is
 * what makes cross-resident access structurally impossible rather than merely checked.
 */
/**
 * `CAMERA` is a machine role, added with the plates module (M-7): one Cognito user per
 * gate, whose only permission is `POST /captures`. A dedicated user per gate rather than
 * an API key in a header, because a key cannot be revoked for one gate without a
 * redeploy, and a camera at a gate is exactly the credential most likely to be lifted.
 */
export type Role = 'ADMIN' | 'RESIDENT' | 'CAMERA';

export interface Principal {
  readonly subject: string;
  readonly email: string | null;
  readonly roles: readonly Role[];
  /** Set from the `custom:resident_id` claim. Admins may legitimately have none. */
  readonly residentId: string | null;
}

export const isAdmin = (p: Principal): boolean => p.roles.includes('ADMIN');

export const isResident = (p: Principal): boolean => p.roles.includes('RESIDENT');

/**
 * Whether this caller has a resident surface at all.
 *
 * PRODUCT.md: "An administrator never holds a bay and never enters the draw: separation
 * of duties, because they operate it." So in a small building where one person is both,
 * the ADMIN role wins and the resident half is not theirs to use — "my bay", "my
 * history" and "enter the draw" have no meaning for the account that runs the draw.
 *
 * Deliberately not expressible as a route's `roles` list: that list is an OR, and a
 * principal carrying both groups satisfies `['RESIDENT']`. Denying on a role needs its
 * own predicate.
 */
export const hasResidentSurface = (p: Principal): boolean =>
  !isAdmin(p) && !p.roles.includes('CAMERA');

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
    .filter((g): g is Role => g === 'ADMIN' || g === 'RESIDENT' || g === 'CAMERA');

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
