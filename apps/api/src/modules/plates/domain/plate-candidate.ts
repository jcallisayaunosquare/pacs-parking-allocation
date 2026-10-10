/**
 * Candidates: what the engine read, re-spelled, scored and ranked.
 *
 * The engine hands back text lines. This file turns them into plate candidates - one
 * canonical string per plausible re-spelling, each with a score - and fuses the OCR
 * confidence with the crop quality into the single number the thresholds act on.
 *
 * Pure: no I/O, no `async`.
 */

import { normalizePlate } from '../../residents/domain/vehicle';
import { DEFAULT_BLOCKLIST, scoreCandidate } from './bolivian-format';
import { expandVariants } from './plate-fuzzy';

/** A bounding box in the engine's normalised 0..1 frame coordinates. */
export interface CandidateBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** One text line as the OCR engine returned it. */
export interface RawCandidate {
  readonly text: string;
  /** 0..1, not the percentage the AWS API returns. The adapter divides. */
  readonly confidence: number;
  readonly box?: CandidateBox | undefined;
}

export interface ScoredCandidate {
  /** The canonical form of this candidate: what is matched against `vehicle.plate`. */
  readonly plate: string;
  /** The line the candidate came from, verbatim. Kept for audit and for the reviewer. */
  readonly raw: string;
  readonly confidence: number;
  readonly score: number;
  readonly box?: CandidateBox | undefined;
}

export const MAX_CANDIDATES = 8;

/**
 * Normalises every line, expands its confusable variants, scores them all, and returns
 * the best few, highest score first.
 *
 * Every variant of a line carries that LINE's confidence, unchanged. That is deliberate:
 * the engine was that sure of the pixels, not of our re-spelling of them. What separates
 * a variant from its siblings is the score - the format bonus is what says "1234ABC" is
 * a plate and "1234A8C" is not - and the fused confidence that follows is about the frame.
 */
export function rankCandidates(
  raws: readonly RawCandidate[],
  options: { limit?: number; blocklist?: readonly string[] } = {},
): ScoredCandidate[] {
  const limit = options.limit ?? MAX_CANDIDATES;
  const blocklist = options.blocklist ?? DEFAULT_BLOCKLIST;
  const best = new Map<string, ScoredCandidate>();

  for (const raw of raws) {
    const canonical = normalizePlate(raw.text);
    if (canonical.length === 0) continue;

    /*
     * The blocklist is checked against the LINE, before expansion, and that is not
     * belt-and-braces.
     *
     * "VISITAS" canonicalises to "V1S1TAS" (I folds to 1), and the U/V confusable pair
     * expands that to "U1S1TAS" - a seven-character string with digits and letters that
     * the blocklist has never heard of, and which therefore scores like a plate. The
     * variants of a scene word are scene words, so the whole line is dropped rather than
     * each spelling of it being judged on its own.
     */
    if (blocklist.includes(canonical)) continue;

    for (const variant of expandVariants(canonical)) {
      const score = scoreCandidate(variant, raw.confidence, blocklist);
      if (!Number.isFinite(score) || score < 0) continue;

      const previous = best.get(variant);
      if (previous === undefined || score > previous.score) {
        best.set(variant, {
          plate: variant,
          raw: raw.text,
          confidence: raw.confidence,
          score,
          box: raw.box,
        });
      }
    }
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.plate.localeCompare(b.plate))
    .slice(0, limit);
}

/**
 * Fuses OCR confidence with crop quality into the number the thresholds compare against.
 *
 *   fused = confidence * (0.6 + 0.4 * quality)
 *
 * The shape is the one that behaves correctly at both ends: a blurred crop can never
 * reach full confidence however certain the engine claims to be, and a perfect crop does
 * not inflate a weak read either - quality can only take away, at most 40%. With no
 * quality signal at all the confidence stands alone, because inventing a neutral 0.5
 * would silently penalise every frame the engine gave us no geometry for.
 */
export function fuseConfidence(confidence: number, quality: number | null): number {
  const c = Math.max(0, Math.min(1, confidence));
  if (quality === null) return c;
  const q = Math.max(0, Math.min(1, quality));
  return c * (0.6 + 0.4 * q);
}
