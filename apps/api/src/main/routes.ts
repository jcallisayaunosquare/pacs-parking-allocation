import { z } from 'zod';
import { failure } from '../shared/errors';
import type { Result } from '../shared/result';
import { csv, created, errorResponse, noContent, okJson } from '../shared/http/response';
import type { RequestContext, Route } from '../shared/http/router';
import { isAdmin } from '../modules/identity/domain/principal';
import type { AppContainer } from './composition-root';

/** Zod at the HTTP adapter: runtime validation plus inferred types (§10). */
const parse = <T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
): { ok: true; data: z.infer<T> } | { ok: false; details: { field: string; issue: string }[] } => {
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, data: r.data };
  return {
    ok: false,
    details: r.error.issues.map((i) => ({
      field: i.path.join('.') || '(body)',
      issue: i.message,
    })),
  };
};

const PAGE_LIMIT_CEILING = 100; // §16 cross-cutting rule

const limitSchema = z.coerce.number().int().min(1).max(PAGE_LIMIT_CEILING).default(25);
const uuid = z.string().uuid();
const spotType = z.enum(['STANDARD', 'ACCESSIBLE', 'EV']);

const residentCreateSchema = z.object({
  email: z.string().email().max(254),
  fullName: z.string().trim().min(1).max(200),
  unitNumber: z.string().trim().min(1).max(40),
  needsAccessibleSpot: z.boolean().optional(),
});

const residentPatchSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200).optional(),
    unitNumber: z.string().trim().min(1).max(40).optional(),
    needsAccessibleSpot: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'at least one field is required' });

const eligibilitySchema = z.object({
  isEligible: z.boolean(),
  reason: z.string().trim().max(500).nullable().optional(),
});

const spotCreateSchema = z.object({
  spotCode: z.string().trim().min(1).max(40),
  level: z.string().trim().min(1).max(20),
  type: spotType.optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const spotPatchSchema = z
  .object({
    level: z.string().trim().min(1).max(20).optional(),
    type: spotType.optional(),
    notes: z.string().max(2000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'at least one field is required' });

const cycleCreateSchema = z
  .object({
    label: z
      .string()
      .regex(/^\d{4}-Q[1-4]$/, 'must look like 2026-Q1')
      .optional(),
    startsOn: z.coerce.date(),
    endsOn: z.coerce.date(),
    registrationOpensAt: z.coerce.date(),
    registrationClosesAt: z.coerce.date(),
  })
  .refine((o) => o.endsOn > o.startsOn, {
    message: 'endsOn must be after startsOn',
    path: ['endsOn'],
  });

/** Unwraps a use-case Result into an HTTP response. */
const respond = <T>(
  r: Result<T>,
  ctx: RequestContext,
  present: (v: T) => ReturnType<typeof okJson> = (v) => okJson(v, ctx.traceId),
) => (r.ok ? present(r.value) : errorResponse(r.error, ctx.traceId));

const badRequest = (details: { field: string; issue: string }[], ctx: RequestContext) =>
  errorResponse(failure('VALIDATION_FAILED', 'The request failed validation.', details), ctx.traceId);

/**
 * The endpoint inventory of §16. `resolveResidentId` is the one place a resident's own
 * id is decided: always from the verified token, never from a path or query parameter,
 * so a resident cannot read another resident's data by changing a URL.
 */
export function buildRoutes(app: AppContainer): Route[] {
  /**
   * The one place a resident's own id is decided. It comes from the verified token and
   * nowhere else — never a path, query or body parameter — so a resident cannot read
   * another resident's data by editing a URL.
   *
   * Three sources, in order:
   *
   *   1. the `custom:resident_id` claim, when the token carries it
   *   2. the resident row already linked to this `sub`
   *   3. a `link#<sub>` item left by `integrations`, which provisioned the Cognito user
   *      from outside the VPC and had no route to the database to record the link
   *
   * Source 2 alone is not enough: Cognito puts custom attributes in the ID token only,
   * and the API is called with an access token, so the claim is normally absent.
   * Source 3 closes that loop on the resident's first authenticated request and then
   * deletes the item, so the link is written once and never looked up again.
   */
  const resolveResidentId = async (ctx: RequestContext): Promise<string | null> => {
    if (ctx.principal.residentId) return ctx.principal.residentId;

    const linked = await app.residentRepo.findBySubject(ctx.principal.subject);
    if (linked) return linked.id;

    const pending = await app.bus.findSubjectLink(ctx.principal.subject).catch(() => null);
    if (!pending) return null;

    await app.residentRepo.linkSubject(pending.residentId, ctx.principal.subject);
    await app.bus.clearSubjectLink(ctx.principal.subject).catch(() => undefined);
    return pending.residentId;
  };

  const routes: Route[] = [
    // ------------------------------------------------------------------ public
    {
      method: 'GET',
      path: '/health',
      handler: async (ctx) =>
        okJson({ status: 'ok', service: 'pacs-api', timestamp: new Date().toISOString() }, ctx.traceId),
    },

    // -------------------------------------------------------------------- self
    {
      method: 'GET',
      path: '/me',
      roles: ['RESIDENT', 'ADMIN'],
      handler: async (ctx) => {
        const id = await resolveResidentId(ctx);
        if (!id) {
          return okJson(
            {
              subject: ctx.principal.subject,
              email: ctx.principal.email,
              roles: ctx.principal.roles,
              resident: null,
            },
            ctx.traceId,
          );
        }
        const r = await app.residents.get(id);
        return respond(r, ctx, (resident) =>
          okJson(
            {
              subject: ctx.principal.subject,
              email: ctx.principal.email,
              roles: ctx.principal.roles,
              resident,
            },
            ctx.traceId,
          ),
        );
      },
    },
    {
      method: 'GET',
      path: '/me/dashboard',
      roles: ['RESIDENT', 'ADMIN'],
      handler: async (ctx) => {
        const id = await resolveResidentId(ctx);
        if (!id) return errorResponse(failure('NOT_FOUND', 'No resident record for this token.'), ctx.traceId);
        return respond(await app.dashboard.dashboard(id), ctx);
      },
    },
    {
      method: 'GET',
      path: '/me/history',
      roles: ['RESIDENT', 'ADMIN'],
      handler: async (ctx) => {
        const id = await resolveResidentId(ctx);
        if (!id) return errorResponse(failure('NOT_FOUND', 'No resident record for this token.'), ctx.traceId);
        const limit = parse(limitSchema, ctx.query.limit ?? undefined);
        if (!limit.ok) return badRequest(limit.details, ctx);
        return respond(await app.dashboard.history(id, limit.data), ctx, (items) =>
          okJson({ items, nextCursor: null }, ctx.traceId),
        );
      },
    },
    {
      method: 'POST',
      path: '/me/assignment/release',
      roles: ['RESIDENT', 'ADMIN'],
      handler: async (ctx) => {
        const id = await resolveResidentId(ctx);
        if (!id) return errorResponse(failure('NOT_FOUND', 'No resident record for this token.'), ctx.traceId);
        return respond(await app.cycles.releaseAssignment(id), ctx);
      },
    },

    // ----------------------------------------------------- registration (self)
    {
      method: 'POST',
      path: '/cycles/{id}/registrations',
      roles: ['RESIDENT', 'ADMIN'],
      handler: async (ctx) => {
        const id = await resolveResidentId(ctx);
        if (!id) return errorResponse(failure('NOT_FOUND', 'No resident record for this token.'), ctx.traceId);
        return respond(await app.cycles.register(ctx.params.id!, id), ctx, (v) =>
          created(v, ctx.traceId),
        );
      },
    },
    {
      method: 'DELETE',
      path: '/cycles/{id}/registrations/me',
      roles: ['RESIDENT', 'ADMIN'],
      handler: async (ctx) => {
        const id = await resolveResidentId(ctx);
        if (!id) return errorResponse(failure('NOT_FOUND', 'No resident record for this token.'), ctx.traceId);
        const r = await app.cycles.withdraw(ctx.params.id!, id);
        return r.ok ? noContent(ctx.traceId) : errorResponse(r.error, ctx.traceId);
      },
    },

    // --------------------------------------------------------------- residents
    {
      method: 'GET',
      path: '/residents',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const limit = parse(limitSchema, ctx.query.limit ?? undefined);
        if (!limit.ok) return badRequest(limit.details, ctx);
        const eligible =
          ctx.query.eligible === undefined ? undefined : ctx.query.eligible === 'true';
        return respond(
          await app.residents.list({
            limit: limit.data,
            ...(ctx.query.cursor ? { cursor: ctx.query.cursor } : {}),
            ...(ctx.query.unit ? { unit: ctx.query.unit } : {}),
            ...(eligible === undefined ? {} : { eligible }),
          }),
          ctx,
        );
      },
    },
    {
      method: 'POST',
      path: '/residents',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const b = parse(residentCreateSchema, ctx.body);
        if (!b.ok) return badRequest(b.details, ctx);
        return respond(await app.residents.create(b.data), ctx, (v) => created(v, ctx.traceId));
      },
    },
    {
      method: 'GET',
      path: '/residents/{id}',
      roles: ['ADMIN'],
      handler: async (ctx) => respond(await app.residents.get(ctx.params.id!), ctx),
    },
    {
      method: 'PATCH',
      path: '/residents/{id}',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const b = parse(residentPatchSchema, ctx.body);
        if (!b.ok) return badRequest(b.details, ctx);
        return respond(await app.residents.update(ctx.params.id!, b.data), ctx);
      },
    },
    {
      method: 'PATCH',
      path: '/residents/{id}/eligibility',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const b = parse(eligibilitySchema, ctx.body);
        if (!b.ok) return badRequest(b.details, ctx);
        return respond(
          await app.residents.setEligibility(ctx.params.id!, b.data.isEligible, b.data.reason ?? null),
          ctx,
        );
      },
    },
    {
      method: 'DELETE',
      path: '/residents/{id}',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const r = await app.residents.deactivate(ctx.params.id!);
        return r.ok ? noContent(ctx.traceId) : errorResponse(r.error, ctx.traceId);
      },
    },

    // ------------------------------------------------------------------- spots
    {
      method: 'GET',
      path: '/spots',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const type = ctx.query.type ? spotType.safeParse(ctx.query.type) : undefined;
        if (type && !type.success) {
          return badRequest([{ field: 'type', issue: 'must be STANDARD, ACCESSIBLE or EV' }], ctx);
        }
        return respond(
          await app.spots.list({
            activeOnly: ctx.query.activeOnly === 'true',
            ...(type?.success ? { type: type.data } : {}),
          }),
          ctx,
          (items) => okJson({ items }, ctx.traceId),
        );
      },
    },
    {
      method: 'POST',
      path: '/spots',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const b = parse(spotCreateSchema, ctx.body);
        if (!b.ok) return badRequest(b.details, ctx);
        return respond(await app.spots.create(b.data), ctx, (v) => created(v, ctx.traceId));
      },
    },
    {
      method: 'PATCH',
      path: '/spots/{id}',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const b = parse(spotPatchSchema, ctx.body);
        if (!b.ok) return badRequest(b.details, ctx);
        return respond(await app.spots.update(ctx.params.id!, b.data), ctx);
      },
    },

    // ------------------------------------------------------------------ cycles
    {
      method: 'GET',
      path: '/cycles',
      roles: ['ADMIN', 'RESIDENT'],
      handler: async (ctx) => respond(await app.cycles.list(), ctx, (items) => okJson({ items }, ctx.traceId)),
    },
    {
      method: 'POST',
      path: '/cycles',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const b = parse(cycleCreateSchema, ctx.body);
        if (!b.ok) return badRequest(b.details, ctx);
        return respond(await app.cycles.create(b.data), ctx, (v) => created(v, ctx.traceId));
      },
    },
    {
      method: 'POST',
      path: '/cycles/{id}/open-registration',
      roles: ['ADMIN'],
      handler: async (ctx) =>
        respond(await app.cycles.guardedTransition(ctx.params.id!, 'REGISTRATION_OPEN'), ctx),
    },
    {
      method: 'POST',
      path: '/cycles/{id}/close-registration',
      roles: ['ADMIN'],
      handler: async (ctx) =>
        respond(await app.cycles.guardedTransition(ctx.params.id!, 'REGISTRATION_CLOSED'), ctx),
    },

    // -------------------------------------------------------------------- runs
    {
      method: 'POST',
      path: '/cycles/{id}/runs',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        // §16: the header is required, so a retried click cannot draw twice.
        if (!ctx.idempotencyKey) {
          return badRequest(
            [{ field: 'Idempotency-Key', issue: 'header is required on this route' }],
            ctx,
          );
        }
        return respond(
          await app.executeRun.execute({
            cycleId: ctx.params.id!,
            idempotencyKey: ctx.idempotencyKey.slice(0, 200),
          }),
          ctx,
        );
      },
    },
    {
      method: 'GET',
      path: '/runs/{id}',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const run = await app.allocationRepo.findRun(ctx.params.id!);
        if (!run) return errorResponse(failure('NOT_FOUND', 'Run not found.'), ctx.traceId);
        return okJson(
          {
            runId: run.id,
            cycleId: run.cycleId,
            state: run.state,
            algorithmVersion: run.algorithmVersion,
            // The seed is deliberately exposed: it is what makes the run auditable (§16).
            randomSeed: Number(run.randomSeed),
            entrants: run.entrantsCount,
            spots: run.spotsCount,
            assigned: run.assignedCount,
            startedAt: run.startedAt.toISOString(),
            finishedAt: run.finishedAt?.toISOString() ?? null,
            errorDetail: run.errorDetail,
          },
          ctx.traceId,
        );
      },
    },
    {
      method: 'GET',
      path: '/runs/{id}/assignments',
      roles: ['ADMIN'],
      handler: async (ctx) =>
        respond(await app.dashboard.runAssignments(ctx.params.id!), ctx, (items) =>
          okJson({ items }, ctx.traceId),
        ),
    },

    // ---------------------------------------------------- metrics and reports
    {
      method: 'GET',
      path: '/metrics/fairness',
      roles: ['ADMIN'],
      handler: async (ctx) => respond(await app.dashboard.metrics(), ctx),
    },
    {
      method: 'GET',
      path: '/reports/quarterly/{cycleId}',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const r = await app.dashboard.quarterlyReport(ctx.params.cycleId!);
        if (!r.ok) return errorResponse(r.error, ctx.traceId);
        if (ctx.query.format === 'csv') {
          return csv(r.value as never, `pacs-${ctx.params.cycleId}.csv`, ctx.traceId);
        }
        return okJson({ items: r.value }, ctx.traceId);
      },
    },
  ];

  return routes;
}

/** Exported for the smoke test and for the OpenAPI drift check. */
export const ADMIN_ONLY_PATHS = [
  '/residents',
  '/spots',
  '/metrics/fairness',
  '/reports/quarterly/{cycleId}',
] as const;

export { isAdmin };
