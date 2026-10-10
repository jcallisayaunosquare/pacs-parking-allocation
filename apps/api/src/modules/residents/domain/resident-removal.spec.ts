import { describe, expect, it } from 'vitest';
import { residentRemovalBlocker } from './resident-removal';

const none = {
  registrations: 0,
  assignments: 0,
  historyRows: 0,
  changedConfig: 0,
  reviewedPlateReads: 0,
};

/**
 * The line between a resident the register can forget and one the record names. It is
 * the third place this rule appears - cycle.spec.ts and spot.spec.ts draw the same line
 * for a period and for a bay - and it protects the same thing: rule D, allocation
 * history is never reset.
 */
describe('residentRemovalBlocker', () => {
  it('allows deleting a resident who did nothing at all', () => {
    expect(residentRemovalBlocker(none)).toBeNull();
  });

  it('refuses a resident the allocation history names', () => {
    expect(residentRemovalBlocker({ ...none, historyRows: 1 })).toContain('never reset');
  });

  it('refuses a resident who has held a bay', () => {
    expect(residentRemovalBlocker({ ...none, assignments: 1 })).toContain('given a bay');
  });

  /*
   * Entering a draw and losing it leaves a registration and no assignment. The record of
   * who was in the draw is what makes the result contestable, so it counts.
   */
  it('refuses a resident who entered a draw and won nothing', () => {
    expect(residentRemovalBlocker({ ...none, registrations: 1 })).toContain('entered a draw');
  });

  /*
   * Not about the draw: allocation_config.changed_by has no ON DELETE clause, so the
   * database refuses the delete and the caller would get a foreign key violation instead
   * of a sentence. It is also true that whoever changed the rules is part of the record.
   */
  it('refuses a resident who changed the allocation rules', () => {
    expect(residentRemovalBlocker({ ...none, changedConfig: 1 })).toContain('allocation rules');
  });

  it('refuses a resident who reviewed a plate read', () => {
    expect(residentRemovalBlocker({ ...none, reviewedPlateReads: 1 })).toContain(
      'reviewed a plate read',
    );
  });

  it('reports the allocation history first when several reasons apply', () => {
    // The strongest reason, so the message does not tell someone to undo a registration
    // when the history would refuse anyway.
    const blocker = residentRemovalBlocker({
      registrations: 4,
      assignments: 2,
      historyRows: 6,
      changedConfig: 1,
      reviewedPlateReads: 3,
    });
    expect(blocker).toContain('allocation history');
  });
});
