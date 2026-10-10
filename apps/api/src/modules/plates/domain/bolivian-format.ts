/**
 * Bolivian plate formats, the scene blocklist, and the candidate score built on them.
 *
 * Rekognition's `DetectText` is a scene OCR: it reads every string in the frame and has
 * no idea which one is a plate. This file is the plate detector, and it works by shape -
 * a line that matches a Bolivian series, carries digits and is the right length scores
 * like a plate; the building's name on the wall does not. That is why the format table
 * and the blocklist are load-bearing rather than cosmetic, and why they are tested.
 *
 * The scoring shape (additive bonuses for confidence, length, digit presence, a format
 * pattern, and a scene-word blocklist) is the one idea taken from CarVision's candidate
 * scorer. The patterns and the list are ours: CarVision's are Israeli, and its own
 * normaliser strips a trailing "P", which would mutilate any Bolivian plate ending in P.
 *
 * WHAT STILL HAS TO BE CONFIRMED: the series below are taken from the "placa unica"
 * scheme and the legacy series still on the road. They have to be checked against the
 * building's real vehicle register before the thresholds are calibrated, and in
 * production the table belongs in `allocation_config` so adding a series the building
 * actually owns is an UPDATE rather than a deploy. They are constants here because the
 * recogniser runs outside the VPC and cannot read the database; the ingest side reads the
 * configured values and the constants are its cold-start default.
 *
 * Pure: no I/O, no `async`.
 */

import { normalizePlate } from '../../residents/domain/vehicle';

export interface PlateFormat {
  readonly name: string;
  readonly pattern: RegExp;
  readonly bonus: number;
}

export const BOLIVIAN_FORMATS: readonly PlateFormat[] = [
  /** "Placa unica", in force since 2010: four digits then three letters. */
  { name: 'UNICA_4_3', pattern: /^\d{4}[A-Z]{3}$/, bonus: 100 },
  /** The short series of the same scheme. */
  { name: 'UNICA_3_3', pattern: /^\d{3}[A-Z]{3}$/, bonus: 80 },
  /** Motorcycles. */
  { name: 'MOTO', pattern: /^\d{3,4}[A-Z]{2}$/, bonus: 60 },
  /** The pre-"placa unica" series still in circulation. */
  { name: 'LEGACY_3_3', pattern: /^[A-Z]{3}\d{3}$/, bonus: 40 },
  /** A check digit read as part of the text. */
  { name: 'WITH_CHECK_DIGIT', pattern: /^\d{3,4}[A-Z]{3}\d$/, bonus: 30 },
];

/** The length window a Bolivian plate falls in once separators are gone. */
export const PLATE_MIN_LENGTH = 5;
export const PLATE_MAX_LENGTH = 8;

/**
 * Words a gate camera genuinely reads: signage, not plates.
 *
 * Folded through `normalizePlate` at load rather than written pre-folded by hand.
 * "PARQUEO" canonicalises to "PAR0UE0" - both Q and O become zero - and a hand-folded
 * entry that got one of them wrong is a silent hole in the list. `foldBlocklist` is
 * exported so an environment-variable override is folded the same way.
 */
export const foldBlocklist = (words: readonly string[]): readonly string[] =>
  words.map(normalizePlate).filter((w) => w.length > 0);

export const DEFAULT_BLOCKLIST: readonly string[] = foldBlocklist([
  'PARQUEO',
  'PRIVADO',
  'VISITAS',
  'SALIDA',
  'ENTRADA',
  'RESERVADO',
  'BOLIVIA',
  'LA PAZ',
  'SANTA CRUZ',
  'COCHABAMBA',
  'PROHIBIDO',
  'ESTACIONAR',
  'TAXI',
  'STOP',
]);

export function matchFormat(plate: string): PlateFormat | null {
  return BOLIVIAN_FORMATS.find((f) => f.pattern.test(plate)) ?? null;
}

export const formatBonus = (plate: string): number => matchFormat(plate)?.bonus ?? 0;

/**
 * Scores one canonical candidate. Higher is better; below `MIN_ACCEPTABLE_SCORE` the
 * candidate is not treated as a plate at all.
 *
 *   confidence x 100, +2 per character, +20 for having digits, +10 for having letters,
 *   -200 with no digit at all, -120 with no letter, -500 outside the length window,
 *   plus the format bonus. Blocklisted words score -Infinity.
 */
export function scoreCandidate(
  plate: string,
  confidence: number,
  blocklist: readonly string[] = DEFAULT_BLOCKLIST,
): number {
  if (plate.length === 0) return Number.NEGATIVE_INFINITY;
  if (blocklist.includes(plate)) return Number.NEGATIVE_INFINITY;

  if (plate.length < PLATE_MIN_LENGTH || plate.length > PLATE_MAX_LENGTH) return -500;

  const hasDigits = /\d/.test(plate);
  const hasLetters = /[A-Z]/.test(plate);

  let score = confidence * 100;
  score += plate.length * 2;
  if (hasDigits) score += 20;
  if (hasLetters) score += 10;
  // A string with no digit is a word. Every Bolivian series has digits.
  if (!hasDigits) score -= 200;
  // All digits is not a Bolivian plate either, but it is a plausible mis-read of one -
  // the letters lost to glare - so the penalty is softer than the no-digit case.
  if (!hasLetters) score -= 120;

  return score + formatBonus(plate);
}

/**
 * The floor a candidate must clear to be considered a plate.
 *
 * 80 is where "confidence alone" stops being enough: a seven-character string with
 * digits and letters but no recognised format reaches 0.9*100 + 14 + 30 = 134 and passes,
 * while the same string at 0.3 confidence reaches 74 and does not. It is a starting
 * point, calibrated with the thresholds in section 8 of MODULO-PLACAS.md, not a
 * measurement.
 */
export const MIN_ACCEPTABLE_SCORE = 80;
