import { describe, expect, it } from 'vitest';
import { terminationPolicy } from './termination-policy';

const VALID_FROM = new Date('2026-04-01T00:00:00Z');
const HOUR = 3_600_000;
const after = (hours: number): Date => new Date(VALID_FROM.getTime() + hours * HOUR);
const GRACE = 48;

const policy = (
  reason: Parameters<typeof terminationPolicy>[0]['reason'],
  hours: number,
  makeWhole = false,
) => terminationPolicy({ reason, at: after(hours), validFrom: VALID_FROM, declineGraceHours: GRACE, makeWhole });

describe('terminationPolicy', () => {
  it('U-17: an early release counts as served and resets waiting from the actual end', () => {
    const t = policy('RELEASED', 24);
    expect(t.countsAsServed).toBe(true);
    expect(t.benefitEndedAt.toISOString()).toBe(after(24).toISOString());
  });

  it('U-18: a decline inside the grace window leaves the anchor untouched', () => {
    const t = policy('DECLINED', GRACE - 1);
    expect(t.countsAsServed).toBe(false);
  });

  it('a decline after the grace window is an early release', () => {
    const t = policy('DECLINED', GRACE + 1);
    expect(t.countsAsServed).toBe(true);
  });

  it('U-19: a revocation for cause counts as served, so misconduct is not rewarded', () => {
    expect(policy('REVOKED', 10).countsAsServed).toBe(true);
  });

  it('U-20: a cancellation the admin marks make-whole does not cost the resident', () => {
    expect(policy('CANCELLED', 10, true).countsAsServed).toBe(false);
    // Without the explicit choice it is an ordinary termination: the distinction is a
    // deliberate, audited decision rather than an inference from a status.
    expect(policy('CANCELLED', 10, false).countsAsServed).toBe(true);
  });

  it('normal expiry counts as served', () => {
    const t = policy('EXPIRED', 24 * 90);
    expect(t.countsAsServed).toBe(true);
    expect(t.reason).toBe('EXPIRED');
  });

  it('a zero grace window makes every decline count', () => {
    const t = terminationPolicy({
      reason: 'DECLINED',
      at: VALID_FROM,
      validFrom: VALID_FROM,
      declineGraceHours: 0,
    });
    expect(t.countsAsServed).toBe(true);
  });
});
