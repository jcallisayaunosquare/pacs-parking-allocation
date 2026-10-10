import { describe, expect, it } from 'vitest';
import { drawBlocker } from './draw-eligibility';

/**
 * Two allocations at once is two statements about who may park in the same bays. Dev
 * held the proof that nothing stopped it: 2026-Q4 and 2027-Q1 both ACTIVE, with bay
 * B1-08 assigned in each to a different resident.
 */
describe('drawBlocker', () => {
  it('allows a draw when no period is in effect', () => {
    expect(drawBlocker({ state: 'REGISTRATION_CLOSED', periodInEffect: null })).toBeNull();
  });

  it('refuses a draw while another period is in effect, and names it', () => {
    const blocker = drawBlocker({
      state: 'REGISTRATION_CLOSED',
      periodInEffect: { label: '2026-Q4' },
    });
    expect(blocker).toContain('2026-Q4');
    expect(blocker).toContain('in effect');
  });

  /*
   * The message has to say what to do, because the administrator's next move is not
   * obvious: the period in effect is not the one they are looking at.
   */
  it('tells the administrator to close the period in effect first', () => {
    const blocker = drawBlocker({
      state: 'REGISTRATION_CLOSED',
      periodInEffect: { label: '2027-Q1' },
    });
    expect(blocker).toContain('Close it first');
    expect(blocker).toContain('ends its assignments');
  });
});
