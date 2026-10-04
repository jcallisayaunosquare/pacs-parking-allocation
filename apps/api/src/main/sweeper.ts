import { Logger } from '@aws-lambda-powertools/logger';
import { getDb } from '../shared/db/connection';
import { getContainer } from './composition-root';

const logger = new Logger({ serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? 'pacs' });

/** A run still RUNNING after this long had its process killed mid-flight (§12). */
const STALE_RUN_MINUTES = 15;
const OUTBOX_BATCH = 50;
const MAX_ATTEMPTS = 10;

/**
 * The housekeeping function (§10). Three jobs, each idempotent, so a missed schedule
 * only delays work rather than losing it:
 *
 *   1. free the run lock for runs whose process died mid-transaction
 *   2. expire assignments whose cycle has ended, and close those cycles (UC-14)
 *   3. relay the event outbox — the step that makes "write the event in the same
 *      transaction" actually deliver anything (§15)
 */
export const handler = async (): Promise<unknown> => {
  const app = await getContainer();
  const db = await getDb();
  const now = new Date();

  const staleBefore = new Date(now.getTime() - STALE_RUN_MINUTES * 60_000);
  const failedRuns = await app.allocationRepo.failStaleRuns(staleBefore);
  if (failedRuns > 0) logger.warn('stale runs failed', { count: failedRuns });

  const expired = await app.assignmentRepo.expireDue(now);
  if (expired > 0) logger.info('assignments expired', { count: expired });

  // Outbox relay: rows go to the pacs-events DynamoDB table, whose stream feeds
  // `integrations` outside the VPC (ADR-016). The API already pushes eagerly, so most
  // rows are published by the time this runs — this pass is the safety net that makes
  // the outbox a guarantee rather than a hope.
  //
  // A row is marked published only after the write succeeds. At-least-once delivery is
  // deliberate: every consumer in `integrations` is idempotent.
  const pending = await db
    .selectFrom('event_outbox')
    .selectAll()
    .where('published_at', 'is', null)
    .where('attempts', '<', MAX_ATTEMPTS)
    .orderBy('occurred_at')
    .limit(OUTBOX_BATCH)
    .execute();

  let relayed = 0;
  for (const row of pending) {
    try {
      await app.bus.publish([
        {
          eventType: row.event_type,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          payload: (typeof row.payload === 'string'
            ? JSON.parse(row.payload)
            : row.payload) as Record<string, unknown>,
        },
      ]);
      await db
        .updateTable('event_outbox')
        .set({ published_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      relayed++;
    } catch (e) {
      await db
        .updateTable('event_outbox')
        .set({
          attempts: row.attempts + 1,
          last_error: (e instanceof Error ? e.message : String(e)).slice(0, 1000),
        })
        .where('id', '=', row.id)
        .execute();
      logger.warn('relay failed', {
        eventType: row.event_type,
        attempts: row.attempts + 1,
      });
    }
  }

  logger.info('sweep complete', { failedRuns, expired, relayed });
  return { failedRuns, expired, relayed };
};
