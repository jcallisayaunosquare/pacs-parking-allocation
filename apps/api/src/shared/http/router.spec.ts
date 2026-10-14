import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { Router } from './router';

const get = (rawPath: string) =>
  ({
    rawPath,
    requestContext: { http: { method: 'GET' } },
    headers: {},
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

/**
 * Path parameters and the UUID rule.
 *
 * The router assumes every parameter whose name ends in "id" is a UUID and refuses
 * anything else before a handler runs. That is right for `{id}`, `{cycleId}` and the
 * rest, and it is why GET /lots/{levelId}/occupancy answered 400 to `B1` on its first
 * deploy: a level is a code, not a UUID, so its parameter must not be named like one.
 */
describe('Router path parameters', () => {
  const ok = { statusCode: 200, body: '' };

  it('passes a level code through a parameter that is not named like an id', async () => {
    let seen: Record<string, string> = {};
    const router = new Router([
      {
        method: 'GET',
        path: '/lots/{level}/occupancy',
        handler: async (ctx) => {
          seen = { ...ctx.params };
          return ok;
        },
      },
    ]);
    const res = await router.handle(get('/lots/B1/occupancy'), 't');
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual({ level: 'B1' });
  });

  it('refuses a non-UUID value in a parameter whose name ends in "id"', async () => {
    const router = new Router([
      { method: 'GET', path: '/lots/{levelId}/occupancy', handler: async () => ok },
    ]);
    const res = await router.handle(get('/lots/B1/occupancy'), 't');
    expect(res.statusCode).toBe(400);
  });
});
