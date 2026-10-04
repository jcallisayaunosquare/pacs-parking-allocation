import { describe, expect, it } from 'vitest';
import { WeightedLotteryDraw } from './weighted-lottery-draw';
import { seededRng } from './rng';
import { FenwickTree } from './fenwick';
import type { DrawableSpot, Entrant } from './types';

const draw = new WeightedLotteryDraw();

const entrant = (n: number, score = 0, needsAccessible = false): Entrant => ({
  residentId: `r${String(n).padStart(4, '0')}`,
  fairnessScore: score,
  needsAccessibleSpot: needsAccessible,
});

const spot = (n: number, type: DrawableSpot['type'] = 'STANDARD'): DrawableSpot => ({
  spotId: `s${String(n).padStart(4, '0')}`,
  spotCode: `B1-${String(n).padStart(2, '0')}`,
  type,
});

const entrants = (n: number, score = 0): Entrant[] =>
  Array.from({ length: n }, (_, i) => entrant(i, score));

const spots = (n: number): DrawableSpot[] => Array.from({ length: n }, (_, i) => spot(i));

describe('seededRng', () => {
  it('is reproducible for a given seed', () => {
    const a = seededRng(42n);
    const b = seededRng(42n);
    const seqA = Array.from({ length: 50 }, () => a.nextUint32());
    const seqB = Array.from({ length: 50 }, () => b.nextUint32());
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = Array.from({ length: 20 }, (_, i) => i).map(() => seededRng(1n).nextUint32());
    const b = Array.from({ length: 20 }, (_, i) => i).map(() => seededRng(2n).nextUint32());
    expect(a[0]).not.toEqual(b[0]);
  });

  it('keeps nextInt inside the bound', () => {
    const rng = seededRng(7n);
    for (let i = 0; i < 1000; i++) {
      const v = rng.nextInt(13);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(13);
    }
  });

  it('rejects a non-positive bound', () => {
    expect(() => seededRng(1n).nextInt(0)).toThrow(RangeError);
  });

  it('is close to uniform over a small bound', () => {
    const rng = seededRng(99n);
    const buckets = new Array<number>(10).fill(0);
    const n = 200_000;
    for (let i = 0; i < n; i++) buckets[rng.nextInt(10)]!++;
    for (const b of buckets) expect(Math.abs(b - n / 10) / (n / 10)).toBeLessThan(0.05);
  });
});

describe('FenwickTree', () => {
  it('reports totals and point weights', () => {
    const t = new FenwickTree([1, 2, 3, 4]);
    expect(t.total).toBe(10);
    expect(t.weightAt(2)).toBe(3);
    expect(t.prefixSum(1)).toBe(3);
  });

  it('locates an index by cumulative weight', () => {
    const t = new FenwickTree([1, 2, 3]);
    expect(t.findByCumulativeWeight(0)).toBe(0); // [0,1)
    expect(t.findByCumulativeWeight(1)).toBe(1); // [1,3)
    expect(t.findByCumulativeWeight(2)).toBe(1);
    expect(t.findByCumulativeWeight(3)).toBe(2); // [3,6)
    expect(t.findByCumulativeWeight(5)).toBe(2);
  });

  it('rejects negative or fractional weights', () => {
    expect(() => new FenwickTree([1, -1])).toThrow(RangeError);
    expect(() => new FenwickTree([1.5])).toThrow(RangeError);
  });
});

describe('WeightedLotteryDraw — reproducibility', () => {
  it('yields identical results for the same seed and inputs', () => {
    const e = entrants(40);
    const s = spots(12);
    const a = draw.draw(e, s, 123_456_789n);
    const b = draw.draw(e, s, 123_456_789n);
    expect(a).toEqual(b);
  });

  it('yields a different result for a different seed', () => {
    const e = entrants(40);
    const s = spots(12);
    const a = draw.draw(e, s, 1n).assignments.map((x) => x.residentId);
    const b = draw.draw(e, s, 2n).assignments.map((x) => x.residentId);
    expect(a).not.toEqual(b);
  });

  it('does not depend on the order the entrants arrive in', () => {
    const e = entrants(30);
    const s = spots(8);
    const shuffled = [...e].reverse();
    const a = draw.draw(e, s, 555n);
    const b = draw.draw(shuffled, s, 555n);
    expect(a.assignments).toEqual(b.assignments);
    expect(a.waitlist).toEqual(b.waitlist);
  });
});

describe('WeightedLotteryDraw — invariants', () => {
  it('assigns every entrant when spots are plentiful', () => {
    const r = draw.draw(entrants(10), spots(20), 9n);
    expect(r.assignments).toHaveLength(10);
    expect(r.waitlist).toHaveLength(0);
  });

  it('fills every spot and waitlists the rest when entrants exceed spots', () => {
    const r = draw.draw(entrants(50), spots(15), 9n);
    expect(r.assignments).toHaveLength(15);
    expect(r.waitlist).toHaveLength(35);
    expect(r.waitlist.map((w) => w.position)).toEqual(
      Array.from({ length: 35 }, (_, i) => i + 1),
    );
  });

  it('never assigns a resident twice, nor a spot twice', () => {
    const r = draw.draw(entrants(60), spots(25), 4321n);
    expect(new Set(r.assignments.map((a) => a.residentId)).size).toBe(25);
    expect(new Set(r.assignments.map((a) => a.spotId)).size).toBe(25);
  });

  it('never puts a winner on the waitlist', () => {
    const r = draw.draw(entrants(40), spots(10), 77n);
    const won = new Set(r.assignments.map((a) => a.residentId));
    expect(r.waitlist.some((w) => won.has(w.residentId))).toBe(false);
  });

  it('handles zero entrants', () => {
    const r = draw.draw([], spots(5), 1n);
    expect(r.assignments).toHaveLength(0);
    expect(r.waitlist).toHaveLength(0);
  });

  it('handles zero spots by waitlisting everyone', () => {
    const r = draw.draw(entrants(7), [], 1n);
    expect(r.assignments).toHaveLength(0);
    expect(r.waitlist).toHaveLength(7);
  });

  it('snapshots the score that was used at draw time', () => {
    const e = [entrant(1, 3), entrant(2, 0)];
    const r = draw.draw(e, spots(2), 1n);
    const byId = new Map(r.assignments.map((a) => [a.residentId, a.fairnessScoreAtDraw]));
    expect(byId.get('r0001')).toBe(3);
    expect(byId.get('r0002')).toBe(0);
  });
});

describe('WeightedLotteryDraw — accessibility pass', () => {
  it('gives accessible spots to residents who need them', () => {
    const e = [entrant(1, 0, true), entrant(2, 0, false), entrant(3, 0, false)];
    const s = [spot(1, 'ACCESSIBLE'), spot(2), spot(3)];
    const r = draw.draw(e, s, 1n);
    const pre = r.assignments.find((a) => a.viaAccessibilityPreAssignment);
    expect(pre?.residentId).toBe('r0001');
    expect(pre?.spotId).toBe('s0001');
  });

  it('reports an unmet need when there is no accessible spot', () => {
    const e = [entrant(1, 0, true), entrant(2, 0, true)];
    const s = [spot(1, 'ACCESSIBLE'), spot(2)];
    const r = draw.draw(e, s, 1n);
    expect(r.unmetAccessibilityNeeds).toHaveLength(1);
    // The unmet resident still competes in the general draw.
    expect(r.assignments).toHaveLength(2);
  });

  it('returns unused accessible spots to the general pool', () => {
    const e = entrants(3);
    const s = [spot(1, 'ACCESSIBLE'), spot(2), spot(3)];
    const r = draw.draw(e, s, 1n);
    expect(r.assignments).toHaveLength(3);
    expect(r.assignments.every((a) => !a.viaAccessibilityPreAssignment)).toBe(true);
  });
});

describe('WeightedLotteryDraw — waitlist order', () => {
  it('puts the heaviest weight nearest the front', () => {
    const e = [entrant(1, 0), entrant(2, 5), entrant(3, 2)];
    const r = draw.draw(e, [], 1n);
    expect(r.waitlist.map((w) => w.residentId)).toEqual(['r0002', 'r0003', 'r0001']);
  });

  it('breaks ties with the seed, not alphabetically', () => {
    const e = entrants(20, 1);
    const orders = new Set<string>();
    for (const seed of [1n, 2n, 3n, 4n, 5n]) {
      orders.add(draw.draw(e, [], seed).waitlist.map((w) => w.residentId).join(','));
    }
    // Five seeds should not all produce the same order.
    expect(orders.size).toBeGreaterThan(1);
  });
});
