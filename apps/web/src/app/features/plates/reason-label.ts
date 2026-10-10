import type { AccessReason } from '../../domain/models';

/**
 * The reason codes, in English, in one place.
 *
 * The server sends a code and never a sentence, which is the opposite of what the
 * fairness explanation does - and deliberately so. The fairness sentence arrives as
 * finished prose and is therefore the one string in the product that cannot be translated
 * without changing the contract; that is written down as a design debt in the README. The
 * plates module does not repeat the mistake: a code plus a lookup is what Transloco will
 * need when the Spanish half is wired, and until then this map is the only place the
 * wording lives.
 */
export const REASON_LABEL: Readonly<Record<AccessReason, string>> = {
  EXACT_MATCH: 'Plate matched exactly',
  FUZZY_MATCH_SINGLE: 'Matched one registered plate, one character out',
  FUZZY_MATCH_AMBIGUOUS: 'Two registered plates equally close',
  PLATE_NOT_REGISTERED: 'Plate is not registered',
  LOW_CONFIDENCE: 'Read too uncertain to act on',
  UNREADABLE: 'Nothing readable in the frame',
  RESIDENT_NOT_ELIGIBLE: 'Resident is not eligible',
  VEHICLE_INACTIVE: 'Vehicle was removed from the register',
  DUPLICATE_WITHIN_COOLDOWN: 'Same car again within 30 seconds',
  MANUAL_REVIEW: 'Decided by an administrator',
};

/** The one-word outcome a row shows, with the tone the status pill uses. */
export const DECISION_LABEL: Readonly<Record<string, string>> = {
  ALLOW: 'Allowed',
  DENY: 'Denied',
  REVIEW: 'Needs review',
};
