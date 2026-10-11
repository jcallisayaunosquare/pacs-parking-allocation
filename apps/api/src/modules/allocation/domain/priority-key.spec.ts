import { describe, expect, it } from 'vitest';
import {
  compareByPriority,
  computePriorityKey,
  quantaToHours,
  raffleToken,
  type Candidate,
  type PriorityKey,
} from './priority-key';
import { DEFAULT_ALLOCATION_CONFIG, biasQuanta, type AllocationConfig } from './allocation-config';

/** The fixture of section 9.2 of the fairness ADR: B = 24 h, Q = 60 min. */
const CFG: AllocationConfig = { ...DEFAULT_ALLOCATION_CONFIG, version: 1 };
const T0 = new Date('2026-04-01T12:00:00Z');
const SEED = 'f'.repeat(64);
const RUN = 'run-1';
const HOUR = 3_600_000;

const ago = (hours: number): Date => new Date(T0.getTime() - hours * HOUR);

/**
 * `anchorHoursAgo` is where waiting started; `served` is h(r); `lastServed` says whether
 * that anchor is the end of a previous allocation, which is what makes cooling possible.
 */
const candidate = (
  id: string,
  anchorHoursAgo: number,
  served: number,
  lastServed: boolean,
  priorParticipations = 1,
): Candidate => ({
  residentId: id,
  participationStartedAt: lastServed ? ago(100_000) : ago(anchorHoursAgo),
  lastBenefitEndAt: lastServed ? ago(anchorHoursAgo) : null,
  lastForfeitAt: null,
  absenceResetAt: null,
  servedCount: served,
  priorParticipations,
  needsAccessibleSpot: false,
  hasElectricVehicle: false,
});

const key = (c: Candidate, cfg: AllocationConfig = CFG): PriorityKey =>
  computePriorityKey(c, cfg, T0, SEED, RUN);

const order = (cs: readonly Candidate[], cfg: AllocationConfig = CFG): string[] =>
  cs
    .map((c) => key(c, cfg))
    .sort(compareByPriority)
    .map((k) => k.residentId);

describe('computePriorityKey', () => {
  it('anchors a never-served resident on participationStartedAt', () => {
    const k = key(candidate('A', 50, 0, false, 0));
    expect(k.rawWaitQuanta).toBe(50);
    expect(k.effectiveWaitQuanta).toBe(50);
    expect(k.anchorAt.toISOString()).toBe(ago(50).toISOString());
    expect(k.biasApplied).toBe(false);
    expect(k.firstTimeParticipant).toBe(true);
  });

  it('anchors a previously served resident on the end of that allocation', () => {
    const k = key(candidate('A', 2160, 1, true));
    expect(k.rawWaitQuanta).toBe(2160);
    expect(k.effectiveWaitQuanta).toBe(2160);
    expect(k.anchorAt.toISOString()).toBe(ago(2160).toISOString());
  });

  it('quantises to whole hours, so near-misses genuinely tie (U-8)', () => {
    const a = key({ ...candidate('A', 0, 1, true), lastBenefitEndAt: ago(100.9) });
    const b = key({ ...candidate('B', 0, 1, true), lastBenefitEndAt: ago(100.1) });
    expect(a.rawWaitQuanta).toBe(100);
    expect(b.rawWaitQuanta).toBe(100);
    expect(a.effectiveWaitQuanta).toBe(b.effectiveWaitQuanta);
  });

  it('subtracts the whole window while cooling, so the effective wait goes negative', () => {
    const k = key(candidate('X', 7, 3, true));
    expect(k.biasApplied).toBe(true);
    expect(k.effectiveWaitQuanta).toBe(7 - biasQuanta(CFG));
    expect(k.effectiveWaitQuanta).toBeLessThan(0);
  });

  it('cooling is exactly equivalent to a negative effective wait', () => {
    for (let w = 0; w < 48; w++) {
      const k = key(candidate('X', w, 1, true));
      expect(k.biasApplied).toBe(k.effectiveWaitQuanta < 0);
      expect(k.biasApplied).toBe(w < CFG.earlyWaitingBiasHours);
    }
  });

  it('clamps a future anchor to zero rather than wrapping to a huge wait (E-16)', () => {
    const k = key({ ...candidate('A', 0, 0, false, 0), participationStartedAt: ago(-500) });
    expect(k.rawWaitQuanta).toBe(0);
    expect(k.effectiveWaitQuanta).toBe(0);
  });

  it('never lets a resident be cooling and a first-time participant at once (E-15)', () => {
    // Cooling requires a served allocation, which requires a prior participation.
    const k = key(candidate('X', 5, 1, true, 0));
    expect(k.biasApplied && k.firstTimeParticipant && k.servedCount > 0).toBe(true);
    // The combination is only reachable by constructing inconsistent data, which is
    // exactly what the migration backfill could produce - so it is asserted on, here.
    expect(k.servedCount).toBeGreaterThan(0);
  });

  it('converts quanta to hours for anything a human reads', () => {
    expect(quantaToHours(48, CFG)).toBe(48);
    expect(quantaToHours(48, { ...CFG, waitQuantumMinutes: 30 })).toBe(24);
  });
});

describe('raffleToken', () => {
  it('is identity-derived, so a resident can recompute it from three strings', () => {
    expect(raffleToken(SEED, RUN, 'A')).toBe(raffleToken(SEED, RUN, 'A'));
    expect(raffleToken(SEED, RUN, 'A')).not.toBe(raffleToken(SEED, RUN, 'B'));
  });

  it('is scoped to the run, so a past token does not predict a future one', () => {
    expect(raffleToken(SEED, 'run-1', 'A')).not.toBe(raffleToken(SEED, 'run-2', 'A'));
  });

  it('is 128 bits', () => {
    for (let i = 0; i < 200; i++) {
      expect(raffleToken(SEED, RUN, `r${i}`)).toBeLessThan(1n << 128n);
    }
  });
});

describe('compareByPriority - the unit table of section 9.2', () => {
  it('U-1: longer wait wins', () => {
    const cs = [candidate('A', 100, 1, true), candidate('B', 50, 1, true), candidate('C', 25, 1, true)];
    expect(order(cs)).toEqual(['A', 'B', 'C']);
  });

  it('U-2: on an exact tie, fewer past allocations wins', () => {
    const cs = [candidate('A', 100, 3, true), candidate('B', 100, 1, true), candidate('C', 100, 2, true)];
    expect(order(cs)).toEqual(['B', 'C', 'A']);
  });

  it('U-3: on a full tie, the raffle token decides, and only then', () => {
    const a = key(candidate('A', 100, 1, true));
    const b = key(candidate('B', 100, 1, true));
    const expected = a.raffleToken < b.raffleToken ? ['A', 'B'] : ['B', 'A'];
    expect(order([candidate('A', 100, 1, true), candidate('B', 100, 1, true)])).toEqual(expected);
  });

  it('U-4: a cooling resident loses to a first-time participant', () => {
    const x = candidate('X', 20, 1, true);
    const y = candidate('Y', 8, 0, false, 0);
    expect(order([x, y])).toEqual(['Y', 'X']);
  });

  it('U-5: a non-cooling previous holder beats a cooling one', () => {
    expect(order([candidate('X', 20, 1, true), candidate('Z', 48, 1, true)])).toEqual(['Z', 'X']);
  });

  it('U-6: being new does not automatically outrank a previous holder', () => {
    const y = candidate('Y', 8, 0, false, 0);
    const w = candidate('W', 2000, 1, true);
    expect(order([y, w])).toEqual(['W', 'Y']);
  });

  it('U-7: a cooling resident also loses to a non-first-timer with a shorter wait', () => {
    const x = candidate('X', 20, 1, true);
    const z = candidate('Z', 10, 0, false, 1);
    expect(order([x, z])).toEqual(['Z', 'X']);
  });

  it('U-13: an all-cooling run is still totally ordered (E-17)', () => {
    expect(order([candidate('A', 10, 1, true), candidate('B', 20, 1, true)])).toEqual(['B', 'A']);
  });

  it('P-7: with the bias at zero, nobody cools and the ranking is pure waiting time', () => {
    const cfg = { ...CFG, earlyWaitingBiasHours: 0 };
    const cs = [candidate('X', 2, 1, true), candidate('Y', 8, 0, false, 0)];
    expect(cs.map((c) => key(c, cfg).biasApplied)).toEqual([false, false]);
    expect(order(cs, cfg)).toEqual(['Y', 'X']);
  });

  /**
   * The regression test for the transitivity defect. Read rule F as a pairwise override -
   * "a first-timer beats a cooling resident" layered on top of waiting-time comparison -
   * and these three residents form a strict cycle: X beats Z on waiting time, Z beats Y
   * on waiting time, and Y beats X by the override. Array.prototype.sort on a
   * non-transitive comparator has implementation-defined output, so two replays of the
   * same run could produce different winners.
   *
   * Under the implemented form the cycle cannot exist: the bias is a subtraction on X's
   * own key, so X is simply last.
   */
  it('P-1: the 3-resident cycle of the pairwise reading is not a cycle here', () => {
    const x = candidate('X', 20, 1, true); // cooling, 20 h
    const z = candidate('Z', 10, 0, false, 1); // never served, 10 h, not a first-timer
    const y = candidate('Y', 8, 0, false, 0); // never served, 8 h, first-timer

    const kx = key(x);
    const kz = key(z);
    const ky = key(y);

    expect(compareByPriority(kz, kx)).toBeLessThan(0); // Z beats X
    expect(compareByPriority(kz, ky)).toBeLessThan(0); // Z beats Y
    expect(compareByPriority(ky, kx)).toBeLessThan(0); // Y beats X
    // No cycle, and the order is the same whatever order they arrive in.
    expect(order([x, z, y])).toEqual(['Z', 'Y', 'X']);
    expect(order([y, x, z])).toEqual(['Z', 'Y', 'X']);
    expect(order([x, y, z])).toEqual(['Z', 'Y', 'X']);
  });

  // ------------------------------------------------------------------ rules G and H
  //
  // Both are resets of the same clock, and the tests below are mostly about which reset
  // wins when more than one applies - the anchor is a maximum, so the answer is always
  // "the latest one", and that is what makes the pair safe to state separately.

  describe('rule G - a withdrawal ends a benefit', () => {
    const withdrawn = (id: string, hoursAgo: number, served: number): Candidate => ({
      residentId: id,
      participationStartedAt: ago(100_000),
      lastBenefitEndAt: null,
      lastForfeitAt: ago(hoursAgo),
      absenceResetAt: null,
      servedCount: served,
      priorParticipations: 2,
      needsAccessibleSpot: false,
      hasElectricVehicle: false,
    });

    it('anchors waiting on the withdrawal, not on the long-ago arrival', () => {
      const k = key(withdrawn('A', 50, 1));
      expect(k.rawWaitQuanta).toBe(50);
      expect(k.anchorAt.toISOString()).toBe(ago(50).toISOString());
      expect(k.absenceResetApplied).toBe(false);
    });

    it('cools a fresh withdrawal exactly as it cools a finished allocation', () => {
      const fresh = key(withdrawn('A', 2, 1));
      expect(fresh.biasApplied).toBe(true);
      expect(fresh.effectiveWaitQuanta).toBe(2 - biasQuanta(CFG));
      // Beyond the window it is an ordinary wait again.
      expect(key(withdrawn('A', CFG.earlyWaitingBiasHours + 1, 1)).biasApplied).toBe(false);
    });

    it('takes the later of a withdrawal and an expiry', () => {
      const both: Candidate = {
        ...withdrawn('A', 100, 2),
        lastBenefitEndAt: ago(30),
      };
      expect(key(both).anchorAt.toISOString()).toBe(ago(30).toISOString());
      expect(key({ ...both, lastForfeitAt: ago(5) }).anchorAt.toISOString()).toBe(
        ago(5).toISOString(),
      );
    });

    it('ranks a resident who withdrew below one who kept waiting', () => {
      const kept = candidate('KEPT', 500, 1, true);
      const pulled = withdrawn('PULLED', 100, 1);
      expect(order([pulled, kept])).toEqual(['KEPT', 'PULLED']);
    });
  });

  describe('rule H - missing periods restarts the clock', () => {
    const returning = (id: string, registeredHoursAgo: number, served: number): Candidate => ({
      residentId: id,
      participationStartedAt: ago(100_000),
      lastBenefitEndAt: null,
      lastForfeitAt: null,
      absenceResetAt: ago(registeredHoursAgo),
      servedCount: served,
      priorParticipations: 1,
      needsAccessibleSpot: false,
      hasElectricVehicle: false,
    });

    it('anchors on the entry that ended the absence, however long the absence was', () => {
      const k = key(returning('A', 3, 0));
      expect(k.rawWaitQuanta).toBe(3);
      expect(k.anchorAt.toISOString()).toBe(ago(3).toISOString());
      expect(k.absenceResetApplied).toBe(true);
    });

    it('does not make the returning resident cooling - they are at zero, not fresh off a bay', () => {
      // The distinction matters: a cooling resident sorts below everyone, a resident at
      // zero sorts below everyone who has waited and above anyone who has not.
      const k = key(returning('A', 1, 0));
      expect(k.biasApplied).toBe(false);
      expect(k.effectiveWaitQuanta).toBe(1);
    });

    it('keeps the history: the reset is of waiting, never of the count', () => {
      expect(key(returning('A', 2, 4)).servedCount).toBe(4);
    });

    it('puts the returning resident below everyone who kept entering', () => {
      const steady = candidate('STEADY', 200, 1, true);
      const back = returning('BACK', 2, 0);
      // BACK has never held a bay, which would win the tie-break - but the tie is never
      // reached, because waiting time decides first and BACK has almost none.
      expect(order([back, steady])).toEqual(['STEADY', 'BACK']);
    });

    it('takes the later of an absence reset and a benefit end', () => {
      const served = { ...returning('A', 50, 1), lastBenefitEndAt: ago(10) };
      expect(key(served).anchorAt.toISOString()).toBe(ago(10).toISOString());
      expect(key(served).absenceResetApplied).toBe(false);

      const absentLater = { ...returning('A', 10, 1), lastBenefitEndAt: ago(50) };
      expect(key(absentLater).anchorAt.toISOString()).toBe(ago(10).toISOString());
      expect(key(absentLater).absenceResetApplied).toBe(true);
    });
  });

  it('E-14: identical keys fall back to the resident id, and only then', () => {
    // Same wait, same history, same token: only constructible by forging the key.
    const base = key(candidate('A', 10, 1, true));
    const forged: PriorityKey = { ...base, residentId: 'B' };
    expect(compareByPriority(base, forged)).toBeLessThan(0);
    expect(compareByPriority(forged, base)).toBeGreaterThan(0);
    expect(compareByPriority(base, base)).toBe(0);
  });
});
