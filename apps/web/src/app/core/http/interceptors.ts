import { inject } from '@angular/core';
import type { HttpInterceptorFn } from '@angular/common/http';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { from, switchMap, tap } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Attaches the bearer token, but only to our own API. A token sent to any other origin
 * is a credential leak, so the host is checked rather than assumed (§18).
 *
 * `/health` is deliberately left unauthenticated so the readiness check keeps working
 * when nobody is signed in.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const oidc = inject(OidcSecurityService);

  const isOwnApi = req.url.startsWith(environment.apiBaseUrl);
  const isPublic = req.url.endsWith('/health');
  if (!isOwnApi || isPublic) return next(req);

  return from(oidc.getAccessToken()).pipe(
    switchMap((token) =>
      next(
        token
          ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
          : req,
      ),
    ),
  );
};

/**
 * Records the correlation id of the last failed request. §17 asks for a copyable trace
 * id in the error copy, and §21 matches it to the server's log line — this is the one
 * thread between a user saying "it broke" and the request that broke.
 */
let lastTraceId: string | null = null;
export const getLastTraceId = (): string | null => lastTraceId;

export const traceInterceptor: HttpInterceptorFn = (req, next) =>
  next(req).pipe(
    tap({
      next: (event) => {
        const headers = (event as { headers?: { get(n: string): string | null } }).headers;
        const id = headers?.get('x-trace-id');
        if (id) lastTraceId = id;
      },
      error: (e: { headers?: { get(n: string): string | null } }) => {
        const id = e.headers?.get?.('x-trace-id');
        if (id) lastTraceId = id;
      },
    }),
  );
