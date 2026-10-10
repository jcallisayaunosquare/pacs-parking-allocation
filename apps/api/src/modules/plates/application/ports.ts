/**
 * The plates module's application ring: ports only. Nothing here knows that AWS exists.
 *
 * `PlateRecognizer` is the port that makes the engine choice reversible, and that is the
 * reason the engine decision could be made on today's evidence rather than on a guess.
 * Moving from Rekognition `DetectText` to a Python container with a trained detector, or
 * to a hosted ALPR API with a Bolivian model, is one new class in `infrastructure/` and
 * one line in `src/main`. The domain, the schema, the HTTP contract and the review screen
 * do not change.
 */

import type { RawCandidate, ScoredCandidate } from '../domain/plate-candidate';
import type {
  AccessDecision,
  DecisionReason,
  MatchKind,
  PlateReadStatus,
  RegisteredVehicle,
  Thresholds,
} from '../domain/access-decision';
import type { AccessEvent, PlateRead, PlateReadWithDecision } from '../domain/plate-read';

// ------------------------------------------------------------------ recognition

export interface RecognitionRequest {
  readonly bucket: string;
  readonly key: string;
}

export interface RecognitionResult {
  readonly candidates: readonly RawCandidate[];
  /** 0..1, or null when the engine gives nothing to estimate it from. */
  readonly quality: number | null;
  readonly engine: string;
  readonly engineVersion: string | null;
  readonly latencyMs: number;
}

/** The swappable engine. One method, on purpose. */
export interface PlateRecognizer {
  recognize(request: RecognitionRequest): Promise<RecognitionResult>;
}

export interface CaptureMetadata {
  readonly captureId: string;
  readonly cameraId: string;
  readonly capturedAt: string;
  readonly sizeBytes: number;
  readonly contentType: string | null;
}

/** Where the frames live. S3 in production; a map in tests. */
export interface CaptureStorage {
  head(bucket: string, key: string): Promise<CaptureMetadata>;
  /**
   * A presigned PUT for the camera client, plus the key it will write to. Signing makes
   * no call to S3, but the function's role must hold the permission the URL grants or the
   * upload fails with 403 - which is why the IAM statement for `raw/*` exists.
   */
  presignUpload(input: {
    bucket: string;
    key: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<string>;
  /** A short-lived GET, for the review screen. Images are never served by the API. */
  presignDownload(input: {
    bucket: string;
    key: string;
    expiresInSeconds: number;
  }): Promise<string>;
}

// ------------------------------------------------------------------ the event

/**
 * The contract between the two functions, and the only thing that crosses the VPC
 * boundary. `plateRecognizer` runs outside the VPC (it needs S3 and Rekognition);
 * `plateIngest` runs inside it (it needs RDS). Neither can reach what the other needs, so
 * a DynamoDB item with a stream between them is the join - the pattern the Cognito
 * provisioning flow already uses, inverted.
 */
export interface PlateRecognizedEvent {
  readonly captureId: string;
  readonly cameraId: string;
  readonly capturedAt: string;
  readonly objectKey: string;
  readonly candidates: readonly PlateCandidatePayload[];
  readonly best: { readonly plate: string; readonly confidence: number } | null;
  readonly quality: number | null;
  readonly engine: string;
  readonly engineVersion: string | null;
  readonly latencyMs: number;
}

export interface PlateCandidatePayload {
  readonly plate: string;
  readonly raw: string;
  readonly confidence: number;
  readonly score: number;
  readonly box?: { left: number; top: number; width: number; height: number } | undefined;
}

export interface PlateEventPublisher {
  /**
   * Writes the event, conditional on its absence. Returns false when one already exists,
   * which is not an error: at-least-once delivery met exactly-once effect.
   */
  publishIfAbsent(event: PlateRecognizedEvent, ttlSeconds: number): Promise<boolean>;
  /**
   * Checked BEFORE recognition, so a replayed S3 notification does not pay for a second
   * Rekognition call. The conditional write above is the correctness guarantee; this is
   * the cost optimisation.
   */
  alreadyPublished(captureId: string): Promise<boolean>;
}

// ------------------------------------------------------------------ the register

/** Reads the resident vehicle register. Implemented over Kysely. */
export interface VehicleLookup {
  /**
   * Active registrations whose canonical plate is within one character of `plate`'s
   * length, plus the exact match whatever its length.
   *
   * The length filter is what keeps the fuzzy pass cheap without an index on edit
   * distance, which cannot exist. For a residential building this is tens of rows. If the
   * register ever grew, the indexable route is `pg_trgm`, and it is deliberately not in
   * the first migration because it needs an extension and this resolves the real case.
   */
  candidatesFor(plate: string): Promise<readonly RegisteredVehicle[]>;
  /** Every active registration, for the review screen's "nearby plates" list. */
  allActive(): Promise<readonly RegisteredVehicle[]>;
}

/** The per-(camera, plate) dedupe window. DynamoDB with TTL. */
export interface CooldownStore {
  /** True when this plate was already seen at this camera inside the window. */
  check(cameraId: string, plate: string): Promise<boolean>;
  mark(cameraId: string, plate: string, ttlSeconds: number): Promise<void>;
}

// ------------------------------------------------------------------ persistence

export interface PlateReadInsert {
  readonly captureId: string;
  readonly cameraId: string;
  readonly capturedAt: Date;
  readonly rawText: string | null;
  readonly plate: string | null;
  readonly confidence: number;
  readonly quality: number | null;
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
}

export interface AccessEventInsert {
  readonly plate: string;
  readonly vehicleId: string | null;
  readonly residentId: string | null;
  readonly spotId: string | null;
  readonly decision: AccessDecision;
  readonly reason: DecisionReason;
  readonly cameraId: string;
  readonly occurredAt: Date;
}

export interface PlateReadListQuery {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly status?: PlateReadStatus | undefined;
  readonly cameraId?: string | undefined;
  readonly plate?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  /** Only the reads a human still has to look at. The review queue, in one flag. */
  readonly needsReview?: boolean | undefined;
}

export interface PlateReadPage {
  readonly items: readonly PlateReadWithDecision[];
  readonly nextCursor: string | null;
}

export interface AccessEventListQuery {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly decision?: AccessDecision | undefined;
  readonly residentId?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

export interface AccessEventRow extends AccessEvent {
  readonly residentName: string | null;
  readonly unitNumber: string | null;
  readonly spotCode: string | null;
  readonly captureId: string;
}

export interface AccessEventPage {
  readonly items: readonly AccessEventRow[];
  readonly nextCursor: string | null;
}

export interface PlateMetrics {
  readonly reads: number;
  readonly matched: number;
  readonly unmatched: number;
  readonly pendingReview: number;
  /** Age of the oldest unreviewed read, in hours. Null when the queue is empty. */
  readonly oldestPendingHours: number | null;
  readonly allowed: number;
  readonly denied: number;
  /** Mean fused confidence over the window, or null when there were no reads. */
  readonly averageFused: number | null;
  readonly byCamera: readonly { cameraId: string; reads: number; matched: number }[];
  readonly corrections: number;
}

export interface PlateReadRepository {
  /**
   * `INSERT ... ON CONFLICT (capture_id) DO NOTHING RETURNING *`. Returns null when the
   * capture was already applied, which is what turns a replayed stream record into a
   * no-op without the consumer having to ask first.
   */
  insertIfAbsent(input: PlateReadInsert): Promise<PlateRead | null>;
  findById(id: string): Promise<PlateRead | null>;
  findByCaptureId(captureId: string): Promise<PlateRead | null>;
  list(query: PlateReadListQuery): Promise<PlateReadPage>;
  /** A read with its standing decision and the names the screen prints. */
  findDetail(id: string): Promise<PlateReadWithDecision | null>;

  /**
   * The review, in one transaction: update the read guarded by `reviewed_at IS NULL`,
   * point the standing access event at the new one, insert the new one, and queue the
   * outbox row. Returns null when the guard refused - another administrator got there
   * first - so the caller answers 409 rather than silently overwriting a verdict.
   */
  applyReview(input: {
    readonly plateReadId: string;
    readonly reviewedBy: string | null;
    readonly reviewedAt: Date;
    readonly status: PlateReadStatus;
    readonly plate: string | null;
    readonly correctedPlate: string | null;
    readonly vehicleId: string | null;
    readonly matchKind: MatchKind;
    readonly note: string | null;
    readonly event: AccessEventInsert | null;
  }): Promise<PlateReadWithDecision | null>;

  metrics(since: Date): Promise<PlateMetrics>;
}

export interface AccessEventRepository {
  /** Written in the same transaction as the read it belongs to. */
  insert(plateReadId: string, input: AccessEventInsert): Promise<AccessEvent>;
  list(query: AccessEventListQuery): Promise<AccessEventPage>;
  /** A resident's own entries, derived from the token's resident id and nothing else. */
  listForResident(residentId: string, limit: number): Promise<readonly AccessEventRow[]>;
}

/**
 * Where the thresholds come from.
 *
 * The database wins over the environment variable: the variable is the cold-start
 * default, the stored value is what recalibration writes. Section 8's whole point is that
 * moving 0.85 must not need a deploy.
 */
export interface PlateThresholdProvider {
  current(): Promise<Thresholds>;
}

/**
 * Mints capture ids. A port rather than a call to `randomUUID()` inside the use case,
 * for the same reason `Clock` and `SeedSource` are ports: the id ends up in an S3 key, a
 * DynamoDB partition key and a UNIQUE column, so a test has to be able to fix it.
 *
 * Lexicographically sortable by time, which is what makes the S3 prefix listing of a
 * day's captures come back in arrival order for free.
 */
export interface CaptureIdSource {
  next(at: Date): string;
}
