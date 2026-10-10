/**
 * Crop quality as a 0..1 score, and an honest account of what it is.
 *
 * The proper metric is the one computer-vision pipelines use: variance of the Laplacian
 * over the decoded crop, plus contrast, edge density and brightness. That needs the
 * pixels, which in a Node zip Lambda means a native image decoder - a platform-specific
 * binary, an arm64 build matrix and tens of megabytes in the bundle, for a signal that
 * can be approximated from geometry alone.
 *
 * So this is a PROXY, and it says so rather than borrowing the name of the real thing:
 *
 *   - `pixelHeight` dominates, because it is the one quantity that actually predicts a
 *     failed read at a gate. Below roughly 16 px of character height no engine reads a
 *     plate reliably; above roughly 48 px more pixels stop helping.
 *   - `aspect`: how close the detected box is to a plate's proportions. A box far outside
 *     the plausible band is probably a sign.
 *   - `confidenceSpread`: how much the per-line confidences disagree. One line at 0.99
 *     among several at 0.4 is a clean frame with one clean plate; uniform mediocrity
 *     across many lines is a bad frame.
 *
 * Why it matters that it is separate from OCR confidence: a blurred crop the engine is
 * certain about is the dangerous read, and only two independent numbers can describe it.
 * The fused value in `plate-candidate.ts` is what the thresholds act on.
 *
 * If field measurement shows quality is the limiting signal, the upgrade is a Laplacian
 * variance over the decoded crop - which is also the moment the Python container option
 * stops being a liability, since it ships OpenCV already.
 *
 * Pure: no I/O, no `async`.
 */

export interface QualityInput {
  /** Height of the plate's bounding box in source pixels. */
  readonly pixelHeight: number;
  /** Width / height of the plate's bounding box. */
  readonly aspect: number;
  /** Every line confidence the engine returned for this frame, 0..1. */
  readonly lineConfidences: readonly number[];
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export const MIN_HEIGHT_PX = 16;
export const GOOD_HEIGHT_PX = 48;

/** The plausible aspect band for a Bolivian plate as a camera sees it. */
export const MIN_ASPECT = 2.2;
export const MAX_ASPECT = 4.5;

export function estimateQuality(input: QualityInput): number {
  const heightScore = clamp01(
    (input.pixelHeight - MIN_HEIGHT_PX) / (GOOD_HEIGHT_PX - MIN_HEIGHT_PX),
  );

  const aspectScore =
    input.aspect >= MIN_ASPECT && input.aspect <= MAX_ASPECT
      ? 1
      : clamp01(
          1 -
            Math.min(Math.abs(input.aspect - MIN_ASPECT), Math.abs(input.aspect - MAX_ASPECT)) / 2,
        );

  const confs = input.lineConfidences;
  // One line says nothing about spread, so stay neutral rather than inventing a signal.
  let spreadScore = 0.5;
  if (confs.length > 1) {
    const max = Math.max(...confs);
    const mean = confs.reduce((a, b) => a + b, 0) / confs.length;
    // A clear winner among noisy lines is a good sign, not a bad one.
    spreadScore = clamp01((max - mean) * 2);
  }

  return clamp01(0.6 * heightScore + 0.25 * aspectScore + 0.15 * spreadScore);
}
