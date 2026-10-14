import { describe, expect, it } from 'vitest';
import { lotOccupancy, spotRemovalBlocker } from './spot';

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

describe('lotOccupancy', () => {
  const until = new Date('2027-01-14T00:00:00Z');
  const rows = [
    { spotId: 's1', spotCode: 'B1-A01', type: 'EV', isActive: true, assignment: null },
    {
      spotId: 's2',
      spotCode: 'B1-A02',
      type: 'STANDARD',
      isActive: true,
      assignment: { residentId: 'r-me', fullName: 'Marta Mendoza', unitNumber: '103', validUntil: until },
    },
    {
      spotId: 's3',
      spotCode: 'B1-A03',
      type: 'STANDARD',
      isActive: true,
      assignment: { residentId: 'r-other', fullName: 'Ana Rojas', unitNumber: '101', validUntil: until },
    },
    { spotId: 's4', spotCode: 'B1-A04', type: 'STANDARD', isActive: false, assignment: null },
  ] as const;

  it('derives status from the inventory and the live assignment, nothing else', () => {
    const out = lotOccupancy(rows, { residentId: null, isAdmin: true });
    expect(out.map((b) => b.status)).toEqual(['FREE', 'HELD', 'HELD', 'OUT_OF_SERVICE']);
    expect(out[0]!.validUntil).toBeNull();
    expect(out[1]!.validUntil).toEqual(until);
  });

  it('names occupants to an administrator', () => {
    const out = lotOccupancy(rows, { residentId: null, isAdmin: true });
    expect(out[1]!.occupant).toEqual({ displayName: 'Marta Mendoza', unit: '103' });
    expect(out.every((b) => !b.isMine)).toBe(true);
  });

  it('never names an occupant to a resident, and marks only their own bay', () => {
    const out = lotOccupancy(rows, { residentId: 'r-me', isAdmin: false });
    expect(out.every((b) => b.occupant === null)).toBe(true);
    expect(out.filter((b) => b.isMine).map((b) => b.spotCode)).toEqual(['B1-A02']);
  });

  /* The bug this exists for: with no period running, nobody holds a bay. */
  it('marks no bay as yours when you hold none', () => {
    const free = rows.map((r) => ({ ...r, assignment: null }));
    const out = lotOccupancy(free, { residentId: 'r-me', isAdmin: false });
    expect(out.some((b) => b.isMine)).toBe(false);
    expect(out.filter((b) => b.status === 'HELD')).toHaveLength(0);
  });
});
