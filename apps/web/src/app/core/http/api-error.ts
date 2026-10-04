import { HttpErrorResponse } from '@angular/common/http';
import type { ApiError } from '../../domain/models';

/**
 * One place that turns a transport failure into the domain's `ApiError`.
 *
 * The server already speaks one error shape (§16), so the happy path is a straight
 * read. The rest of this function is the cases that shape never arrives in: a network
 * failure, a CORS rejection, an HTML error page from an edge that never reached the API.
 */
export function toApiError(e: unknown): ApiError {
  if (e instanceof HttpErrorResponse) {
    const body = e.error as
      | {
          error?: string;
          message?: string;
          traceId?: string;
          details?: readonly { field: string; issue: string }[];
        }
      | string
      | null;

    // status 0 means the request never got an answer: offline, DNS, blocked by CORS.
    if (e.status === 0) {
      return {
        code: 'NETWORK_ERROR',
        message: 'No se pudo contactar el servidor. Revisá tu conexión.',
        traceId: null,
        status: 0,
      };
    }

    if (body && typeof body === 'object' && body.error) {
      return {
        code: body.error,
        message: body.message ?? 'La solicitud falló.',
        ...(body.details ? { details: body.details } : {}),
        traceId: body.traceId ?? e.headers.get('x-trace-id'),
        status: e.status,
      };
    }

    return {
      code: `HTTP_${e.status}`,
      message: typeof body === 'string' && body.length < 200 ? body : e.statusText,
      traceId: e.headers.get('x-trace-id'),
      status: e.status,
    };
  }

  return {
    code: 'UNKNOWN',
    message: e instanceof Error ? e.message : String(e),
    traceId: null,
    status: -1,
  };
}

export const isForbidden = (e: ApiError): boolean => e.status === 403;
export const isNotFound = (e: ApiError): boolean => e.status === 404;
