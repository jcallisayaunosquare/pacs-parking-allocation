import { describe, expect, it } from 'vitest';
import { seededRng, type Rng } from './rng';
import {
  compareByPriority,
  computePriorityKey,
  type Candidate,
  type PriorityKey,
} from './priority-key';
import { allocate } from './allocate';
import { DEFAULT_ALLOCATION_CONFIG, type AllocationConfig } from './allocation-config';

/**
 * The property suite. The comparator is pure, so generating cases is cheap; the generator
 * is the project's own seeded RNG rather than a new dependency, which also means a failure
 * is reproducible from the seed printed in the test name.
 *
 * Each property is one of the invariants the fairness ADR commits to, and together they
 * are the reason the ordering can be defended rather than merely demonstrated.
 */

const CFG: AllocationConfig = { ...DEFAULT_ALLOCATION_CONFIG, version: 1 };
const T0 = new Date('2026-04-01T12:00:00Z');
const SEED = '7'.repeat(64);
const HOUR = 3_600_000;
const CASES = 10_000;

const ago = (hours: number): Date => new Date(T0.getTime() - hours * HOUR);

/** A candidate drawn from the awkward parts of the space: around 0, around B, and far out. */
function anyCandidate(rng: Rng, i: number): Candidate {
  const served = rng.nextInt(6);
  const wait = [rng.nextInt(48), rng.nextInt(5000), rng.nextInt(2) + CFG.earlyWaitingBiasHours - 1][
    rng.nextInt(3)
  ]!;
  const everServed = served > 0 && rng.nextInt(10) > 0;
  return {
    residentId: `r-${String(i).padStart(6, '0')}`,
    participationStartedAt: everServed ? ago(100_000) : ago(wait),
    lastBenefitEndAt: everServed ? ago(wait) : null,
    lastForfeitAt: null,
    absenceResetAt: null,
    servedCount: served,
    priorParticipations: everServed ? served + rng.nextInt(3) : rng.nextInt(2),
    needsAccessibleSpot: rng.nextInt(8) === 0,
    hasElectricVehicle: rng.nextInt(8) === 0,
  };
}

const keyAt = (c: Candidate, at: Date = T0, cfg: AllocationConfig = CFG): PriorityKey =>
  computePriorityKey(c, cfg, at, SEED, 'run-props');

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);

describe('priority key properties', () => {
  it('P-1: the comparator is a total order (antisymmetric, total, transitive)', () => {
    const rng = seededRng(11n);
    for (let i = 0; i < CASES; i++) {
      const a = keyAt(anyCandidate(rng, i * 3));
      const b = keyAt(anyCandidate(rng, i * 3 + 1));
      const c = keyAt(anyCandidate(rng, i * 3 + 2));

      expect(sign(compareByPriority(a, b))).toBe(-sign(compareByPriority(b, a)));
      // Totality: only identical ids may compare equal.
      if (compareByPriority(a, b) === 0) expect(a.residentId).toBe(b.residentId);

      if (compareByPriority(a, b) <= 0 && compareByPriority(b, c) <= 0) {
        expect(compareByPriority(a, c)).toBeLessThanOrEqual(0);
      }
    }
  });

  it('P-2: nobody\'s effective waiting time ever falls while they wait', () => {
    const rng = seededRng(12n);
    for (let i = 0; i < CASES; i++) {
      const c = anyCandidate(rng, i);
      const later = new Date(T0.getTime() + (1 + rng.nextInt(5000)) * HOUR);
      expect(keyAt(c, later).effectiveWaitQuanta).toBeGreaterThanOrEqual(
        keyAt(c).effectiveWaitQuanta,
      );
    }
  });

  it('P-3: with equal history, the earlier anchor never ranks lower', () => {
    const rng = seededRng(13n);
    for (let i = 0; i < CASES; i++) {
      const served = rng.nextInt(4);
      const wA = CFG.earlyWaitingBiasHours + rng.nextInt(5000);
      const wB = wA + 1 + rng.nextInt(500);
      const mk = (id: string, w: number): Candidate => ({
        residentId: id,
        participationStartedAt: ago(w),
        lastBenefitEndAt: null,
        lastForfeitAt: null,
        absenceResetAt: null,
        servedCount: served,
        priorParticipations: 1,
        needsAccessibleSpot: false,
        hasElectricVehicle: false,
      });
      // B waited longer, so B must come first.
      expect(compareByPriority(keyAt(mk('b', wB)), keyAt(mk('a', wA)))).toBeLessThan(0);
    }
  });

  it('P-4: every cooling resident loses to every non-cooling resident', () => {
    const rng = seededRng(14n);
    let cooling = 0;
    for (let i = 0; i < CASES; i++) {
      const a = keyAt(anyCandidate(rng, i * 2));
      const b = keyAt(anyCandidate(rng, i * 2 + 1));
      if (a.biasApplied === b.biasApplied) continue;
      cooling++;
      const [cool, warm] = a.biasApplied ? [a, b] : [b, a];
      expect(compareByPriority(warm!, cool!)).toBeLessThan(0);
    }
    expect(cooling).toBeGreaterThan(100); // the property was actually exercised
  });

  it('P-5: being allocated moves a resident strictly below their former equal', () => {
    const base: Candidate = {
      residentId: 'a',
      participationStartedAt: ago(2000),
      lastBenefitEndAt: null,
      lastForfeitAt: null,
      absenceResetAt: null,
      servedCount: 1,
      priorParticipations: 4,
      needsAccessibleSpot: false,
      hasElectricVehicle: false,
    };
    const twin: Candidate = { ...base, residentId: 'b' };
    // `a` is allocated: their benefit ends now, and h increments.
    const allocated: Candidate = { ...base, lastBenefitEndAt: T0, servedCount: 2 };
    const next = new Date(T0.getTime() + 2000 * HOUR);
    expect(compareByPriority(keyAt(twin, next), keyAt(allocated, next))).toBeLessThan(0);
  });

  it('P-6: history cannot change the order when the effective waits differ', () => {
    const rng = seededRng(16n);
    for (let i = 0; i < CASES; i++) {
      const a = keyAt(anyCandidate(rng, i * 2));
      const b = keyAt(anyCandidate(rng, i * 2 + 1));
      if (a.effectiveWaitQuanta === b.effectiveWaitQuanta) continue;
      const before = sign(compareByPriority(a, b));
      const after = sign(
        compareByPriority({ ...a, servedCount: a.servedCount + 9 }, { ...b, servedCount: 0 }),
      );
      expect(after).toBe(before);
    }
  });

  it('P-8: the outcome is identical under a shuffled input array', () => {
    const rng = seededRng(17n);
    const candidates = Array.from({ length: 120 }, (_, i) => anyCandidate(rng, i));
    const spots = Array.from({ length: 17 }, (_, i) => ({
      spotId: `s-${i}`,
      spotCode: `B1-${String(i).padStart(2, '0')}`,
      type: (i < 2 ? 'ACCESSIBLE' : i < 4 ? 'EV' : 'STANDARD') as 'ACCESSIBLE' | 'EV' | 'STANDARD',
    }));
    const input = { runId: 'run-props', decidedAt: T0, seedHex: SEED, config: CFG, candidates, spots };

    const reference = allocate(input);
    for (let trial = 0; trial < 25; trial++) {
      const shuffled = [...candidates];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = rng.nextInt(i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const other = allocate({ ...input, candidates: shuffled });
      expect(other.allocations).toEqual(reference.allocations);
      expect(other.waitlist).toEqual(reference.waitlist);
    }
  });

  it('P-9: conservation - every candidate is assigned or waitlisted, exactly once', () => {
    const rng = seededRng(18n);
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + rng.nextInt(40);
      const m = rng.nextInt(20);
      const candidates = Array.from({ length: n }, (_, i) => anyCandidate(rng, i));
      const spots = Array.from({ length: m }, (_, i) => ({
        spotId: `s-${i}`,
        spotCode: `B1-${String(i).padStart(2, '0')}`,
        type: 'STANDARD' as const,
      }));
      const out = allocate({
        runId: `t-${trial}`,
        decidedAt: T0,
        seedHex: SEED,
        config: CFG,
        candidates,
        spots,
      });

      expect(out.allocations).toHaveLength(Math.min(n, m));
      expect(new Set(out.allocations.map((a) => a.residentId)).size).toBe(out.allocations.length);
      expect(new Set(out.allocations.map((a) => a.spotId)).size).toBe(out.allocations.length);
      expect(out.allocations.length + out.waitlist.length).toBe(n);
      expect(out.keys).toHaveLength(n);
      expect(out.waitlist.map((w) => w.position)).toEqual(
        Array.from({ length: out.waitlist.length }, (_, i) => i + 1),
      );
    }
  });

  /**
   * P-10. A k-way exact tie is resolved by the token alone, so over many seeds each tied
   * resident must win about equally often. Asserted with a chi-squared statistic rather
   * than a tolerance per bucket, which is the test that would actually catch a biased
   * token derivation.
   */
  it('P-10: the raffle is uniform across a k-way tie', () => {
    const k = 5;
    const trials = 20_000;
    const tied: Candidate[] = Array.from({ length: k }, (_, i) => ({
      residentId: `tied-${i}`,
      participationStartedAt: ago(2160),
      lastBenefitEndAt: null,
      lastForfeitAt: null,
      absenceResetAt: null,
      servedCount: 2,
      priorParticipations: 8,
      needsAccessibleSpot: false,
      hasElectricVehicle: false,
    }));

    const wins = new Map<string, number>(tied.map((c) => [c.residentId, 0]));
    for (let t = 0; t < trials; t++) {
      const out = allocate({
        runId: `run-${t}`,
        decidedAt: T0,
        seedHex: SEED,
        config: CFG,
        candidates: tied,
        spots: [{ spotId: 's-0', spotCode: 'B1-00', type: 'STANDARD' }],
      });
      const winner = out.allocations[0]!.residentId;
      wins.set(winner, (wins.get(winner) ?? 0) + 1);
    }

    const expected = trials / k;
    const chi2 = [...wins.values()].reduce((s, o) => s + ((o - expected) ** 2) / expected, 0);
    // 4 degrees of freedom, alpha = 0.001 -> critical value 18.47.
    expect(chi2).toBeLessThan(18.47);
    for (const n of wins.values()) expect(n).toBeGreaterThan(0);
  });

  /**
   * P-11. The claim the weighted lottery could never make: under longest-wait-first with
   * a fixed population, nobody starves and the dry spell is bounded. M residents, N bays,
   * K periods, every resident entering every period.
   */
  it('P-11: no starvation - the dry spell is bounded by ceil(M / N)', () => {
    const M = 23;
    const N = 5;
    const K = 40;
    const periodHours = 24 * 90;

    let now = T0;
    const state = new Map<string, { anchor: Date; served: number; participations: number }>(
      Array.from({ length: M }, (_, i) => [
        `r-${i}`,
        { anchor: new Date(T0.getTime() - (M - i) * HOUR), served: 0, participations: 0 },
      ]),
    );
    const lastWin = new Map<string, number>();
    const dry = new Map<string, number>(Array.from({ length: M }, (_, i) => [`r-${i}`, 0]));

    for (let period = 0; period < K; period++) {
      const candidates: Candidate[] = [...state.entries()].map(([id, s]) => ({
        residentId: id,
        participationStartedAt: s.anchor,
        lastBenefitEndAt: s.served > 0 ? s.anchor : null,
        lastForfeitAt: null,
        absenceResetAt: null,
        servedCount: s.served,
        priorParticipations: s.participations,
        needsAccessibleSpot: false,
        hasElectricVehicle: false,
      }));
      const spots = Array.from({ length: N }, (_, i) => ({
        spotId: `s-${i}`,
        spotCode: `B1-${String(i).padStart(2, '0')}`,
        type: 'STANDARD' as const,
      }));

      const out = allocate({
        runId: `p-${period}`,
        decidedAt: now,
        seedHex: SEED,
        config: CFG,
        candidates,
        spots,
      });

      const end = new Date(now.getTime() + periodHours * HOUR);
      for (const s of state.values()) s.participations += 1;
      for (const a of out.allocations) {
        const s = state.get(a.residentId)!;
        // The allocation runs for the whole period, so the anchor moves to its end.
        s.anchor = end;
        s.served += 1;
        const since = period - (lastWin.get(a.residentId) ?? -1) - 1;
        dry.set(a.residentId, Math.max(dry.get(a.residentId)!, since));
        lastWin.set(a.residentId, period);
      }
      now = new Date(end.getTime() + HOUR);
    }

    expect([...lastWin.keys()]).toHaveLength(M); // nobody never served
    const bound = Math.ceil(M / N);
    for (const [id, worst] of dry) {
      expect(worst, `${id} went ${worst} periods without a bay`).toBeLessThanOrEqual(bound);
    }
    // And the load is near-perfectly even, which is the point of the whole change.
    const served = [...state.values()].map((s) => s.served);
    expect(Math.max(...served) - Math.min(...served)).toBeLessThanOrEqual(1);
  });
});
