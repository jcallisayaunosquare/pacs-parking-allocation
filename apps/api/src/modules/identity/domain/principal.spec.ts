import { describe, expect, it } from 'vitest';
import { isAdmin, isResident, principalFromClaims } from './principal';

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
