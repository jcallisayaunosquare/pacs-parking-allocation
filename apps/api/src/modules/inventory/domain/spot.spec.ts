import { describe, expect, it } from 'vitest';
import { spotRemovalBlocker } from './spot';

/**
 * The line between a bay that is still a plan and one that has become a record. It is
 * the same rule cycle.spec.ts states for a period, and it exists for the same reason:
 * rule D, allocation history is never reset, because a past draw has to stay
 * explainable to the resident who lost it.
 */
describe('spotRemovalBlocker', () => {
  it('allows removing a bay nobody has ever been given', () => {
    expect(spotRemovalBlocker({ assignments: 0, historyRows: 0 })).toBeNull();
  });

  it('refuses a bay that has been assigned, and says how many times', () => {
    const blocker = spotRemovalBlocker({ assignments: 3, historyRows: 3 });
    expect(blocker).toContain('3 times');
    expect(blocker).toContain('never reset');
  });

  it('counts one assignment in the singular, because the message is read by a person', () => {
    expect(spotRemovalBlocker({ assignments: 1, historyRows: 1 })).toContain('1 time.');
  });

  /*
   * The case that matters: history outlives the assignment. A bay whose assignments were
   * all released has no current rows in spot_assignment and is still named in
   * allocation_history, which is what the audit trail is for.
   */
  it('refuses a bay that only the history still names', () => {
    expect(spotRemovalBlocker({ assignments: 0, historyRows: 5 })).toContain(
      'appears in the allocation history',
    );
  });

  it('tells the caller what to do instead, in both refusals', () => {
    expect(spotRemovalBlocker({ assignments: 2, historyRows: 2 })).toContain('Retire it instead');
    expect(spotRemovalBlocker({ assignments: 0, historyRows: 2 })).toContain('Retire it instead');
  });
});
