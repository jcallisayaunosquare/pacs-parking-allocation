import {
  DetectTextCommand,
  RekognitionClient,
  type TextDetection,
} from '@aws-sdk/client-rekognition';
import { normalizePlate } from '../../residents/domain/vehicle';
import { formatBonus } from '../domain/bolivian-format';
import { estimateQuality } from '../domain/plate-quality';
import type { CandidateBox, RawCandidate } from '../domain/plate-candidate';
import type {
  PlateRecognizer,
  RecognitionRequest,
  RecognitionResult,
} from '../application/ports';

/**
 * The one class in the codebase that knows Rekognition exists.
 *
 * `DetectText` is given the S3 object reference rather than bytes, so the JPEG never
 * travels through this function: no download, no multi-megabyte payload, no decode. That
 * is both the fast path and the cheap one, and it is why the IAM statement needs
 * `s3:GetObject` on the bucket for Rekognition rather than for the Lambda's own reads.
 *
 * What it does NOT do, deliberately: localise the plate. Rekognition has no plate
 * detector, so "where is the plate" is answered here as "the text line that scores as a
 * Bolivian plate format and sits in a plate-shaped box" - which is why the format table
 * and the scene blocklist in `domain/` are load-bearing rather than decorative. If the
 * week-one measurement says that is not good enough, this file is what gets replaced: the
 * port is one method, and nothing above it changes.
 */

export interface RekognitionRecognizerOptions {
  /** Lines below this confidence are not worth scoring. Percent, 0..100, as AWS reports. */
  readonly minTextConfidence?: number;
  /**
   * Source frame height in pixels. Rekognition returns normalised boxes, so the absolute
   * plate height - the one signal that genuinely predicts a failed read - cannot be
   * recovered without it. It comes from the camera profile; 1080 is the default because
   * that is what the gate cameras are specified at.
   */
  readonly frameHeightPx?: number;
}

export class RekognitionPlateRecognizer implements PlateRecognizer {
  private readonly minTextConfidence: number;
  private readonly frameHeightPx: number;

  constructor(
    private readonly client: RekognitionClient = new RekognitionClient({}),
    options: RekognitionRecognizerOptions = {},
  ) {
    this.minTextConfidence = options.minTextConfidence ?? 70;
    this.frameHeightPx = options.frameHeightPx ?? 1080;
  }

  async recognize(request: RecognitionRequest): Promise<RecognitionResult> {
    const startedAt = Date.now();

    const response = await this.client.send(
      new DetectTextCommand({
        Image: { S3Object: { Bucket: request.bucket, Name: request.key } },
        Filters: {
          WordFilter: {
            MinBoundingBoxHeight: 0.01,
            MinConfidence: this.minTextConfidence,
          },
        },
      }),
    );

    const latencyMs = Date.now() - startedAt;
    const detections = response.TextDetections ?? [];

    /*
     * LINE, not WORD.
     *
     * "1234 ABC" is one line and two words. Taking the words would hand the ranker "1234"
     * and "ABC" separately - neither of which matches any Bolivian format, so both would
     * score as noise and the plate in the frame would be invisible to the very table that
     * exists to find it. The words are used only for the geometry of the best line.
     */
    const lines = detections.filter(
      (d) => d.Type === 'LINE' && (d.Confidence ?? 0) >= this.minTextConfidence,
    );

    const candidates: RawCandidate[] = lines.map((line) => ({
      text: line.DetectedText ?? '',
      // AWS reports 0..100; the domain works in 0..1 throughout.
      confidence: (line.Confidence ?? 0) / 100,
      box: boxOf(line),
    }));

    return {
      candidates,
      quality: this.qualityOf(lines),
      engine: 'rekognition-detect-text',
      // Rekognition does not version DetectText in its response, so the month is recorded
      // instead. It is the only thing that lets a precision regression be attributed to a
      // model change on their side rather than to our own deploy.
      engineVersion: new Date().toISOString().slice(0, 7),
      latencyMs,
    };
  }

  /**
   * Quality from the geometry of the most plate-like line, not of the frame as a whole:
   * a dark photo with one well-lit plate is a good capture, and a frame-wide metric would
   * score it as a bad one.
   */
  private qualityOf(lines: readonly TextDetection[]): number | null {
    if (lines.length === 0) return null;

    const confidences = lines.map((l) => (l.Confidence ?? 0) / 100);

    // "Most plate-like" = highest Bolivian format bonus, then the widest box.
    const ranked = [...lines].sort((a, b) => {
      const fa = formatBonus(normalizePlate(a.DetectedText ?? ''));
      const fb = formatBonus(normalizePlate(b.DetectedText ?? ''));
      if (fa !== fb) return fb - fa;
      return (boxOf(b)?.width ?? 0) - (boxOf(a)?.width ?? 0);
    });

    const box = boxOf(ranked[0] as TextDetection);
    if (box === undefined || box.height <= 0) return null;

    return estimateQuality({
      pixelHeight: box.height * this.frameHeightPx,
      aspect: box.width / box.height,
      lineConfidences: confidences,
    });
  }
}

function boxOf(detection: TextDetection): CandidateBox | undefined {
  const b = detection.Geometry?.BoundingBox;
  if (b === undefined) return undefined;
  const { Left, Top, Width, Height } = b;
  if (Left === undefined || Top === undefined || Width === undefined || Height === undefined) {
    return undefined;
  }
  return { left: Left, top: Top, width: Width, height: Height };
}
