import { describe, expect, it } from 'vitest';
import { hasResidentSurface, isAdmin, isResident, principalFromClaims } from './principal';

describe('principalFromClaims', () => {
  it('returns null without a subject', () => {
    expect(principalFromClaims(undefined)).toBeNull();
    expect(principalFromClaims({})).toBeNull();
    expect(principalFromClaims({ sub: '' })).toBeNull();
  });

  it('maps a resident token', () => {
    const p = principalFromClaims({
      sub: 'abc',
      email: 'a@b.com',
      'cognito:groups': ['RESIDENT'],
      'custom:resident_id': 'r1',
    })!;
    expect(p.subject).toBe('abc');
    expect(p.residentId).toBe('r1');
    expect(isResident(p)).toBe(true);
    expect(isAdmin(p)).toBe(false);
  });

  it('maps an admin token', () => {
    const p = principalFromClaims({ sub: 'abc', 'cognito:groups': ['ADMIN'] })!;
    expect(isAdmin(p)).toBe(true);
    expect(p.residentId).toBeNull();
  });

  it('accepts the space-delimited group form Cognito sometimes sends', () => {
    const p = principalFromClaims({ sub: 'abc', 'cognito:groups': '[ADMIN RESIDENT]' })!;
    expect(p.roles).toContain('ADMIN');
    expect(p.roles).toContain('RESIDENT');
  });

  it('defaults an unrecognised group to RESIDENT', () => {
    const p = principalFromClaims({ sub: 'abc', 'cognito:groups': ['SOMETHING_ELSE'] })!;
    expect(p.roles).toEqual(['RESIDENT']);
    expect(isAdmin(p)).toBe(false);
  });

  it('never takes the resident id from anywhere but the claim', () => {
    const p = principalFromClaims({ sub: 'abc', residentId: 'spoofed' })!;
    expect(p.residentId).toBeNull();
  });
});

describe('hasResidentSurface', () => {
  it('is true for a resident', () => {
    const p = principalFromClaims({ sub: 'abc', 'cognito:groups': ['RESIDENT'] })!;
    expect(hasResidentSurface(p)).toBe(true);
  });

  it('is false for an administrator', () => {
    const p = principalFromClaims({ sub: 'abc', 'cognito:groups': ['ADMIN'] })!;
    expect(hasResidentSurface(p)).toBe(false);
  });

  /*
   * The case the defect was actually about: one person in a small building who is both.
   * A route's `roles` list is an OR, so `['RESIDENT']` would have admitted them. The
   * admin role wins, and the resident surface is not theirs.
   */
  it('is false for an account that is both, because the admin role wins', () => {
    const p = principalFromClaims({ sub: 'abc', 'cognito:groups': ['ADMIN', 'RESIDENT'] })!;
    expect(isResident(p)).toBe(true);
    expect(hasResidentSurface(p)).toBe(false);
  });
});
