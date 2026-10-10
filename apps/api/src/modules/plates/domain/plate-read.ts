/**
 * The module's entities and the invariants that hold them together.
 *
 * `PlateRead` is a capture: what the camera saw. `AccessEvent` is a decision: who was let
 * in. They are separate records because a mis-read has to be correctable without
 * rewriting the access log, and the access log has to be append-only.
 *
 * `resolveReview` is the review screen's rule, as a pure function: given the read as it
 * stands and what the administrator asserted, it returns the row to write and the
 * decision to log. The repository then applies both in one transaction. Keeping the rule
 * here is what makes "an ineligible resident cannot be waved through by a correction"
 * testable without a database.
 *
 * Pure: no I/O, no `async`.
 */

import { fail } from '../../../shared/errors';
import { ok, type Result } from '../../../shared/result';
import { normalizePlate, PLATE_PATTERN } from '../../residents/domain/vehicle';
import type {
  AccessDecision,
  DecisionReason,
  MatchKind,
  PlateReadStatus,
  RegisteredVehicle,
} from './access-decision';
import type { ScoredCandidate } from './plate-candidate';

export interface PlateRead {
  readonly id: string;
  /** The capture client's ULID. The idempotency key of the whole pipeline. */
  readonly captureId: string;
  readonly cameraId: string;
  readonly capturedAt: Date;
  readonly receivedAt: Date;
  /** The OCR line, verbatim. Null when the engine returned nothing at all. */
  readonly rawText: string | null;
  /** The canonical form. Null on an unreadable frame. */
  readonly plate: string | null;
  readonly confidence: number;
  readonly quality: number | null;
  /** confidence fused with quality, recomputed on read so it cannot drift from the two. */
  readonly fused: number;
  readonly status: PlateReadStatus;
  readonly vehicleId: string | null;
  readonly matchKind: MatchKind;
  readonly matchDistance: number | null;
  readonly candidates: readonly ScoredCandidate[];
  readonly imageKey: string;
  readonly cropKey: string | null;
  readonly engine: string;
  readonly engineVersion: string | null;
  readonly latencyMs: number | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: Date | null;
  readonly reviewNote: string | null;
  readonly correctedPlate: string | null;
}

export interface AccessEvent {
  readonly id: string;
  readonly plateReadId: string;
  readonly plate: string;
  readonly vehicleId: string | null;
  readonly residentId: string | null;
  readonly spotId: string | null;
  readonly decision: AccessDecision;
  readonly reason: string;
  readonly cameraId: string;
  readonly occurredAt: Date;
  readonly createdAt: Date;
  /** The id of the row that replaced this one. Null while this decision stands. */
  readonly supersededBy: string | null;
}

/** The gate log row, as the admin screen reads it: a read with its standing decision. */
export interface PlateReadWithDecision {
  readonly read: PlateRead;
  readonly decision: AccessEvent | null;
  /** Resolved for display only. The log itself keeps ids, not names. */
  readonly residentName: string | null;
  readonly spotCode: string | null;
  readonly registeredPlate: string | null;
  /**
   * The rest of what an administrator watching the barrier needs in front of them.
   *
   * The requirement this serves is "real-time vehicle detection using license plate
   * recognition cameras": a car arrives and the person on duty has to decide, in the few
   * seconds it takes to roll up to the barrier, whether it belongs there. A plate and a
   * name do not answer that - the car in the lane is a white Corolla or it is not, and
   * whether the resident holds a bay is the difference between waving them through and
   * sending them to the visitor lane. All of it is already joined for the same row; not
   * returning it only moved the question to a second request nobody had time to make.
   */
  readonly unitNumber: string | null;
  readonly vehicleMake: string | null;
  readonly vehicleModel: string | null;
  readonly vehicleYear: number | null;
  readonly vehicleColour: string | null;
}

export const REVIEW_NOTE_MAX_LENGTH = 2000;

/** What an administrator asserts on the review screen. */
export interface ReviewVerdict {
  /** The plate they say it really was. Absent means "I am not naming a plate". */
  readonly plate?: string | null;
  /** The vehicle they are attributing it to. Absent means "do not attribute it". */
  readonly vehicleId?: string | null;
  readonly decision: 'ALLOW' | 'DENY';
  readonly note?: string | null;
  /** Set when the administrator is discarding the frame rather than judging an entry. */
  readonly discard?: boolean;
}

/** What `resolveReview` decides should be written. */
export interface ResolvedReview {
  readonly status: PlateReadStatus;
  /** The canonical plate to store on the read. Null when none was named. */
  readonly plate: string | null;
  /** The administrator's assertion, stored separately: this is the evaluation label. */
  readonly correctedPlate: string | null;
  readonly vehicleId: string | null;
  readonly residentId: string | null;
  readonly spotId: string | null;
  readonly matchKind: MatchKind;
  readonly note: string | null;
  /** Null means: record the review, log no access event. */
  readonly decision: AccessDecision | null;
  readonly reason: DecisionReason;
}

/**
 * The review rule.
 *
 * Three things it refuses, and each one is a way a correction could otherwise launder a
 * decision the automatic path would have refused:
 *
 *   1. An ALLOW must name a plate. "Let it in, I am not saying what it was" produces an
 *      access log row that cannot be joined to anything and cannot be contested.
 *   2. A named vehicle must exist in the register and be active. An administrator
 *      attributing an entry to a removed car writes a row that points at nothing.
 *   3. An ALLOW for an ineligible resident is turned into a DENY with the eligibility
 *      reason, not refused outright. The administrator is not wrong about which car it
 *      was - they are wrong about whether it may enter - so the correct behaviour is to
 *      record the identification they got right and the decision the rule requires.
 *      Refusing the whole submission would leave the read unreviewed and the label lost.
 */
export function resolveReview(
  read: PlateRead,
  verdict: ReviewVerdict,
  register: readonly RegisteredVehicle[],
): Result<ResolvedReview> {
  if (read.reviewedAt !== null) {
    return fail('PLATE_READ_ALREADY_REVIEWED', 'This read has already been reviewed.');
  }

  const note = (verdict.note ?? '').trim();
  if (note.length > REVIEW_NOTE_MAX_LENGTH) {
    return fail('VALIDATION_FAILED', 'The review note is too long.', [
      { field: 'note', issue: `must be at most ${REVIEW_NOTE_MAX_LENGTH} characters` },
    ]);
  }

  // Discarding is "this frame is not an entry", so it never produces an access event and
  // never needs a plate. The image stays: it is still evidence of what the camera saw.
  if (verdict.discard === true) {
    return ok({
      status: 'DISCARDED',
      plate: read.plate,
      correctedPlate: null,
      vehicleId: null,
      residentId: null,
      spotId: null,
      matchKind: 'MANUAL',
      note: note.length > 0 ? note : null,
      decision: null,
      reason: 'UNREADABLE',
    });
  }

  const asserted = verdict.plate === undefined || verdict.plate === null
    ? null
    : normalizePlate(verdict.plate);
  if (asserted !== null && !PLATE_PATTERN.test(asserted)) {
    return fail('VALIDATION_FAILED', 'That is not a plate.', [
      { field: 'plate', issue: 'must be 2 to 20 letters and digits' },
    ]);
  }

  let vehicle: RegisteredVehicle | null = null;
  if (verdict.vehicleId !== undefined && verdict.vehicleId !== null) {
    vehicle = register.find((v) => v.vehicleId === verdict.vehicleId) ?? null;
    if (vehicle === null) {
      return fail('NOT_FOUND', 'That vehicle is not in the register.');
    }
    if (!vehicle.isActive) {
      return fail('VALIDATION_FAILED', 'That vehicle has been removed from the register.', [
        { field: 'vehicleId', issue: 'not an active registration' },
      ]);
    }
  } else if (asserted !== null) {
    // A plate with no vehicle id is still an identification: resolve it the way the gate
    // would, so the administrator does not have to know ids.
    vehicle = register.find((v) => v.isActive && v.plate === asserted) ?? null;
  }

  const plate = asserted ?? vehicle?.plate ?? null;

  if (verdict.decision === 'ALLOW' && plate === null) {
    return fail('VALIDATION_FAILED', 'Allowing an entry requires naming the plate.', [
      { field: 'plate', issue: 'required when the decision is ALLOW' },
    ]);
  }

  const identified = {
    plate,
    // The assertion, kept apart from the stored plate on purpose: `plate` is what the
    // read now says, `correctedPlate` is what a human swore to, and only the second is
    // usable as a ground-truth label.
    correctedPlate: asserted,
    vehicleId: vehicle?.vehicleId ?? null,
    residentId: vehicle?.residentId ?? null,
    spotId: vehicle?.spotId ?? null,
    matchKind: 'MANUAL' as MatchKind,
    note: note.length > 0 ? note : null,
  };

  if (verdict.decision === 'DENY') {
    return ok({
      ...identified,
      status: vehicle === null ? 'UNMATCHED' : 'MATCHED',
      decision: 'DENY',
      reason: vehicle === null ? 'PLATE_NOT_REGISTERED' : 'MANUAL_REVIEW',
    });
  }

  if (vehicle === null) {
    // ALLOW for a plate that is in no registration. Recorded as a manual override rather
    // than refused: a building may genuinely wave in a delivery van, and the log saying
    // so - with who said it and when - is better than no row at all.
    return ok({
      ...identified,
      status: 'UNMATCHED',
      decision: 'ALLOW',
      reason: 'MANUAL_REVIEW',
    });
  }

  if (!vehicle.residentIsEligible) {
    return ok({
      ...identified,
      status: 'MATCHED',
      decision: 'DENY',
      reason: 'RESIDENT_NOT_ELIGIBLE',
    });
  }

  return ok({ ...identified, status: 'MATCHED', decision: 'ALLOW', reason: 'MANUAL_REVIEW' });
}
