import { Logger } from '@aws-lambda-powertools/logger';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { failure } from '../shared/errors';
import { errorResponse } from '../shared/http/response';
import { Router } from '../shared/http/router';
import { getContainer } from './composition-root';
import { buildRoutes } from './routes';
import { documentationResponse } from './docs';

/**
 * The lambdalith (ADR-014): one function, one composition root, every HTTP route.
 * Matches the modular monolith of ADR-002 — module boundaries are enforced in code and
 * by ESLint, not by deploy units, so there are fewer cold starts to pay for.
 */
const logger = new Logger({ serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? 'pacs' });

let router: Router | undefined;

async function getRouter(): Promise<Router> {
  if (!router) router = new Router(buildRoutes(await getContainer()));
  return router;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  context: Context,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const traceId = context.awsRequestId;
  const started = Date.now();

  // Logs carry ids, never PII (§21).
  logger.addPersistentLogAttributes({ traceId });

  try {
    const documentation = documentationResponse(event.requestContext.http.method, event.rawPath);
    if (documentation) return documentation;
    const r = await getRouter();
    const response = await r.handle(event, traceId);

    logger.info('request', {
      method: event.requestContext?.http?.method,
      path: event.rawPath,
      status: response.statusCode,
      durationMs: Date.now() - started,
    });

    return response;
  } catch (e) {
    /*
     * `detail`, not `message`: the logger reserves `message` and silently dropped it, so
     * every 500 reached the log as `name: "error"` and nothing else. The Postgres code and
     * constraint are what make a database failure diagnosable from its traceId.
     */
    const pg = e as { code?: unknown; constraint?: unknown };
    logger.error('unhandled', {
      name: e instanceof Error ? e.name : 'unknown',
      detail: e instanceof Error ? e.message : String(e),
      ...(typeof pg?.code === 'string' ? { code: pg.code } : {}),
      ...(typeof pg?.constraint === 'string' ? { constraint: pg.constraint } : {}),
      durationMs: Date.now() - started,
    });
    // The traceId is the only way in (§16).
    return errorResponse(failure('INTERNAL_ERROR', 'An unexpected error occurred.'), traceId);
  }
};
