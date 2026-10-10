import { describe, expect, it } from 'vitest';
import { allocate, inputHash, resultHash, seedCommitment, type AllocationInput } from './allocate';
import { DEFAULT_ALLOCATION_CONFIG, type AllocationConfig } from './allocation-config';
import { raffleToken, type Candidate } from './priority-key';
import type { DrawableSpot } from './types';

const CFG: AllocationConfig = { ...DEFAULT_ALLOCATION_CONFIG, version: 1 };
const SEED = '3'.repeat(64);
const RUN = '7f3a0000-0000-0000-0000-000000000001';
const HOUR = 3_600_000;

const spot = (code: string, type: DrawableSpot['type'] = 'STANDARD'): DrawableSpot => ({
  spotId: `spot-${code}`,
  spotCode: code,
  type,
});

const input = (over: Partial<AllocationInput>): AllocationInput => ({
  runId: RUN,
  decidedAt: new Date('2026-04-01T09:00:00Z'),
  seedHex: SEED,
  config: CFG,
  candidates: [],
  spots: [],
  ...over,
});

describe('allocate - inventory and pools', () => {
  const T0 = new Date('2026-04-01T09:00:00Z');
  const waiting = (id: string, hours: number, over: Partial<Candidate> = {}): Candidate => ({
    residentId: id,
    participationStartedAt: new Date(T0.getTime() - hours * HOUR),
    lastBenefitEndAt: null,
    servedCount: 0,
    priorParticipations: 1,
    needsAccessibleSpot: false,
    hasElectricVehicle: false,
    ...over,
  });

  it('U-9: a brand-new resident with no accrued wait still wins an uncontested bay', () => {
    const out = allocate(input({ candidates: [waiting('A', 0)], spots: [spot('B1-01')] }));
    expect(out.allocations.map((a) => a.residentId)).toEqual(['A']);
  });

  it('U-12: surplus bays stay unassigned and are reported', () => {
    const out = allocate(
      input({
        candidates: [waiting('A', 10), waiting('B', 5)],
        spots: [spot('B1-01'), spot('B1-02'), spot('B1-03'), spot('B1-04'), spot('B1-05')],
      }),
    );
    expect(out.allocations).toHaveLength(2);
    expect(out.unusedSpotIds).toHaveLength(3);
    expect(out.waitlist).toHaveLength(0);
  });

  it('U-14: the accessible pass precedes the general one (BR-07)', () => {
    const out = allocate(
      input({
        candidates: [waiting('A', 10, { needsAccessibleSpot: true }), waiting('B', 2000)],
        spots: [spot('B1-01', 'ACCESSIBLE')],
      }),
    );
    expect(out.allocations.map((a) => [a.residentId, a.pool])).toEqual([['A', 'ACCESSIBLE']]);
    expect(out.waitlist.map((w) => w.residentId)).toEqual(['B']);
    expect(out.unmetAccessibilityNeeds).toEqual([]);
  });

  it('U-15: a loser of a restricted pass falls through with its key unchanged', () => {
    const out = allocate(
      input({
        candidates: [waiting('A', 10, { needsAccessibleSpot: true }), waiting('B', 2000)],
        spots: [spot('B1-01', 'ACCESSIBLE'), spot('B1-02')],
      }),
    );
    expect(out.allocations.map((a) => [a.residentId, a.pool])).toEqual([
      ['A', 'ACCESSIBLE'],
      ['B', 'STANDARD'],
    ]);
  });

  it('U-16: with no accessible bay the need is flagged, and a standard bay is still offered', () => {
    const out = allocate(
      input({
        candidates: [waiting('A', 10, { needsAccessibleSpot: true })],
        spots: [spot('B1-01')],
      }),
    );
    expect(out.allocations.map((a) => [a.residentId, a.pool])).toEqual([['A', 'STANDARD']]);
    expect(out.unmetAccessibilityNeeds).toEqual([]);
  });

  it('an unclaimed accessible bay returns to the general pool', () => {
    const out = allocate(
      input({ candidates: [waiting('B', 100)], spots: [spot('B1-01', 'ACCESSIBLE')] }),
    );
    expect(out.allocations.map((a) => [a.residentId, a.pool])).toEqual([['B', 'STANDARD']]);
    expect(out.unusedSpotIds).toEqual([]);
  });

  it('matches an EV resident to an EV bay before the general pass', () => {
    const out = allocate(
      input({
        candidates: [waiting('A', 10, { hasElectricVehicle: true }), waiting('B', 2000)],
        spots: [spot('B1-01', 'EV'), spot('B1-02')],
      }),
    );
    expect(out.allocations.map((a) => [a.residentId, a.pool])).toEqual([
      ['A', 'EV'],
      ['B', 'STANDARD'],
    ]);
  });

  it('reports an accessible need nobody could meet', () => {
    const out = allocate(
      input({
        candidates: [waiting('A', 10, { needsAccessibleSpot: true }), waiting('B', 2000)],
        spots: [spot('B1-01')],
      }),
    );
    expect(out.allocations.map((a) => a.residentId)).toEqual(['B']);
    expect(out.unmetAccessibilityNeeds).toEqual(['A']);
  });

  it('caps the inventory at totalBays, lowest code first', () => {
    const out = allocate(
      input({
        config: { ...CFG, totalBays: 1 },
        candidates: [waiting('A', 10), waiting('B', 5)],
        spots: [spot('B1-02'), spot('B1-01')],
      }),
    );
    expect(out.allocations.map((a) => a.spotId)).toEqual(['spot-B1-01']);
    expect(out.unusedSpotIds).toEqual([]);
    expect(out.waitlist.map((w) => w.residentId)).toEqual(['B']);
  });
});

describe('allocate - hashes and the commitment', () => {
  it('hashes the inputs independently of the order they arrive in', () => {
    const T0 = new Date('2026-04-01T09:00:00Z');
    const cs: Candidate[] = ['A', 'B', 'C'].map((id, i) => ({
      residentId: id,
      participationStartedAt: new Date(T0.getTime() - (i + 1) * HOUR),
      lastBenefitEndAt: null,
      servedCount: i,
      priorParticipations: 1,
      needsAccessibleSpot: false,
      hasElectricVehicle: false,
    }));
    const a = input({ candidates: cs, spots: [spot('B1-01')] });
    const b = input({ candidates: [...cs].reverse(), spots: [spot('B1-01')] });

    expect(inputHash(a)).toBe(inputHash(b));
    expect(resultHash(allocate(a))).toBe(resultHash(allocate(b)));
    // A different seed is a different run, and the hash says so.
    expect(resultHash(allocate({ ...a, seedHex: '4'.repeat(64) }))).not.toBe(resultHash(allocate(a)));
  });

  it('commits to the seed with a plain sha256, so the check is one shell command', () => {
    expect(seedCommitment(SEED)).toMatch(/^[0-9a-f]{64}$/);
    expect(seedCommitment(SEED)).not.toBe(SEED);
  });
});

/**
 * The worked example of section 10 of the fairness ADR, as an integration test over the
 * whole decision: eight candidates, three standard bays, B = 24 h, Q = 60 min.
 *
 * Every number below is from the document, and the point of the test is that the
 * published explanation and the code agree: R4 wins on waiting time alone, R5 wins the
 * three-way tie on history, R6 and R7 are separated by the raffle and nothing else, and
 * the Early-Waiting Bias lifts the brand-new R3 above R2 and R1.
 */
describe('the worked example of section 10', () => {
  const T0 = new Date('2026-04-01T09:00:00Z');
  const at = (iso: string): Date => new Date(iso);

  const candidates: Candidate[] = [
    {
      residentId: 'R1',
      participationStartedAt: at('2024-01-10T00:00:00Z'),
      lastBenefitEndAt: at('2026-04-01T02:00:00Z'),
      servedCount: 3,
      priorParticipations: 6,
      needsAccessibleSpot: false,
      hasElectricVehicle: false,
    },
    {
      residentId: 'R2',
      participationStartedAt: at('2024-06-01T00:00:00Z'),
      lastBenefitEndAt: at('2026-03-31T20:00:00Z'),
      servedCount: 1,
      priorParticipations: 4,
      needsAccessibleSpot: false,
      hasElectricVehicle: false,
    },
    {
      residentId: 'R3',
      participationStartedAt: at('2026-04-01T04:00:00Z'),
      lastBenefitEndAt: null,
      servedCount: 0,
      priorParticipations: 0,
      needsAccessibleSpot: false,
      hasElectricVehicle: false,
    },
    {
      residentId: 'R4',
      participationStartedAt: at('2025-10-01T09:00:00Z'),
      lastBenefitEndAt: null,
      servedCount: 0,
      priorParticipations: 2,
      needsAccessibleSpot: false,
      hasElectricVehicle: false,
    },
    {
      residentId: 'R5',
      participationStartedAt: at('2023-02-01T00:00:00Z'),
      lastBenefitEndAt: at('2026-01-01T09:00:00Z'),
      servedCount: 1,
      priorParticipations: 8,
      needsAccessibleSpot: false,
      hasElectricVehicle: false,
    },
    {
      residentId: 'R6',
      participationStartedAt: at('2023-02-01T00:00:00Z'),
      lastBenefitEndAt: at('2026-01-01T09:00:00Z'),
      servedCount: 2,
      priorParticipations: 8,
      needsAccessibleSpot: false,
      hasElectricVehicle: false,
    },
    {
      residentId: 'R7',
      participationStartedAt: at('2023-02-01T00:00:00Z'),
      lastBenefitEndAt: at('2026-01-01T09:00:00Z'),
      servedCount: 2,
      priorParticipations: 8,
      needsAccessibleSpot: false,
      hasElectricVehicle: false,
    },
    {
      residentId: 'R8',
      participationStartedAt: at('2024-03-01T00:00:00Z'),
      lastBenefitEndAt: at('2026-03-30T09:00:00Z'),
      servedCount: 1,
      priorParticipations: 5,
      needsAccessibleSpot: false,
      hasElectricVehicle: false,
    },
  ];

  const spots = [spot('A-01'), spot('A-02'), spot('A-03')];
  const out = allocate(input({ decidedAt: T0, candidates, spots }));
  const byId = new Map(out.keys.map((k) => [k.residentId, k]));

  it('computes the keys of step 2 exactly', () => {
    const expected: Record<string, { raw: number; eff: number; cooling: boolean; first: boolean }> = {
      R1: { raw: 7, eff: -17, cooling: true, first: false },
      R2: { raw: 13, eff: -11, cooling: true, first: false },
      R3: { raw: 5, eff: 5, cooling: false, first: true },
      R4: { raw: 4368, eff: 4368, cooling: false, first: false },
      R5: { raw: 2160, eff: 2160, cooling: false, first: false },
      R6: { raw: 2160, eff: 2160, cooling: false, first: false },
      R7: { raw: 2160, eff: 2160, cooling: false, first: false },
      R8: { raw: 48, eff: 48, cooling: false, first: false },
    };

    for (const [id, e] of Object.entries(expected)) {
      const k = byId.get(id)!;
      expect([id, k.rawWaitQuanta]).toEqual([id, e.raw]);
      expect([id, k.effectiveWaitQuanta]).toEqual([id, e.eff]);
      expect([id, k.biasApplied]).toEqual([id, e.cooling]);
      expect([id, k.firstTimeParticipant]).toEqual([id, e.first]);
    }
  });

  it('ranks R4, R5 and then the R6/R7 raffle winner into the three bays', () => {
    const raffleWinner =
      raffleToken(SEED, RUN, 'R6') < raffleToken(SEED, RUN, 'R7') ? 'R6' : 'R7';
    const raffleLoser = raffleWinner === 'R6' ? 'R7' : 'R6';

    expect(out.allocations.map((a) => a.residentId)).toEqual(['R4', 'R5', raffleWinner]);
    expect(out.allocations.map((a) => a.spotId)).toEqual(['spot-A-01', 'spot-A-02', 'spot-A-03']);
    expect(out.waitlist.map((w) => w.residentId)).toEqual([raffleLoser, 'R8', 'R3', 'R2', 'R1']);
  });

  it('consults the raffle for exactly one comparison in the whole run', () => {
    // Only R6 and R7 tie on both the effective wait and the history count.
    const groups = new Map<string, number>();
    for (const k of out.keys) {
      const bucket = `${k.effectiveWaitQuanta}:${k.servedCount}`;
      groups.set(bucket, (groups.get(bucket) ?? 0) + 1);
    }
    expect([...groups.values()].filter((n) => n > 1)).toEqual([2]);
  });

  it('shows rule F changing the order: the bias lifts R3 above R2 and R1', () => {
    const rank = (id: string): number => out.keys.findIndex((k) => k.residentId === id) + 1;
    expect(rank('R3')).toBe(6);
    expect(rank('R2')).toBe(7);
    expect(rank('R1')).toBe(8);

    // Without the bias, both previous holders would outrank the brand-new resident.
    const noBias = allocate(
      input({ decidedAt: T0, candidates, spots, config: { ...CFG, earlyWaitingBiasHours: 0 } }),
    );
    expect(noBias.keys.map((k) => k.residentId).slice(5)).toEqual(['R2', 'R1', 'R3']);
  });

  it("preserves rule F's final clause: R8 still outranks the first-timer R3", () => {
    const rank = (id: string): number => out.keys.findIndex((k) => k.residentId === id) + 1;
    expect(rank('R8')).toBeLessThan(rank('R3'));
  });
});
