/**
 * The recogniser's use case: an object key in, an event out.
 *
 * Ports only - no AWS types, no `process.env`, no `console`. The handler in `src/main`
 * supplies the adapters, which is what keeps this testable with three fakes and what
 * makes the engine swap a composition-root change.
 *
 * The staged shape with early exits exists so that every way of doing nothing reports
 * WHY it did nothing. At a gate, "nothing happened" is the outcome you most need to be
 * able to explain, and a pipeline that returns silently on a dirty frame is a pipeline
 * nobody can debug at 7 a.m.
 */

import { rankCandidates, type ScoredCandidate } from '../domain/plate-candidate';
import { decide, type Decision, type Thresholds } from '../domain/access-decision';
import type {
  CaptureMetadata,
  CaptureStorage,
  PlateCandidatePayload,
  PlateEventPublisher,
  PlateRecognizedEvent,
  PlateRecognizer,
  RecognitionResult,
} from './ports';

export interface PlateLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface RecognizeCaptureConfig {
  readonly maxBytes: number;
  readonly eventTtlSeconds: number;
  readonly blocklist: readonly string[];
  readonly thresholds: Thresholds;
}

export type SkipReason =
  | 'ALREADY_PROCESSED'
  | 'OBJECT_TOO_LARGE'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'NO_TEXT_DETECTED';

export type RecognizeOutcome =
  | {
      readonly kind: 'published';
      readonly event: PlateRecognizedEvent;
      /** Computed with an empty register. Logged, never acted on. See below. */
      readonly preview: Decision;
    }
  | { readonly kind: 'skipped'; readonly reason: SkipReason };

export interface RecognizeCaptureDeps {
  readonly storage: CaptureStorage;
  readonly recognizer: PlateRecognizer;
  readonly publisher: PlateEventPublisher;
  readonly logger: PlateLogger;
  readonly config: RecognizeCaptureConfig;
}

export async function recognizeCapture(
  deps: RecognizeCaptureDeps,
  input: { bucket: string; key: string },
): Promise<RecognizeOutcome> {
  const { storage, recognizer, publisher, logger, config } = deps;

  // ---- Stage 1: metadata, and the cheapest possible exit ---------------------
  const meta = await storage.head(input.bucket, input.key);

  // Before recognition, not after: a replayed S3 notification must not be billed twice.
  if (await publisher.alreadyPublished(meta.captureId)) {
    logger.info('capture already processed', { captureId: meta.captureId, key: input.key });
    return { kind: 'skipped', reason: 'ALREADY_PROCESSED' };
  }

  if (meta.sizeBytes > config.maxBytes) {
    logger.warn('capture exceeds the size limit', {
      captureId: meta.captureId,
      sizeBytes: meta.sizeBytes,
      maxBytes: config.maxBytes,
    });
    return { kind: 'skipped', reason: 'OBJECT_TOO_LARGE' };
  }

  if (meta.contentType !== null && !/^image\/(jpeg|png)$/.test(meta.contentType)) {
    logger.warn('unsupported content type', {
      captureId: meta.captureId,
      contentType: meta.contentType,
    });
    return { kind: 'skipped', reason: 'UNSUPPORTED_CONTENT_TYPE' };
  }

  // ---- Stage 2: recognition -------------------------------------------------
  const result = await recognizer.recognize({ bucket: input.bucket, key: input.key });

  if (result.candidates.length === 0) {
    logger.info('no text detected', {
      captureId: meta.captureId,
      engine: result.engine,
      latencyMs: result.latencyMs,
    });
    /*
     * Published anyway, with an empty candidate list.
     *
     * A frame that read nothing is the signal a camera has moved, been splashed or lost
     * its night illuminator, and the review queue is where that becomes visible. Dropping
     * it hides the only evidence of the fault, and the building then discovers it when a
     * resident complains that the gate stopped recognising them.
     */
    await publisher.publishIfAbsent(
      buildEvent(meta, input.key, [], null, result),
      config.eventTtlSeconds,
    );
    return { kind: 'skipped', reason: 'NO_TEXT_DETECTED' };
  }

  // ---- Stage 3: normalise, expand, score -----------------------------------
  const ranked = rankCandidates(result.candidates, {
    blocklist: config.blocklist,
    limit: 8,
  });
  const best: ScoredCandidate | null = ranked[0] ?? null;

  /*
   * ---- Stage 4: a decision PREVIEW, not the decision ----------------------
   *
   * The real decision needs the vehicle register, and the register is in Postgres, which
   * this function cannot reach: there is no NAT gateway (ADR-016). So `plateIngest`,
   * inside the VPC, calls the SAME pure `decide()` with the registered vehicles loaded.
   * The preview computed here with an empty register goes to the log only, because it
   * answers the one question worth answering from outside the VPC: did we read a plate at
   * all, and how sure are we.
   */
  const preview = decide({
    best,
    quality: result.quality,
    registered: [],
    withinCooldown: false,
    thresholds: config.thresholds,
  });

  const event = buildEvent(meta, input.key, ranked, result.quality, result);
  const published = await publisher.publishIfAbsent(event, config.eventTtlSeconds);

  if (!published) {
    // The conditional write lost a race: a concurrent invocation on the same object got
    // there first. Not an error - exactly-once was the goal and it was achieved.
    logger.info('event already written by a concurrent invocation', {
      captureId: meta.captureId,
    });
    return { kind: 'skipped', reason: 'ALREADY_PROCESSED' };
  }

  logger.info('plate recognized', {
    captureId: meta.captureId,
    cameraId: meta.cameraId,
    plate: best?.plate ?? null,
    score: best?.score ?? null,
    confidence: best?.confidence ?? null,
    quality: result.quality,
    fused: preview.fused,
    previewReason: preview.reason,
    candidateCount: ranked.length,
    latencyMs: result.latencyMs,
  });

  return { kind: 'published', event, preview };
}

const round = (v: number, places: number): number => Number(v.toFixed(places));

export function toPayload(c: ScoredCandidate): PlateCandidatePayload {
  return {
    plate: c.plate,
    raw: c.raw,
    confidence: round(c.confidence, 4),
    score: round(c.score, 2),
    ...(c.box !== undefined ? { box: c.box } : {}),
  };
}

function buildEvent(
  meta: CaptureMetadata,
  key: string,
  ranked: readonly ScoredCandidate[],
  quality: number | null,
  result: RecognitionResult,
): PlateRecognizedEvent {
  const best = ranked[0];
  return {
    captureId: meta.captureId,
    cameraId: meta.cameraId,
    capturedAt: meta.capturedAt,
    objectKey: key,
    candidates: ranked.map(toPayload),
    best:
      best === undefined
        ? null
        : { plate: best.plate, confidence: round(best.confidence, 4) },
    quality: quality === null ? null : round(quality, 4),
    engine: result.engine,
    engineVersion: result.engineVersion,
    latencyMs: result.latencyMs,
  };
}
