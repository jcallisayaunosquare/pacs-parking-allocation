import { Logger } from '@aws-lambda-powertools/logger';
import { getContainer } from './composition-root';

const logger = new Logger({ serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? 'pacs' });

interface SchedulerPayload {
  /** Set by the pre-warm schedule five minutes before the real run (section 10). */
  readonly warmup?: boolean;
  readonly cycleId?: string;
}

/**
 * EventBridge -> ExecuteRun. The same use case the admin button calls, so the two paths
 * cannot drift; the run lock makes them safe together (section 12).
 *
 * The schedule is a daily poll rather than a quarterly cron, because the allocation
 * duration is configurable (rule A): this handler draws only for a cycle that is already
 * in REGISTRATION_CLOSED, so the data decides when a run happens.
 *
 * A rarely-invoked function is guaranteed to start cold, so a warm-up invocation arrives
 * five minutes earlier and returns immediately after the container is built - the NFR-01
 * measurement is taken on the warm one (section 10).
 */
export const handler = async (event: SchedulerPayload = {}): Promise<unknown> => {
  const app = await getContainer();

  if (event.warmup) {
    logger.info('warmup', { note: 'container built, exiting without drawing' });
    return { warmed: true };
  }

  // Without an explicit cycle, draw for whichever cycle the scheduler closed.
  let cycleId = event.cycleId;
  if (!cycleId) {
    const closed = await app.cycles.list();
    const candidate = closed.ok
      ? closed.value.find((c) => c.state === 'REGISTRATION_CLOSED')
      : undefined;
    if (!candidate) {
      logger.warn('no runnable cycle', { note: 'nothing is in REGISTRATION_CLOSED' });
      return { skipped: true, reason: 'NO_RUNNABLE_CYCLE' };
    }
    cycleId = candidate.id;
  }

  // Deterministic key, one per cycle: the daily poll, a scheduler retry and an admin
  // clicking at the same moment all collapse onto it and replay rather than re-draw
  // (section 12, section 16).
  const idempotencyKey = `scheduler-${cycleId}`;
  const result = await app.executeRun.execute({ cycleId, idempotencyKey });

  if (!result.ok) {
    logger.error('run failed', { cycleId, code: result.error.code, message: result.error.message });
    return { ok: false, error: result.error.code };
  }

  logger.info('run completed', {
    cycleId,
    runId: result.value.runId,
    assigned: result.value.assigned,
    waitlisted: result.value.waitlisted,
  });
  return { ok: true, ...result.value };
};
