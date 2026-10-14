import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import html from './docs.html';
import contract from '../../../../packages/contracts/openapi.yaml';

/** Static documentation is served before initializing database connections. */
export function documentationResponse(
  method: string,
  rawPath: string,
): APIGatewayProxyStructuredResultV2 | undefined {
  if (method !== 'GET') return undefined;
  const path = rawPath.replace(/^\/(dev|prod|staging)(?=\/|$)/, '');
  const isUi = path === '/docs' || path === '/docs/';
  if (!isUi && path !== '/openapi.yaml') return undefined;
  return {
    statusCode: 200,
    headers: {
      'content-type': isUi ? 'text/html; charset=utf-8' : 'application/yaml; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
    body: isUi ? html : contract,
  };
}
