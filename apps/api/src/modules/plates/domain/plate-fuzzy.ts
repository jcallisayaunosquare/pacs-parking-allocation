/**
 * The fuzzy tier: the confusable glyph pairs the vehicle register deliberately does NOT
 * fold, plus the edit distance that decides whether a read is "the same plate".
 *
 * This file is the other half of a promise made in `residents/domain/vehicle.ts`:
 *
 *   "Fuzzy matching belongs where that score exists, not in a uniqueness key."
 *
 * The register folds only O/Q to 0 and I to 1, because those three are indistinguishable
 * in every plate face and folding anything more makes two genuine plates collide in a
 * unique index - a registration refused with no action a resident can take. Here there is
 * a confidence score and a review queue behind every guess, so the riskier pairs can be
 * considered: a near miss costs a review, not a refusal.
 *
 * Pure TypeScript. No I/O, no `async`, no clock. Same rule as every other `domain/` ring
 * in this backend, and the reason the whole matching tier is covered by table tests.
 */

import { normalizePlate } from '../../residents/domain/vehicle';

/**
 * Bidirectional confusable pairs, excluding the three already folded canonically
 * (O/0, Q/0, I/1) - those never reach this tier, because `normalizePlate` has already
 * collapsed them on both the read and the registered plate.
 */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['S', '5'],
  ['B', '8'],
  ['Z', '2'],
  ['G', '6'],
  ['D', '0'],
  ['T', '7'],
  ['A', '4'],
  ['E', 'F'],
  ['U', 'V'],
  ['M', 'N'],
];

const SUBSTITUTIONS: Readonly<Record<string, readonly string[]>> = (() => {
  const map: Record<string, string[]> = {};
  for (const [a, b] of PAIRS) {
    (map[a] ??= []).push(b);
    (map[b] ??= []).push(a);
  }
  return map;
})();

/** The pairs, for the review screen: it has to be able to explain a fuzzy match. */
export const CONFUSABLE_PAIRS = PAIRS;

/**
 * Candidate variants of an already-canonical plate.
 *
 * ONE substitution at a time, plus the single "every ambiguous letter to its digit"
 * variant. Not the power set, and that is a decision rather than an optimisation: for a
 * seven-character plate it is about eight variants instead of 128, and the 120 it leaves
 * out are spellings that require the engine to have made several independent glyph errors
 * in one short string - a failure mode that produces noise, not matches. Generating them
 * would multiply the scoring cost and widen the surface on which a wrong plate can score
 * well enough to open a gate.
 *
 * The input itself is always first in the result.
 */
export function expandVariants(plate: string): string[] {
  const out = new Set<string>([plate]);

  for (let i = 0; i < plate.length; i += 1) {
    const ch = plate[i] as string;
    for (const alt of SUBSTITUTIONS[ch] ?? []) {
      out.add(plate.slice(0, i) + alt + plate.slice(i + 1));
    }
  }

  // The all-letters-to-digits pass: a plate read entirely in the wrong glyph class,
  // which happens when a camera's contrast is off rather than one character being dirty.
  let allDigits = '';
  let changed = false;
  for (const ch of plate) {
    const alt = (SUBSTITUTIONS[ch] ?? []).find((c) => /\d/.test(c));
    if (alt !== undefined) {
      allDigits += alt;
      changed = true;
    } else {
      allDigits += ch;
    }
  }
  if (changed) out.add(allDigits);

  return [...out];
}

/**
 * Damerau-Levenshtein distance, capped.
 *
 * Damerau rather than plain Levenshtein because transposition is a common OCR error
 * ("1243ABC" for "1234ABC") and Levenshtein charges it as two edits, which pushes a
 * genuine match past a distance-1 threshold and sends a legitimate resident to the review
 * queue every time they drive in.
 *
 * `max` lets the caller stop early: nothing above 2 is ever acted on, so computing a
 * distance of 9 is work thrown away. A result of `max + 1` means "further than max".
 */
export function damerauLevenshtein(
  a: string,
  b: string,
  max = Number.POSITIVE_INFINITY,
): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Three rolling rows is all the recurrence needs; the full matrix is never read back.
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr: number[] = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    let rowMin = curr[0] as number;

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        (prev[j] as number) + 1, // deletion
        (curr[j - 1] as number) + 1, // insertion
        (prev[j - 1] as number) + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, (prev2[j - 2] as number) + 1); // transposition
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }

    // Every remaining row can only grow, so one whole row above max ends it.
    if (rowMin > max) return max + 1;

    prev2 = prev;
    prev = curr;
    curr = new Array<number>(b.length + 1);
  }

  return prev[b.length] as number;
}

export interface FuzzyMatch {
  readonly plate: string;
  readonly distance: number;
}

/**
 * The registered plates within `maxDistance` of a read, nearest first.
 *
 * `registered` is expected to be pre-filtered by length at the repository - the lookup
 * asks for active plates whose length is within one of the read's - so this never walks
 * the whole register. For a residential building the active set is tens of rows, so the
 * distance pass is not the bottleneck and `pg_trgm` is not yet worth an extension.
 *
 * Returning every tie is deliberate: more than one plate at the same distance is
 * ambiguity, and ambiguity goes to review rather than opening the gate on a coin flip.
 */
export function findFuzzyMatches(
  read: string,
  registered: readonly string[],
  maxDistance = 2,
): FuzzyMatch[] {
  const matches: FuzzyMatch[] = [];
  for (const plate of registered) {
    const distance = damerauLevenshtein(read, plate, maxDistance);
    if (distance <= maxDistance) matches.push({ plate, distance });
  }
  return matches.sort((x, y) => x.distance - y.distance || x.plate.localeCompare(y.plate));
}

/**
 * The canonical form, re-exported from the register's domain rather than redefined.
 *
 * Importing it is the whole point: `vehicle.plate` is stored folded by this exact
 * function and `ux_vehicle_plate_active` is keyed on its output. A second definition here
 * would let "already registered" and "recognised at the gate" disagree, and the gate
 * would refuse a car that is registered.
 */
export { normalizePlate };
