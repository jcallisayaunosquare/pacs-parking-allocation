import { fail } from '../../../shared/errors';
import { ok, type Result } from '../../../shared/result';

/**
 * The vehicle register's domain ring: pure TypeScript, no I/O, no `async`.
 *
 * This file owns one thing the rest of the system depends on being stable: the
 * definition of what two plates being "the same plate" means. A camera at the gate
 * reads a plate, the plates module normalises it with `normalizePlate`, and the lookup
 * either matches a registered vehicle or does not. The uniqueness index in the database
 * is keyed on the same function's output, so "already registered" and "recognised at
 * the gate" cannot disagree.
 */

export interface Vehicle {
  readonly id: string;
  readonly residentId: string;
  /** The canonical form: uppercase, no separators, confusables folded. The lookup key. */
  readonly plate: string;
  /** What the resident typed, trimmed and uppercased. What the register shows them. */
  readonly plateDisplay: string;
  readonly make: string | null;
  readonly model: string | null;
  readonly year: number | null;
  readonly colour: string | null;
  readonly notes: string | null;
  /**
   * Object keys or URLs, in the order the resident added them. There is no upload
   * pipeline behind this: an S3 presigned PUT per photo is the intended follow-up, and
   * until that exists the API stores the strings it is given and hosts nothing.
   */
  readonly photos: readonly string[];
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The fields a caller may set when registering a vehicle. */
export interface VehicleInput {
  readonly plate: string;
  readonly make?: string | null;
  readonly model?: string | null;
  readonly year?: number | null;
  readonly colour?: string | null;
  readonly notes?: string | null;
  readonly photos?: readonly string[];
}

/** The same fields, as a partial edit. Absent means "leave as it is". */
export type VehiclePatch = Partial<VehicleInput>;

/** What validation hands the repository: every field settled, nothing left to guess. */
export interface NormalizedVehicle {
  readonly plate: string;
  readonly plateDisplay: string;
  readonly make: string | null;
  readonly model: string | null;
  readonly year: number | null;
  readonly colour: string | null;
  readonly notes: string | null;
  readonly photos: readonly string[];
}

export const PLATE_MIN_LENGTH = 2;
export const PLATE_MAX_LENGTH = 20;
export const PLATE_PATTERN = /^[A-Z0-9]{2,20}$/;

/** No car on the road predates this, and no model year is more than one ahead of now. */
export const YEAR_MIN = 1900;

export const MAKE_MAX_LENGTH = 80;
export const MODEL_MAX_LENGTH = 80;
export const COLOUR_MAX_LENGTH = 40;
export const NOTES_MAX_LENGTH = 2000;
export const PHOTOS_MAX = 8;
export const PHOTO_KEY_MAX_LENGTH = 512;

/**
 * The confusable-glyph folding rule, in full.
 *
 * Folded, in both directions, to the digit:
 *
 *   O -> 0      Q -> 0      I -> 1
 *
 * And nothing else. The reasoning, because the temptation is to fold more:
 *
 * These three are the glyph pairs that are genuinely indistinguishable rather than
 * merely similar. In every plate face in use they differ by a hairline or not at all, a
 * person transcribing their own plate picks whichever they think it is, and an OCR pass
 * does the same. Treating "ABC0I2" and "ABCO12" as different plates would mean the gate
 * refuses a car that is registered, which is the failure this register exists to prevent.
 *
 * The pairs deliberately NOT folded are S/5, B/8, Z/2, G/6 and D/0. They are real OCR
 * confusions, but the cost here is asymmetric: folding them makes "BS12" and "8512"
 * collide, so a resident is told their plate is already registered to someone else when
 * it is not, and there is no action they can take about it. A miss at the gate is
 * recoverable - the recognition module has a confidence score and a fallback - while a
 * false collision in the register is a refusal with no way through. Fuzzy matching
 * belongs where that score exists, not in a uniqueness key.
 *
 * Folding is idempotent: `normalizePlate(normalizePlate(x)) === normalizePlate(x)`,
 * which matters because the stored column is already folded and is re-normalised on
 * every lookup.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  O: '0',
  Q: '0',
  I: '1',
};

/**
 * A plate in its canonical form.
 *
 * In order: strip diacritics (a plate is ASCII, and "Ñ" typed on a Spanish keyboard
 * should not become a different plate from "N"), drop everything that is not a letter
 * or a digit, uppercase, then fold the confusables above. Returns '' for input with no
 * alphanumeric content at all, which `validateVehicle` reports as a field error rather
 * than storing.
 */
export function normalizePlate(raw: string): string {
  const stripped = raw
    .normalize('NFD')
    // Combining marks: the second half of a decomposed accented letter.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^0-9a-zA-Z]/g, '')
    .toUpperCase();

  let out = '';
  for (const ch of stripped) out += CONFUSABLES[ch] ?? ch;
  return out;
}

/**
 * The plate as the resident should see it: their own punctuation kept, uppercased.
 *
 * Only the characters a plate is actually written with survive, so a pasted URL or a
 * line of prose cannot end up in the register as a display string.
 */
export function displayPlate(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^0-9a-zA-Z \-.]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()
    .slice(0, PLATE_MAX_LENGTH);
}

/** Whether a recognised plate and a registered one are the same plate. */
export const platesMatch = (a: string, b: string): boolean =>
  normalizePlate(a) === normalizePlate(b) && normalizePlate(a).length > 0;

const trimToNull = (v: string | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

/**
 * A colour is a word, not free text: letters, spaces, hyphens and slashes, which covers
 * "Dark blue", "Off-white" and "Black/grey". Bounded because it is printed in a table
 * column, and restricted because a colour field is the easiest place in a register to
 * paste something that is not a colour.
 */
const COLOUR_PATTERN = /^[\p{L} \-/]+$/u;

type Issue = { field: string; issue: string };

/** The upper bound on a model year: next year's models are on sale this year. */
export const maxYear = (now: Date): number => now.getUTCFullYear() + 1;

/**
 * Validates and normalises a registration. Pure: the current instant is passed in
 * rather than read, so the year bound is testable and the ring stays I/O-free.
 */
export function validateVehicle(input: VehicleInput, now: Date): Result<NormalizedVehicle> {
  const issues: Issue[] = [];

  const plate = normalizePlate(input.plate ?? '');
  if (plate.length === 0) {
    issues.push({ field: 'plate', issue: 'required' });
  } else if (!PLATE_PATTERN.test(plate)) {
    issues.push({
      field: 'plate',
      issue: `must be ${PLATE_MIN_LENGTH} to ${PLATE_MAX_LENGTH} letters and digits`,
    });
  }

  const make = trimToNull(input.make);
  if (make && make.length > MAKE_MAX_LENGTH) {
    issues.push({ field: 'make', issue: `must be at most ${MAKE_MAX_LENGTH} characters` });
  }

  const model = trimToNull(input.model);
  if (model && model.length > MODEL_MAX_LENGTH) {
    issues.push({ field: 'model', issue: `must be at most ${MODEL_MAX_LENGTH} characters` });
  }

  const year = input.year ?? null;
  if (year !== null) {
    const ceiling = maxYear(now);
    if (!Number.isInteger(year) || year < YEAR_MIN || year > ceiling) {
      issues.push({ field: 'year', issue: `must be a whole year between ${YEAR_MIN} and ${ceiling}` });
    }
  }

  const colour = trimToNull(input.colour);
  if (colour !== null) {
    if (colour.length > COLOUR_MAX_LENGTH) {
      issues.push({ field: 'colour', issue: `must be at most ${COLOUR_MAX_LENGTH} characters` });
    } else if (!COLOUR_PATTERN.test(colour)) {
      issues.push({ field: 'colour', issue: 'must be a colour name, with no digits or punctuation' });
    }
  }

  const notes = trimToNull(input.notes);
  if (notes && notes.length > NOTES_MAX_LENGTH) {
    issues.push({ field: 'notes', issue: `must be at most ${NOTES_MAX_LENGTH} characters` });
  }

  const photos = (input.photos ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
  if (photos.length > PHOTOS_MAX) {
    issues.push({ field: 'photos', issue: `at most ${PHOTOS_MAX} photos` });
  }
  if (photos.some((p) => p.length > PHOTO_KEY_MAX_LENGTH)) {
    issues.push({
      field: 'photos',
      issue: `each key must be at most ${PHOTO_KEY_MAX_LENGTH} characters`,
    });
  }

  if (issues.length > 0) {
    return fail('VALIDATION_FAILED', 'The vehicle failed validation.', issues);
  }

  return ok({
    plate,
    plateDisplay: displayPlate(input.plate) || plate,
    make,
    model,
    year,
    colour,
    notes,
    photos,
  });
}

/**
 * Validates an edit against the vehicle as it stands. Absent fields keep their stored
 * value, so one changed field is one changed field - sending the rest back unchanged
 * would claim they were edited too.
 */
export function validateVehiclePatch(
  current: Vehicle,
  patch: VehiclePatch,
  now: Date,
): Result<NormalizedVehicle> {
  return validateVehicle(
    {
      plate: patch.plate ?? current.plateDisplay,
      make: patch.make === undefined ? current.make : patch.make,
      model: patch.model === undefined ? current.model : patch.model,
      year: patch.year === undefined ? current.year : patch.year,
      colour: patch.colour === undefined ? current.colour : patch.colour,
      notes: patch.notes === undefined ? current.notes : patch.notes,
      photos: patch.photos === undefined ? current.photos : patch.photos,
    },
    now,
  );
}
