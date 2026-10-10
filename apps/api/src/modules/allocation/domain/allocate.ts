import { createHash } from 'node:crypto';
import type { AllocationConfig } from './allocation-config';
import {
  compareByPriority,
  computePriorityKey,
  type Candidate,
  type PriorityKey,
} from './priority-key';
import type { DrawableSpot, PoolName } from './types';

export interface AllocationInput {
  readonly runId: string;
  /** Frozen once per run. Every key is computed against this one instant. */
  readonly decidedAt: Date;
  readonly seedHex: string;
  readonly config: AllocationConfig;
  readonly candidates: readonly Candidate[];
  readonly spots: readonly DrawableSpot[];
}

export interface Allocation {
  readonly residentId: string;
  readonly spotId: string;
  readonly pool: PoolName;
  readonly rankInPool: number;
}

export interface AllocationOutcome {
  readonly algorithmVersion: string;
  readonly allocations: readonly Allocation[];
  /** Non-winners in the same order, with the same tokens - there is no second raffle. */
  readonly waitlist: readonly { residentId: string; position: number }[];
  /** Persisted verbatim: this is the contestable record. */
  readonly keys: readonly PriorityKey[];
  readonly unmetAccessibilityNeeds: readonly string[];
  readonly unusedSpotIds: readonly string[];
}

const bySpotCode = (a: DrawableSpot, b: DrawableSpot): number =>
  a.spotCode < b.spotCode ? -1 : a.spotCode > b.spotCode ? 1 : 0;

/**
 * Restricted pools first, then everything else, preserving BR-07. A resident who loses a
 * restricted pass falls through to the general pass with their key unchanged, and a
 * restricted spot nobody claimed returns to the general pool - an empty accessible bay is
 * worse than a standard-need resident parking in it.
 */
const PASSES: readonly {
  name: PoolName;
  admits: (c: Candidate) => boolean;
  accepts: (s: DrawableSpot) => boolean;
}[] = [
  { name: 'ACCESSIBLE', admits: (c) => c.needsAccessibleSpot, accepts: (s) => s.type === 'ACCESSIBLE' },
  { name: 'EV', admits: (c) => c.hasElectricVehicle, accepts: (s) => s.type === 'EV' },
  { name: 'STANDARD', admits: () => true, accepts: () => true },
];

export const ALGORITHM_VERSION = 'waiting-time-fairness-v1';

/**
 * UC-05's decision step. Pure and synchronous: no clock, no RNG, no I/O - the instant and
 * the seed are inputs. The same (candidates, spots, config, seed, decidedAt) always
 * yields the same output, including under a reshuffled input array, which is what lets a
 * run be replayed and contested.
 *
 * One sort does everything: the raffle is not a separate step, it is the third key, so
 * rule E's "a raffle among only those residents of equal priority" cannot be got wrong -
 * the cut line falls inside the tied group and the tied group is already in uniformly
 * random order.
 */
export function allocate(input: AllocationInput): AllocationOutcome {
  const { runId, decidedAt, seedHex, config, candidates } = input;

  // Rule A: the HOA declares how many bays the scheme allocates. 0 means "the whole
  // active inventory"; a positive value caps it deterministically, lowest code first, so
  // taking a bay out of the scheme is a config change rather than an inventory edit.
  const spots =
    config.totalBays > 0
      ? [...input.spots].sort(bySpotCode).slice(0, config.totalBays)
      : [...input.spots];

  const keys = new Map<string, PriorityKey>(
    candidates.map((c) => [c.residentId, computePriorityKey(c, config, decidedAt, seedHex, runId)]),
  );

  const allocations: Allocation[] = [];
  const assigned = new Set<string>();
  const taken = new Set<string>();

  for (const pass of PASSES) {
    const ranked = candidates
      .filter((c) => !assigned.has(c.residentId) && pass.admits(c))
      .map((c) => keys.get(c.residentId)!)
      .sort(compareByPriority);

    // Spot order is deterministic and non-random: which bay you get is not a lottery,
    // only whether you get one is.
    const open = spots.filter((s) => !taken.has(s.spotId) && pass.accepts(s)).sort(bySpotCode);

    for (let i = 0; i < Math.min(ranked.length, open.length); i++) {
      const key = ranked[i]!;
      const spot = open[i]!;
      allocations.push({
        residentId: key.residentId,
        spotId: spot.spotId,
        pool: pass.name,
        rankInPool: i + 1,
      });
      assigned.add(key.residentId);
      taken.add(spot.spotId);
    }
  }

  const waitlist = candidates
    .filter((c) => !assigned.has(c.residentId))
    .map((c) => keys.get(c.residentId)!)
    .sort(compareByPriority)
    .map((k, i) => ({ residentId: k.residentId, position: i + 1 }));

  return {
    algorithmVersion: ALGORITHM_VERSION,
    allocations,
    waitlist,
    keys: [...keys.values()].sort(compareByPriority),
    unmetAccessibilityNeeds: candidates
      .filter((c) => c.needsAccessibleSpot && !assigned.has(c.residentId))
      .map((c) => c.residentId),
    unusedSpotIds: spots.filter((s) => !taken.has(s.spotId)).map((s) => s.spotId),
  };
}

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** sha256(seed), published when registration closes and revealed with the result. */
export const seedCommitment = (seedHex: string): string => sha256Hex(seedHex);

/**
 * A canonical hash of everything the decision was made from, so nobody can edit the
 * inputs after the fact and claim the same run. Candidates and spots are sorted by id
 * first, so the hash does not depend on the order the snapshot query happened to return.
 */
export function inputHash(input: AllocationInput): string {
  const canonical = JSON.stringify({
    runId: input.runId,
    decidedAt: input.decidedAt.toISOString(),
    config: input.config,
    candidates: [...input.candidates]
      .sort((a, b) => (a.residentId < b.residentId ? -1 : 1))
      .map((c) => [
        c.residentId,
        c.participationStartedAt.toISOString(),
        c.lastBenefitEndAt?.toISOString() ?? null,
        c.servedCount,
        c.priorParticipations,
        c.needsAccessibleSpot,
        c.hasElectricVehicle,
      ]),
    spots: [...input.spots]
      .sort((a, b) => (a.spotId < b.spotId ? -1 : 1))
      .map((s) => [s.spotId, s.spotCode, s.type]),
  });
  return sha256Hex(canonical);
}

/** One value a resident or an auditor can compare against their own replay. */
export function resultHash(outcome: AllocationOutcome): string {
  const canonical = JSON.stringify({
    algorithmVersion: outcome.algorithmVersion,
    allocations: outcome.allocations.map((a) => [a.residentId, a.spotId, a.pool, a.rankInPool]),
    waitlist: outcome.waitlist.map((w) => [w.residentId, w.position]),
    keys: outcome.keys.map((k) => [
      k.residentId,
      k.effectiveWaitQuanta,
      k.servedCount,
      k.raffleToken.toString(),
    ]),
  });
  return sha256Hex(canonical);
}
