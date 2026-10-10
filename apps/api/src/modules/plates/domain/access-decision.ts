/**
 * The access decision table of MODULO-PLACAS.md section 5, as one pure function.
 *
 * `decide()` takes everything it needs as values - the best candidate, the crop quality,
 * the registered vehicles, whether the cooldown is active, the thresholds in force - and
 * returns what to write. No database, no clock, no `async`. That is what lets the entire
 * threshold table be verified by table tests in milliseconds, the same argument that makes
 * the allocation engine testable 10 000 times without touching the cloud.
 *
 * It is also what makes the thresholds recalibratable: they arrive as a parameter, read
 * from `allocation_config` by the caller, so moving 0.85 is an UPDATE and not a deploy.
 */

import { fuseConfidence, type ScoredCandidate } from './plate-candidate';
import { MIN_ACCEPTABLE_SCORE } from './bolivian-format';
import { findFuzzyMatches, type FuzzyMatch } from './plate-fuzzy';

export type PlateReadStatus = 'MATCHED' | 'UNMATCHED' | 'REVIEW' | 'DISCARDED';
export type MatchKind = 'EXACT' | 'FUZZY' | 'MANUAL' | 'NONE';
export type AccessDecision = 'ALLOW' | 'DENY' | 'REVIEW';

/** Stable codes. The frontend translates them; none of them is prose. */
export type DecisionReason =
  | 'EXACT_MATCH'
  | 'FUZZY_MATCH_SINGLE'
  | 'FUZZY_MATCH_AMBIGUOUS'
  | 'PLATE_NOT_REGISTERED'
  | 'LOW_CONFIDENCE'
  | 'UNREADABLE'
  | 'RESIDENT_NOT_ELIGIBLE'
  | 'VEHICLE_INACTIVE'
  | 'DUPLICATE_WITHIN_COOLDOWN'
  | 'MANUAL_REVIEW';

export const DECISION_REASONS: readonly DecisionReason[] = [
  'EXACT_MATCH',
  'FUZZY_MATCH_SINGLE',
  'FUZZY_MATCH_AMBIGUOUS',
  'PLATE_NOT_REGISTERED',
  'LOW_CONFIDENCE',
  'UNREADABLE',
  'RESIDENT_NOT_ELIGIBLE',
  'VEHICLE_INACTIVE',
  'DUPLICATE_WITHIN_COOLDOWN',
  'MANUAL_REVIEW',
];

/** A row of the vehicle register, as the gate lookup returns it. */
export interface RegisteredVehicle {
  readonly vehicleId: string;
  readonly residentId: string;
  /** The canonical form, exactly as stored in `vehicle.plate`. */
  readonly plate: string;
  readonly isActive: boolean;
  readonly residentIsEligible: boolean;
  /** The bay the resident holds in the period in force, if any. For the log, not the gate. */
  readonly spotId?: string | null;
}

export interface Thresholds {
  /** Automatic ALLOW at or above this fused confidence. */
  readonly minFused: number;
  /** Below this the read is unreadable and produces no access event at all. */
  readonly reviewFused: number;
  /** The largest edit distance a lone fuzzy match may have and still open the gate. */
  readonly maxFuzzyDistance: number;
}

/**
 * The starting point, and honestly labelled as one: 0.85 and 0.55 are not measurements.
 * Section 8 of MODULO-PLACAS.md is the calibration procedure that replaces them with
 * numbers from this building's own cameras, and `allocation_config` is where the result
 * goes so no deploy is needed to move them.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  minFused: 0.85,
  reviewFused: 0.55,
  maxFuzzyDistance: 1,
};

export interface DecisionInput {
  readonly best: ScoredCandidate | null;
  readonly quality: number | null;
  readonly registered: readonly RegisteredVehicle[];
  readonly withinCooldown: boolean;
  readonly thresholds?: Thresholds;
}

export interface Decision {
  readonly status: PlateReadStatus;
  /** `null` means: record the read, create NO access event. */
  readonly decision: AccessDecision | null;
  readonly reason: DecisionReason;
  readonly matchKind: MatchKind;
  readonly fused: number;
  readonly plate: string | null;
  readonly vehicleId: string | null;
  readonly residentId: string | null;
  readonly spotId: string | null;
  readonly matchDistance: number | null;
  /** Populated on FUZZY_MATCH_AMBIGUOUS, so the review screen can show the choice. */
  readonly ambiguousWith: readonly string[];
}

/**
 * The table, in order. The order is the function:
 *
 *   cooldown -> unreadable -> exact -> fuzzy -> unmatched
 *
 * Eligibility and vehicle state are checked only AFTER a plate has been identified,
 * because "not eligible" is a statement about a known resident, not about a blur.
 *
 * Three of the rows are worth defending, because each one is a place where the obvious
 * choice is wrong:
 *
 *   - **An unreadable frame produces no access event.** A DENY there would fill the log
 *     with refusals belonging to nobody and make the denial metric meaningless - it would
 *     measure lens dirt. The frame is still recorded, because a camera that reads nothing
 *     for a day is a fault the review queue should surface.
 *   - **An ambiguous fuzzy match never opens.** If two registered plates are equally
 *     close to the read, opening means picking at random whose entry this was, and the
 *     log would then assert something untrue.
 *   - **A clear read that is not registered is DENY, not REVIEW.** It is a visitor or an
 *     intruder: a fact, not a doubt. A visitor lane is a separate feature - a temporary
 *     plate with an expiry - and not a loosened threshold.
 */
export function decide(input: DecisionInput): Decision {
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const best = input.best;
  const fused = best === null ? 0 : fuseConfidence(best.confidence, input.quality);

  const base = {
    fused,
    plate: best?.plate ?? null,
    vehicleId: null,
    residentId: null,
    spotId: null,
    matchDistance: null,
    ambiguousWith: [] as readonly string[],
  };

  // A car creeping towards the barrier is one arrival, not twenty. Only the access event
  // is suppressed; the frame stays as evidence.
  if (input.withinCooldown) {
    return {
      ...base,
      status: 'DISCARDED',
      decision: null,
      reason: 'DUPLICATE_WITHIN_COOLDOWN',
      matchKind: 'NONE',
    };
  }

  if (best === null || best.score < MIN_ACCEPTABLE_SCORE || fused < t.reviewFused) {
    return { ...base, status: 'REVIEW', decision: null, reason: 'UNREADABLE', matchKind: 'NONE' };
  }

  /*
   * The ACTIVE registration of that plate wins, and only then a removed one.
   *
   * There can be more than one row for a plate: uniqueness in the register is partial on
   * is_active, deliberately, so that a car sold to a neighbour or a registration removed
   * by mistake can be registered again. `find` took whichever row the query happened to
   * return first, so a plate with any history was denied at the barrier with
   * VEHICLE_INACTIVE while its current owner's registration sat in the same list, active.
   * VEHICLE_INACTIVE must mean "this plate's registration was removed", not "a previous
   * one was".
   */
  const exactRows = input.registered.filter((v) => v.plate === best.plate);
  const exact = exactRows.find((v) => v.isActive) ?? exactRows[0];
  if (exact !== undefined) {
    const identified = {
      ...base,
      plate: exact.plate,
      vehicleId: exact.vehicleId,
      residentId: exact.residentId,
      spotId: exact.spotId ?? null,
      matchDistance: 0,
      matchKind: 'EXACT' as MatchKind,
    };
    if (!exact.isActive) {
      return { ...identified, status: 'UNMATCHED', decision: 'DENY', reason: 'VEHICLE_INACTIVE' };
    }
    if (!exact.residentIsEligible) {
      return {
        ...identified,
        status: 'MATCHED',
        decision: 'DENY',
        reason: 'RESIDENT_NOT_ELIGIBLE',
      };
    }
    if (fused < t.minFused) {
      // Identified, but not confidently enough to open on its own. An administrator
      // confirms in one click, and that confirmation becomes a labelled sample.
      return { ...identified, status: 'REVIEW', decision: 'REVIEW', reason: 'LOW_CONFIDENCE' };
    }
    return { ...identified, status: 'MATCHED', decision: 'ALLOW', reason: 'EXACT_MATCH' };
  }

  // No exact hit. Only now is the fuzzy pass worth its cost.
  const active = input.registered.filter((v) => v.isActive);
  const fuzzy: FuzzyMatch[] = findFuzzyMatches(
    best.plate,
    active.map((v) => v.plate),
    t.maxFuzzyDistance,
  );
  const nearest = fuzzy.filter((m) => m.distance === fuzzy[0]?.distance);

  if (nearest.length > 1) {
    return {
      ...base,
      status: 'REVIEW',
      decision: 'REVIEW',
      reason: 'FUZZY_MATCH_AMBIGUOUS',
      matchKind: 'FUZZY',
      matchDistance: nearest[0]?.distance ?? null,
      ambiguousWith: nearest.map((m) => m.plate),
    };
  }

  if (nearest.length === 1) {
    const hit = nearest[0] as FuzzyMatch;
    const vehicle = active.find((v) => v.plate === hit.plate) as RegisteredVehicle;
    const identified = {
      ...base,
      plate: vehicle.plate,
      vehicleId: vehicle.vehicleId,
      residentId: vehicle.residentId,
      spotId: vehicle.spotId ?? null,
      matchDistance: hit.distance,
      matchKind: 'FUZZY' as MatchKind,
    };
    if (!vehicle.residentIsEligible) {
      return {
        ...identified,
        status: 'MATCHED',
        decision: 'DENY',
        reason: 'RESIDENT_NOT_ELIGIBLE',
      };
    }
    if (fused < t.minFused) {
      return { ...identified, status: 'REVIEW', decision: 'REVIEW', reason: 'LOW_CONFIDENCE' };
    }
    return { ...identified, status: 'MATCHED', decision: 'ALLOW', reason: 'FUZZY_MATCH_SINGLE' };
  }

  if (fused < t.minFused) {
    return { ...base, status: 'REVIEW', decision: 'REVIEW', reason: 'LOW_CONFIDENCE', matchKind: 'NONE' };
  }

  return {
    ...base,
    status: 'UNMATCHED',
    decision: 'DENY',
    reason: 'PLATE_NOT_REGISTERED',
    matchKind: 'NONE',
  };
}

/** Whether a read in this state still needs a human to look at it. */
export const needsReview = (status: PlateReadStatus, reviewedAt: Date | null): boolean =>
  status === 'REVIEW' && reviewedAt === null;
