import { Logger } from '@aws-lambda-powertools/logger';
import { RekognitionClient } from '@aws-sdk/client-rekognition';
import { S3Client } from '@aws-sdk/client-s3';
import type { S3Event } from 'aws-lambda';

import { DEFAULT_THRESHOLDS } from '../modules/plates/domain/access-decision';
import { DEFAULT_BLOCKLIST, foldBlocklist } from '../modules/plates/domain/bolivian-format';
import {
  recognizeCapture,
  type PlateLogger,
  type RecognizeCaptureDeps,
} from '../modules/plates/application/recognize-capture';
import { DynamoPlateEventPublisher } from '../modules/plates/infrastructure/dynamo-plate-event.publisher';
import { RekognitionPlateRecognizer } from '../modules/plates/infrastructure/rekognition.recognizer';
import { S3CaptureStorage } from '../modules/plates/infrastructure/s3-capture.storage';

/**
 * S3 -> Rekognition DetectText -> a `PlateRecognized` event. M-7.
 *
 * The second function outside the VPC, for the same reason `integrations` is the first
 * (ADR-016): an in-VPC function reaches exactly RDS and DynamoDB through a free gateway
 * endpoint, and nothing else. Rekognition and S3 are HTTPS endpoints on the internet, so
 * reaching them from inside the VPC would need either a NAT gateway (~32 USD/month, the
 * thing ADR-016 exists to avoid) or a Rekognition interface endpoint (~7.30 USD per
 * availability zone per month, which across three subnets costs more than the entire
 * inference bill for this building).
 *
 * So this function cannot reach Postgres, and does not try. It writes the event, and
 * `plateIngest` inside the VPC applies it. The decision rule is the same pure `decide()`
 * on both sides; only this side has an empty register, which is why what it computes here
 * is a preview that goes to the log and nowhere else.
 *
 * Its own composition root, separate from `composition-root.ts`, deliberately: that one
 * opens a database connection on construction, and this function has no route to the
 * database. Importing it would make every cold start wait on a connection that cannot be
 * made.
 *
 * The filename has no second dot. The Node runtime splits the handler string at the FIRST
 * dot, so `plate-recognizer.handler.ts` with handler `...handler.handler` fails at init
 * with `Cannot find module 'plate-recognizer'` - the same trap the README documents for
 * `api.ts`.
 */
const logger = new Logger({ serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? 'pacs' });

const plateLogger: PlateLogger = {
  info: (message, context) => logger.info(message, context ?? {}),
  warn: (message, context) => logger.warn(message, context ?? {}),
  error: (message, context) => logger.error(message, context ?? {}),
};

// Module scope, so a warm container reuses the connection pools and the credential
// provider across invocations instead of rebuilding them per frame.
const rekognition = new RekognitionClient({});
const s3 = new S3Client({});
const storage = new S3CaptureStorage(s3);

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const list = (name: string, fallback: readonly string[]): readonly string[] => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  // Folded through normalizePlate, not merely uppercased: the list is compared against
  // canonical candidates, so "PARQUEO" has to become "PAR0UE0" to ever match one.
  return foldBlocklist(raw.split(','));
};

let deps: RecognizeCaptureDeps | undefined;

function build(): RecognizeCaptureDeps {
  const eventsTable = process.env.EVENTS_TABLE;
  if (!eventsTable) throw new Error('EVENTS_TABLE is not set.');

  return {
    storage,
    recognizer: new RekognitionPlateRecognizer(rekognition, {
      minTextConfidence: num('REKOGNITION_MIN_TEXT_CONFIDENCE', 70),
      frameHeightPx: num('CAMERA_FRAME_HEIGHT_PX', 1080),
    }),
    publisher: new DynamoPlateEventPublisher(eventsTable),
    logger: plateLogger,
    config: {
      maxBytes: num('CAPTURE_MAX_BYTES', 8 * 1024 * 1024),
      // Fourteen days: long enough that a broken in-VPC consumer can be fixed and the
      // stream replayed, short enough that nobody mistakes this table for the record.
      eventTtlSeconds: num('PLATES_EVENT_TTL_SECONDS', 14 * 24 * 3600),
      blocklist: list('PLATE_BLOCKLIST', DEFAULT_BLOCKLIST),
      // This side cannot read `plate_config`, so these are the deploy's values. They only
      // affect the logged preview; the decision that is acted on is taken in-VPC against
      // the stored thresholds.
      thresholds: {
        minFused: num('PLATES_MIN_FUSED', DEFAULT_THRESHOLDS.minFused),
        reviewFused: num('PLATES_REVIEW_FUSED', DEFAULT_THRESHOLDS.reviewFused),
        maxFuzzyDistance: num('PLATES_MAX_FUZZY_DISTANCE', DEFAULT_THRESHOLDS.maxFuzzyDistance),
      },
    },
  };
}

export const handler = async (event: S3Event): Promise<{ processed: number; skipped: number }> => {
  deps ??= build();
  let processed = 0;
  let skipped = 0;

  for (const record of event.Records ?? []) {
    const bucket = record.s3?.bucket?.name;
    const rawKey = record.s3?.object?.key;
    if (!bucket || !rawKey) {
      plateLogger.warn('notification record without bucket or key', {});
      skipped += 1;
      continue;
    }

    // S3 URL-encodes the key in the notification and turns spaces into '+'. An
    // undecoded key produces a GetObject 404 that reads as a missing object rather than
    // as an encoding bug, which is an hour of looking in the wrong place.
    const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));

    try {
      const outcome = await recognizeCapture(deps, { bucket, key });
      if (outcome.kind === 'published') processed += 1;
      else skipped += 1;
    } catch (error) {
      // Rethrown on purpose. An S3-triggered invocation that fails is retried twice by
      // Lambda and then goes to its failure destination; swallowing it would lose the
      // capture silently, and a lost capture at a gate is a car with no record of
      // entering - which is the one outcome this module exists to prevent.
      plateLogger.error('recognition failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  return { processed, skipped };
};
