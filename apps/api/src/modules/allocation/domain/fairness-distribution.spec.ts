import { describe, expect, it } from 'vitest';
import { WeightedLotteryDraw } from './weighted-lottery-draw';
import type { DrawableSpot, Entrant } from './types';

/**
 * The statistical suite of §27 — the only test that checks the raffle is *fair*
 * rather than merely that it runs.
 *
 * Seeded on purpose: the seeds are fixed, so the tolerance band cannot flake in CI
 * while still exercising 10 000 independent draws.
 */
const draw = new WeightedLotteryDraw();

const SCORES = [0, 0, 1, 2, 3, 4, 8] as const;

const pool: Entrant[] = SCORES.map((score, i) => ({
  residentId: `r${String(i).padStart(3, '0')}`,
  fairnessScore: score,
  needsAccessibleSpot: false,
}));

const oneSpot: DrawableSpot[] = [{ spotId: 's1', spotCode: 'B1-01', type: 'STANDARD' }];

describe('fairness distribution over 10 000 runs', () => {
  const RUNS = 10_000;
  const wins = new Map<string, number>(pool.map((e) => [e.residentId, 0]));

  for (let i = 0; i < RUNS; i++) {
    const r = draw.draw(pool, oneSpot, BigInt(i) * 2_654_435_761n + 12_345n);
    const winner = r.assignments[0]?.residentId;
    if (winner) wins.set(winner, (wins.get(winner) ?? 0) + 1);
  }

  const totalWeight = pool.reduce((s, e) => s + e.fairnessScore + 1, 0);

  it('tracks the weight ratio within a 15% relative band', () => {
    for (const e of pool) {
      const expected = ((e.fairnessScore + 1) / totalWeight) * RUNS;
      const actual = wins.get(e.residentId) ?? 0;
      const relativeError = Math.abs(actual - expected) / expected;
      expect(
        relativeError,
        `resident ${e.residentId} (score ${e.fairnessScore}) won ${actual}, expected ~${expected.toFixed(0)}`,
      ).toBeLessThan(0.15);
    }
  });

  it('gives no entrant a zero probability', () => {
    for (const e of pool) expect(wins.get(e.residentId) ?? 0).toBeGreaterThan(0);
  });

  it('awards exactly one spot per run', () => {
    const total = [...wins.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(RUNS);
  });

  it('ranks the long-waiting resident above the recent winner', () => {
    const unlucky = wins.get('r006') ?? 0; // score 8 → weight 9
    const freshWinner = wins.get('r000') ?? 0; // score 0 → weight 1
    expect(unlucky).toBeGreaterThan(freshWinner * 4);
  });
});

describe('no starvation across consecutive cycles', () => {
  it('eventually assigns a resident who keeps losing', () => {
    // 20 entrants, 1 spot. Track one resident whose score grows every miss;
    // within 60 cycles the weight should have carried them to a win.
    let scores = new Array<number>(20).fill(0);
    let targetWon = false;

    for (let cycle = 0; cycle < 60 && !targetWon; cycle++) {
      const entrants: Entrant[] = scores.map((score, i) => ({
        residentId: `r${String(i).padStart(3, '0')}`,
        fairnessScore: score,
        needsAccessibleSpot: false,
      }));
      const r = draw.draw(entrants, oneSpot, BigInt(cycle) * 7_919n + 31n);
      const winnerId = r.assignments[0]?.residentId;
      scores = scores.map((s, i) => (`r${String(i).padStart(3, '0')}` === winnerId ? 0 : s + 1));
      if (winnerId === 'r019') targetWon = true;
    }

    expect(targetWon).toBe(true);
  });
});
