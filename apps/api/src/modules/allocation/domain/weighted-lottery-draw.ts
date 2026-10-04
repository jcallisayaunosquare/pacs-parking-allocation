import { FenwickTree } from './fenwick';
import { seededRng, type Rng } from './rng';
import type {
  DrawableSpot,
  DrawAssignment,
  DrawResult,
  DrawStrategy,
  DrawWaitlistEntry,
  Entrant,
} from './types';

/** numeric(10,2) in the database; scale to integers so the draw is exactly reproducible. */
const SCALE = 100;

/** Weight is score + 1, so a resident who just won still has a non-zero chance (§12). */
const weightOf = (e: Entrant): number => Math.round((e.fairnessScore + 1) * SCALE);

const byResidentId = (a: Entrant, b: Entrant): number =>
  a.residentId < b.residentId ? -1 : a.residentId > b.residentId ? 1 : 0;

const bySpotCode = (a: DrawableSpot, b: DrawableSpot): number =>
  a.spotCode < b.spotCode ? -1 : a.spotCode > b.spotCode ? 1 : 0;

/**
 * Weighted lottery without replacement — the component the product is judged on (§12).
 *
 * Deterministic for a given (entrants, spots, seed) triple. Pure and synchronous: no I/O,
 * no clock, no async. That is what lets the 10 000-run statistical suite finish in
 * milliseconds and what makes a past run explainable to a resident (§27).
 *
 * Three passes, in order:
 *   1. Accessibility — ACCESSIBLE spots go to residents who need them. Oversubscribed,
 *      it is itself a weighted draw, so need alone does not outrank fairness.
 *   2. Weighted draw — remaining entrants against remaining spots, without replacement.
 *   3. Waitlist — non-winners ordered by weight, ties broken by the same seeded RNG
 *      (never by insertion order, which would be a hidden bias).
 */
export class WeightedLotteryDraw implements DrawStrategy {
  readonly version = 'weighted-lottery-v1';

  draw(entrants: readonly Entrant[], spots: readonly DrawableSpot[], seed: bigint): DrawResult {
    const rng = seededRng(seed);

    // Stable input order, or the seed means nothing.
    const pool = [...entrants].sort(byResidentId);
    const accessibleSpots = [...spots].filter((s) => s.type === 'ACCESSIBLE').sort(bySpotCode);
    const otherSpots = [...spots].filter((s) => s.type !== 'ACCESSIBLE').sort(bySpotCode);

    const assignments: DrawAssignment[] = [];
    const assigned = new Set<string>();

    // ---------------------------------------------------------------- pass 1
    const needsAccessible = pool.filter((e) => e.needsAccessibleSpot);
    const accessibleWinners = this.pick(needsAccessible, accessibleSpots.length, rng);

    accessibleWinners.forEach((entrant, i) => {
      const spot = accessibleSpots[i];
      if (!spot) return;
      assignments.push({
        residentId: entrant.residentId,
        spotId: spot.spotId,
        fairnessScoreAtDraw: entrant.fairnessScore,
        viaAccessibilityPreAssignment: true,
      });
      assigned.add(entrant.residentId);
    });

    const unmetAccessibilityNeeds = needsAccessible
      .filter((e) => !assigned.has(e.residentId))
      .map((e) => e.residentId);

    // Accessible spots not taken in pass 1 return to the general pool — an empty
    // accessible bay is worse than a standard-need resident parking in it.
    const remainingSpots = [...otherSpots, ...accessibleSpots.slice(accessibleWinners.length)].sort(
      bySpotCode,
    );

    // ---------------------------------------------------------------- pass 2
    const remainingPool = pool.filter((e) => !assigned.has(e.residentId));
    const winners = this.pick(remainingPool, remainingSpots.length, rng);

    winners.forEach((entrant, i) => {
      const spot = remainingSpots[i];
      if (!spot) return;
      assignments.push({
        residentId: entrant.residentId,
        spotId: spot.spotId,
        fairnessScoreAtDraw: entrant.fairnessScore,
        viaAccessibilityPreAssignment: false,
      });
      assigned.add(entrant.residentId);
    });

    // ---------------------------------------------------------------- pass 3
    const losers = pool.filter((e) => !assigned.has(e.residentId));
    const waitlist: DrawWaitlistEntry[] = this.orderWaitlist(losers, rng).map((e, i) => ({
      residentId: e.residentId,
      position: i + 1,
      fairnessScoreAtDraw: e.fairnessScore,
    }));

    return {
      algorithmVersion: this.version,
      seed,
      assignments,
      waitlist,
      unmetAccessibilityNeeds,
    };
  }

  /**
   * Draws min(k, pool.length) distinct entrants, probability proportional to weight.
   * Zeroing a winner's weight is the "without replacement" part.
   */
  private pick(pool: readonly Entrant[], k: number, rng: Rng): Entrant[] {
    const take = Math.min(k, pool.length);
    if (take <= 0) return [];

    const tree = new FenwickTree(pool.map(weightOf));
    const winners: Entrant[] = [];

    for (let i = 0; i < take; i++) {
      const total = tree.total;
      if (total <= 0) break;
      const target = rng.nextInt(total);
      const idx = tree.findByCumulativeWeight(target);
      const entrant = pool[idx];
      if (!entrant) break;
      winners.push(entrant);
      tree.add(idx, -tree.weightAt(idx));
    }
    return winners;
  }

  /**
   * Heavier weight first, so the resident who has waited longest is nearest the front.
   * Ties are shuffled with the same seeded RNG: deterministic, still auditable, and
   * free of the alphabetical bias that sorting by id alone would bake in.
   */
  private orderWaitlist(losers: readonly Entrant[], rng: Rng): Entrant[] {
    const keyed = losers.map((e) => ({ e, tiebreak: rng.nextUint32() }));
    keyed.sort((a, b) => {
      const byWeight = weightOf(b.e) - weightOf(a.e);
      if (byWeight !== 0) return byWeight;
      if (a.tiebreak !== b.tiebreak) return a.tiebreak - b.tiebreak;
      return byResidentId(a.e, b.e);
    });
    return keyed.map((k) => k.e);
  }
}
