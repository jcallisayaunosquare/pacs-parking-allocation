import { describe, expect, it } from 'vitest';
import { terminationPolicy } from './termination-policy';

const VALID_FROM = new Date('2026-04-01T00:00:00Z');
const HOUR = 3_600_000;
const after = (hours: number): Date => new Date(VALID_FROM.getTime() + hours * HOUR);

const policy = (
  reason: Parameters<typeof terminationPolicy>[0]['reason'],
  hours: number,
  makeWhole = false,
) => terminationPolicy({ reason, at: after(hours), makeWhole });

describe('terminationPolicy', () => {
  it('U-17: an early release counts as served and resets waiting from the actual end', () => {
    const t = policy('RELEASED', 24);
    expect(t.countsAsServed).toBe(true);
    expect(t.benefitEndedAt.toISOString()).toBe(after(24).toISOString());
  });

  it('U-18: a decline counts as served however fast it is, with no grace window', () => {
    // The window used to make an immediate decline free. It cannot be: withdrawing a
    // registration before the draw costs a place in the history, and declining the bay
    // afterwards is the same decision taken later. A free decline would be the cheaper
    // way to do the identical thing.
    expect(policy('DECLINED', 0).countsAsServed).toBe(true);
    expect(policy('DECLINED', 1).countsAsServed).toBe(true);
    expect(policy('DECLINED', 47).countsAsServed).toBe(true);
    expect(policy('DECLINED', 100).countsAsServed).toBe(true);
  });

  it('a decline ends the benefit when it is made, not when the period would have ended', () => {
    expect(policy('DECLINED', 3).benefitEndedAt.toISOString()).toBe(after(3).toISOString());
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

  it('the system error is the only termination that does not count', () => {
    const reasons = ['EXPIRED', 'RELEASED', 'REVOKED', 'DECLINED'] as const;
    for (const reason of reasons) expect(policy(reason, 5).countsAsServed).toBe(true);
    expect(policy('CANCELLED', 5, true).countsAsServed).toBe(false);
  });
});
