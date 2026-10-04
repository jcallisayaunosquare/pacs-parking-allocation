import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { failure } from '../errors';
import type { Principal, Role } from '../../modules/identity/domain/principal';
import { principalFromClaims } from '../../modules/identity/domain/principal';
import { errorResponse, json } from './response';

/**
 * A small router instead of a framework. The lambdalith (ADR-014) handles every route in
 * one function, so the cost of routing is paid on every request — a dependency-free
 * matcher keeps the cold-start bundle small (§10, cold-start note).
 */

export interface RequestContext {
  readonly principal: Principal;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly traceId: string;
  readonly idempotencyKey: string | null;
}

export type Handler = (ctx: RequestContext) => Promise<APIGatewayProxyStructuredResultV2>;

export interface Route {
  readonly method: string;
  /** Path pattern with `{name}` placeholders, e.g. `/cycles/{id}/runs`. */
  readonly path: string;
  /** Omit for a public route; otherwise the caller must hold one of these roles. */
  readonly roles?: readonly Role[];
  readonly handler: Handler;
}

interface CompiledRoute extends Route {
  readonly regex: RegExp;
  readonly keys: readonly string[];
}

const compile = (route: Route): CompiledRoute => {
  const keys: string[] = [];
  const pattern = route.path
    .split('/')
    .map((seg) => {
      const m = /^\{(.+)\}$/.exec(seg);
      if (!m?.[1]) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      keys.push(m[1]);
      return '([^/]+)';
    })
    .join('/');
  return { ...route, keys, regex: new RegExp(`^${pattern}/?$`) };
};

export class Router {
  private readonly routes: CompiledRoute[];

  constructor(routes: readonly Route[]) {
    this.routes = routes.map(compile);
  }

  async handle(
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
    traceId: string,
  ): Promise<APIGatewayProxyStructuredResultV2> {
    const method = event.requestContext.http.method.toUpperCase();
    const rawPath = event.rawPath || '/';
    // API Gateway stages prepend the stage name when the API has one.
    const path = rawPath.replace(/^\/(dev|prod|staging)(?=\/|$)/, '') || '/';

    const byPath = this.routes.filter((r) => r.regex.test(path));
    if (byPath.length === 0) {
      return errorResponse(failure('NOT_FOUND', 'No such route.'), traceId);
    }

    const route = byPath.find((r) => r.method === method);
    if (!route) {
      return json(
        405,
        {
          error: 'METHOD_NOT_ALLOWED',
          message: `${method} is not allowed on this route.`,
          traceId,
          timestamp: new Date().toISOString(),
        },
        traceId,
        { allow: [...new Set(byPath.map((r) => r.method))].join(', ') },
      );
    }

    // ----------------------------------------------------------------- authn
    let principal: Principal | null = null;
    if (route.roles) {
      principal = principalFromClaims(
        event.requestContext.authorizer?.jwt?.claims as Record<string, unknown> | undefined,
      );
      if (!principal) {
        return errorResponse(
          failure('UNAUTHENTICATED', 'A valid bearer token is required.'),
          traceId,
        );
      }
      // ---------------------------------------------------------------- authz
      const allowed = route.roles.some((r) => principal!.roles.includes(r));
      if (!allowed) {
        return errorResponse(failure('FORBIDDEN', 'Your role does not allow this action.'), traceId);
      }
      // No check here for a resident id. The router knows only what the token says,
      // and a Cognito access token does not carry `custom:resident_id` — custom
      // attributes live in the ID token. Resolving the caller's resident row needs a
      // repository lookup, so it belongs in the handler (`resolveResidentId`), which
      // answers NOT_FOUND when the subject matches no resident.
    }

    // --------------------------------------------------------------- params
    const match = route.regex.exec(path);
    const params: Record<string, string> = {};
    route.keys.forEach((k, i) => {
      const v = match?.[i + 1];
      if (v !== undefined) params[k] = decodeURIComponent(v);
    });

    // Every {id} in the contract is a UUID — reject anything else before it reaches a
    // query, so ids cannot be probed or enumerated (§16).
    for (const [k, v] of Object.entries(params)) {
      if (k.toLowerCase().endsWith('id') && !z.string().uuid().safeParse(v).success) {
        return errorResponse(
          failure('VALIDATION_FAILED', 'Malformed identifier.', [{ field: k, issue: 'must be a UUID' }]),
          traceId,
        );
      }
    }

    // ----------------------------------------------------------------- body
    let body: unknown = undefined;
    if (event.body) {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        return errorResponse(failure('VALIDATION_FAILED', 'The request body is not valid JSON.'), traceId);
      }
    }

    const headers = event.headers ?? {};
    const idempotencyKey =
      headers['idempotency-key'] ?? headers['Idempotency-Key'] ?? null;

    return route.handler({
      principal: principal ?? {
        subject: 'anonymous',
        email: null,
        roles: [],
        residentId: null,
      },
      params,
      query: (event.queryStringParameters ?? {}) as Record<string, string>,
      body,
      traceId,
      idempotencyKey,
    });
  }
}
