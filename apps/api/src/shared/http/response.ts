import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { DomainFailure, DomainFailureCode } from '../result';

/** §16: one error shape for every failure. No stack traces, no database text. */
const STATUS_BY_CODE: Readonly<Record<DomainFailureCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_ELIGIBLE: 403,
  NOT_FOUND: 404,
  RAFFLE_IN_PROGRESS: 409,
  REGISTRATION_CLOSED: 409,
  SPOT_IN_USE: 409,
  ALREADY_REGISTERED: 409,
  INVALID_CYCLE_STATE: 422,
  NO_SPOTS_AVAILABLE: 422,
  INTERNAL_ERROR: 500,
};

const baseHeaders = (traceId: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-trace-id': traceId,
  // Defence in depth: the CloudFront response-headers policy sets these too (§10).
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

export const json = (
  statusCode: number,
  body: unknown,
  traceId: string,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { ...baseHeaders(traceId), ...extraHeaders },
  body: JSON.stringify(body),
});

export const okJson = (body: unknown, traceId: string): APIGatewayProxyStructuredResultV2 =>
  json(200, body, traceId);

export const created = (body: unknown, traceId: string): APIGatewayProxyStructuredResultV2 =>
  json(201, body, traceId);

export const noContent = (traceId: string): APIGatewayProxyStructuredResultV2 => ({
  statusCode: 204,
  headers: baseHeaders(traceId),
  body: '',
});

export function errorResponse(
  failure: DomainFailure,
  traceId: string,
): APIGatewayProxyStructuredResultV2 {
  const statusCode = STATUS_BY_CODE[failure.code] ?? 500;
  return json(
    statusCode,
    {
      error: failure.code,
      // A 500 must never leak the internal message (§16).
      message: statusCode === 500 ? 'An unexpected error occurred.' : failure.message,
      ...(failure.details ? { details: failure.details } : {}),
      traceId,
      timestamp: new Date().toISOString(),
    },
    traceId,
  );
}

export const csv = (
  rows: readonly Record<string, unknown>[],
  filename: string,
  traceId: string,
): APIGatewayProxyStructuredResultV2 => {
  const headerRow = rows[0] ? Object.keys(rows[0]) : [];
  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [
    headerRow.join(','),
    ...rows.map((r) => headerRow.map((h) => escape(r[h])).join(',')),
  ].join('\n');

  return {
    statusCode: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'x-trace-id': traceId,
    },
    body,
  };
};
