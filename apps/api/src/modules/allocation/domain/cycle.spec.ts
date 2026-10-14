import { describe, expect, it } from 'vitest';
import { cycleRemovalBlocker, nextPeriodFor } from './cycle';

/**
 * The removal rule exists to protect rule D: allocation history is never reset, because
 * a past draw has to stay explainable to the resident who lost it. These cases are the
 * line between a period that is still a plan and one that has become a record.
 */
describe('cycleRemovalBlocker', () => {
  it('allows removing a draft that has done nothing', () => {
    expect(
      cycleRemovalBlocker({ state: 'DRAFT', hasRun: false, assignments: 0 }),
    ).toBeNull();
  });

  it('allows removing a period whose registration opened but never drew', () => {
    expect(
      cycleRemovalBlocker({ state: 'REGISTRATION_OPEN', hasRun: false, assignments: 0 }),
    ).toBeNull();
  });

  it('allows removing a period whose registration closed before any draw ran', () => {
    expect(
      cycleRemovalBlocker({ state: 'REGISTRATION_CLOSED', hasRun: false, assignments: 0 }),
    ).toBeNull();
  });

  it('refuses a period that has handed out bays, and says how many', () => {
    const blocker = cycleRemovalBlocker({
      state: 'ACTIVE',
      hasRun: true,
      assignments: 12,
    });
    expect(blocker).toContain('12 bays');
    expect(blocker).toContain('never reset');
  });

  it('counts one bay in the singular, because the message is read by a person', () => {
    expect(cycleRemovalBlocker({ state: 'ACTIVE', hasRun: true, assignments: 1 })).toContain(
      '1 bay.',
    );
  });

  it('refuses a period whose draw ran even when it assigned nothing', () => {
    // A run with no winners is still a committed run with a contestable record.
    const blocker = cycleRemovalBlocker({
      state: 'REGISTRATION_CLOSED',
      hasRun: true,
      assignments: 0,
    });
    expect(blocker).toContain('draw has already run');
  });

  it('refuses a period in effect or finished even with no rows to point at', () => {
    // Defence in depth: the state alone is enough, so a miscounted join cannot let a
    // live period be deleted.
    expect(
      cycleRemovalBlocker({ state: 'ACTIVE', hasRun: false, assignments: 0 }),
    ).toContain('in effect');
    expect(
      cycleRemovalBlocker({ state: 'CLOSED', hasRun: false, assignments: 0 }),
    ).toContain('in effect');
  });
});

describe('nextPeriodFor', () => {
  const closedA = { cycle: 'closed-a', registered: false };
  const closedB = { cycle: 'closed-b', registered: true };
  const upcoming = { cycle: 'upcoming', registered: false };

  it('shows the closed period an entrant is waiting on, ahead of the upcoming one', () => {
    expect(nextPeriodFor([closedA, closedB], upcoming)).toEqual({ cycle: 'closed-b', registered: true });
  });

  it('does not show a closed period to someone who did not enter it', () => {
    expect(nextPeriodFor([closedA], upcoming)).toEqual(upcoming);
    expect(nextPeriodFor([closedA], null)).toEqual({ cycle: null, registered: false });
  });

  it('falls back to the upcoming period when nothing is closed', () => {
    expect(nextPeriodFor([], { cycle: 'upcoming', registered: true })).toEqual({
      cycle: 'upcoming',
      registered: true,
    });
  });
});
