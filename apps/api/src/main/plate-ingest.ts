import { randomUUID } from 'node:crypto';
import { Logger } from '@aws-lambda-powertools/logger';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';

import { parsePlateRecognized } from '../modules/plates/application/ingest-plate-read';
import { getContainer } from './composition-root';

/**
 * The in-VPC half of the plates pipeline: a `PlateRecognized` event from the
 * `pacs-events` stream, applied to Postgres as a `plate_read` row and - usually - an
 * `access_event` row. M-7.
 *
 * Inside the VPC, which looks contradictory for a stream consumer and is not: a DynamoDB
 * stream is not polled by the function, it is polled by the Lambda service, which then
 * invokes the function. So a function with no outbound route can still be triggered by
 * one - the same thing `sweeper` relies on for its schedule. What the function itself
 * needs is RDS, and that it has.
 *
 * This is also where the real decision is taken, because this is the only side that can
 * read the vehicle register. The recogniser logged a preview with an empty register; the
 * rule is the same pure `decide()` in both places, so the two cannot drift.
 *
 * Failure handling is per record, not per batch. `ReportBatchItemFailures` plus returning
 * only the sequence numbers that failed means one malformed event cannot block the shard
 * for its entire retention - and at a gate, a blocked shard is every car after the bad
 * one going unrecorded.
 */
const logger = new Logger({ serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? 'pacs' });

export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  const app = await getContainer();
  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const id = record.dynamodb?.SequenceNumber ?? randomUUID();
    try {
      // REMOVE is the TTL expiring a fourteen-day-old event. The durable record is
      // already in Postgres by then, so there is nothing to apply.
      if (record.eventName === 'REMOVE' || !record.dynamodb?.NewImage) continue;

      const item = unmarshall(record.dynamodb.NewImage as Parameters<typeof unmarshall>[0]);

      /*
       * The event filter in serverless.yml already restricts this function to
       * `pk` beginning `plateread#`, so in production nothing else arrives. The check
       * stays anyway: a filter is configuration, and a redeploy that drops it would
       * otherwise have this function opening a database connection for every Cognito
       * provisioning event on the table and discarding it.
       */
      const parsed = parsePlateRecognized(item);
      if (parsed === null) {
        logger.info('not a plate event, ignored', { pk: String(item.pk ?? '') });
        continue;
      }

      const outcome = await app.ingestPlateRead.apply(parsed);

      if (outcome.kind === 'malformed') {
        // Logged and dropped rather than retried: a malformed event is malformed on
        // every attempt, and reporting it as a failure would retry it three times and
        // then still lose it, three invocations later.
        logger.warn('malformed plate event dropped', {
          captureId: parsed.captureId,
          detail: outcome.detail,
        });
        continue;
      }

      if (outcome.kind === 'duplicate') {
        // The `ON CONFLICT (capture_id) DO NOTHING` path: at-least-once delivery met
        // exactly-once effect. Success, not an error.
        continue;
      }

      /*
       * One custom metric, because no AWS metric can say this.
       *
       * `IteratorAge` tells you the stream is behind; `Errors` tells you the function is
       * broken. Neither tells you the review queue is filling up, which is what happens
       * when the thresholds are mis-calibrated or a camera has been knocked out of
       * alignment - the pipeline keeps working perfectly and the building stops being
       * able to keep up with it.
       */
      if (outcome.decision.status === 'REVIEW') {
        logger.info('plate read needs review', {
          plateReadId: outcome.read.id,
          reason: outcome.decision.reason,
          fused: outcome.decision.fused,
          metric: 'PlateReviewQueued',
        });
      }
    } catch (e) {
      logger.error('plate event failed', {
        sequenceNumber: id,
        message: e instanceof Error ? e.message : String(e),
      });
      failures.push({ itemIdentifier: id });
    }
  }

  return { batchItemFailures: failures };
};
