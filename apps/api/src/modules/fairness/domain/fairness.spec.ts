import { describe, expect, it } from 'vitest';
import { applyOutcome, drawWeight, explain, initialFairnessState } from './fairness';

const base = initialFairnessState('r1');

describe('applyOutcome', () => {
  it('resets the score and counts a win when assigned', () => {
    const s = applyOutcome({ ...base, score: 5, consecutiveMisses: 5 }, 'ASSIGNED', 'c1');
    expect(s.score).toBe(0);
    expect(s.consecutiveMisses).toBe(0);
    expect(s.totalWins).toBe(1);
    expect(s.totalRegistrations).toBe(1);
    expect(s.lastWonCycleId).toBe('c1');
  });

  it('increments the score and misses when waitlisted', () => {
    const s = applyOutcome({ ...base, score: 2, consecutiveMisses: 2 }, 'WAITLISTED', 'c1');
    expect(s.score).toBe(3);
    expect(s.consecutiveMisses).toBe(3);
    expect(s.totalWins).toBe(0);
    expect(s.totalRegistrations).toBe(1);
    expect(s.lastWonCycleId).toBeNull();
  });

  it('leaves the state untouched when skipped (FR-21)', () => {
    const before = { ...base, score: 4, consecutiveMisses: 4, totalRegistrations: 9 };
    expect(applyOutcome(before, 'SKIPPED', 'c1')).toEqual(before);
  });

  it('walks the four-cycle worked example of §13', () => {
    let s = initialFairnessState('r1');
    s = applyOutcome(s, 'WAITLISTED', 'c1'); // score 1
    s = applyOutcome(s, 'WAITLISTED', 'c2'); // score 2
    s = applyOutcome(s, 'ASSIGNED', 'c3'); //  score 0, win
    s = applyOutcome(s, 'WAITLISTED', 'c4'); // score 1
    expect(s).toEqual({
      residentId: 'r1',
      score: 1,
      consecutiveMisses: 1,
      totalRegistrations: 4,
      totalWins: 1,
      lastWonCycleId: 'c3',
    });
  });
});

describe('drawWeight', () => {
  it('is score + 1 so nobody is ever excluded', () => {
    expect(drawWeight(0)).toBe(1);
    expect(drawWeight(8)).toBe(9);
  });
});

describe('explain', () => {
  it('explains a held spot', () => {
    expect(explain(base, true)).toMatch(/reset to 0/);
  });

  it('explains a first-time entrant', () => {
    expect(explain(base, false)).toMatch(/once/);
  });

  it('states the multiplier for a resident who has missed cycles', () => {
    const s = { ...base, score: 3, consecutiveMisses: 3 };
    expect(explain(s, false)).toContain('4 times');
    expect(explain(s, false)).toContain('4×');
  });

  it('uses the singular for a single missed cycle', () => {
    const s = { ...base, score: 1, consecutiveMisses: 1 };
    expect(explain(s, false)).toContain('1 cycle,');
  });
});
