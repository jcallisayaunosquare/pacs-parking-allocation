import { z } from 'zod';
import { failure } from '../shared/errors';
import type { Result } from '../shared/result';
import { toDateOnly } from '../shared/clock';
import { csv, created, errorResponse, noContent, okJson } from '../shared/http/response';
import type { RequestContext, Route } from '../shared/http/router';
import { hasResidentSurface, isAdmin } from '../modules/identity/domain/principal';
import { normalizePlate } from '../modules/residents/domain/vehicle';
import {
  ADMIN_NOT_ELIGIBLE_REASON,
  RESIDENT_SORT_FIELDS,
} from '../modules/residents/application/resident.use-cases';
import type { AppContainer } from './composition-root';

/** Zod at the HTTP adapter: runtime validation plus inferred types (section 10). */
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

const PAGE_LIMIT_CEILING = 100; // section 16 cross-cutting rule

const limitSchema = z.coerce.number().int().min(1).max(PAGE_LIMIT_CEILING).default(15);
const sortFieldSchema = z.enum(RESIDENT_SORT_FIELDS).default('created');
const sortDirSchema = z.enum(['asc', 'desc']).default('asc');
const uuid = z.string().uuid();
const spotType = z.enum(['STANDARD', 'ACCESSIBLE', 'EV']);

const residentCreateSchema = z.object({
  email: z.string().email().max(254),
  fullName: z.string().trim().min(1).max(200),
  unitNumber: z.string().trim().min(1).max(40),
  needsAccessibleSpot: z.boolean().optional(),
  hasElectricVehicle: z.boolean().optional(),
  /** Separation of duties: an administrator account never holds a bay or enters the draw. */
  isAdmin: z.boolean().optional(),
});

const residentPatchSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200).optional(),
    unitNumber: z.string().trim().min(1).max(40).optional(),
    needsAccessibleSpot: z.boolean().optional(),
    hasElectricVehicle: z.boolean().optional(),
    isAdmin: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'at least one field is required' });

/** Rule C's anchor, as an admin correction with an audit row behind it. */
const participationStartSchema = z.object({
  participationStartedAt: z.coerce.date(),
});

/**
 * Rule A, on the wire. Every field optional: a PATCH changes one knob, and the use case
 * inserts a whole new version built from the one in force.
 */
const configPatchSchema = z
  .object({
    allocationDurationMonths: z.number().int().min(1).max(60).optional(),
    earlyWaitingBiasHours: z.number().int().min(0).max(8760).optional(),
    waitQuantumMinutes: z.number().int().min(1).optional(),
    absenceResetPeriods: z.number().int().min(1).nullable().optional(),
    totalBays: z.number().int().min(0).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'at least one field is required' });

/**
 * A vehicle on the wire.
 *
 * The plate is taken as free text and normalised in the domain rather than constrained
 * to a pattern here: a resident types "abc-123" and the register has to accept it. What
 * zod enforces is a sane length and a string, and the domain decides what the plate
 * actually is - one definition of "the same plate", shared with the uniqueness index and
 * with the gate lookup.
 *
 * `photos` is a list of object keys or URLs and nothing more. There is no upload
 * pipeline: an S3 presigned PUT per photo is the intended follow-up, and until it
 * exists this field stores what the caller sends.
 */
const photosSchema = z.array(z.string().trim().min(1).max(512)).max(8);

const vehicleCreateSchema = z.object({
  plate: z.string().trim().min(1).max(40),
  make: z.string().trim().max(80).nullable().optional(),
  model: z.string().trim().max(80).nullable().optional(),
  year: z.number().int().nullable().optional(),
  colour: z.string().trim().max(40).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  photos: photosSchema.optional(),
});

const vehiclePatchSchema = z
  .object({
    plate: z.string().trim().min(1).max(40).optional(),
    make: z.string().trim().max(80).nullable().optional(),
    model: z.string().trim().max(80).nullable().optional(),
    year: z.number().int().nullable().optional(),
    colour: z.string().trim().max(40).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    photos: photosSchema.optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'at least one field is required' });

/**
 * The capture ticket request (M-7).
 *
 * `capturedAt` is taken from the camera and carried into the row, but it does NOT decide
 * the object key - the server's clock does. A camera with a drifting clock would otherwise
 * file its frames under the wrong day prefix and quietly break both the lifecycle rules
 * and the day listings, and the skew would be invisible. Here it stays visible.
 *
 * No `objectKey` field, deliberately: the client is a device in a car park, and letting
 * it name the key lets it write outside its own prefix - which the IAM statement scoped
 * to `raw/*` would still permit.
 */
const captureRequestSchema = z.object({
  cameraId: z.string().trim().min(3).max(64),
  capturedAt: z.coerce.date(),
  contentType: z.enum(['image/jpeg', 'image/png']).default('image/jpeg'),
});

const plateReadStatus = z.enum(['MATCHED', 'UNMATCHED', 'REVIEW', 'DISCARDED']);
const accessDecisionFilter = z.enum(['ALLOW', 'DENY', 'REVIEW']);

/**
 * The review verdict.
 *
 * `plate` is free text and is normalised in the domain, for the same reason the vehicle
 * register takes it that way: an administrator reading a frame types what they see,
 * punctuation and all, and one definition of "the same plate" has to serve the register,
 * the gate and this screen.
 *
 * `discard` is a separate flag rather than a third value of `decision`, because discarding
 * is not a decision about an entry at all - it produces no access event. Folding it into
 * the enum would make every reader of the access log wonder what a DISCARD row means.
 */
const plateReviewSchema = z
  .object({
    plate: z.string().trim().min(1).max(40).nullable().optional(),
    vehicleId: uuid.nullable().optional(),
    decision: z.enum(['ALLOW', 'DENY']),
    note: z.string().max(2000).nullable().optional(),
    discard: z.boolean().optional(),
  })
  .refine((o) => o.discard !== true || o.decision === 'DENY', {
    message: 'a discarded frame cannot be an ALLOW',
    path: ['discard'],
  });

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

/**
 * `endsOn` is optional and the label is free text: both used to assume quarters. The end
 * of the period is derived from the configured allocation duration when it is left out,
 * and a label pattern that hard-codes Q1..Q4 would make rule A unimplementable.
 */
const cycleRenameSchema = z.object({ label: z.string().trim().min(1).max(20) });

const cycleCreateSchema = z
  .object({
    label: z.string().trim().min(1).max(20).optional(),
    startsOn: z.coerce.date(),
    endsOn: z.coerce.date().optional(),
    registrationOpensAt: z.coerce.date(),
    registrationClosesAt: z.coerce.date(),
  })
  .refine((o) => o.endsOn === undefined || o.endsOn > o.startsOn, {
    message: 'endsOn must be after startsOn',
    path: ['endsOn'],
  });

/** Unwraps a use-case Result into an HTTP response. */
const respond = <T>(
  r: Result<T>,
  ctx: RequestContext,
  present: (v: T) => ReturnType<typeof okJson> = (v) => okJson(v, ctx.traceId),
) => (r.ok ? present(r.value) : errorResponse(r.error, ctx.traceId));

/**
 * Cycles on the wire. `startsOn` and `endsOn` are calendar days, not instants, so they
 * go out as `YYYY-MM-DD` - the contract's `format: date`. Serialising them as
 * timestamps made a quarter starting on 1 January read as 31 December for anyone west
 * of UTC.
 */
const presentCycle = (c: {
  id: string;
  label: string;
  startsOn: Date;
  endsOn: Date;
  state: string;
  registrationOpensAt: Date;
  registrationClosesAt: Date;
}) => ({
  id: c.id,
  label: c.label,
  state: c.state,
  startsOn: toDateOnly(c.startsOn),
  endsOn: toDateOnly(c.endsOn),
  registrationOpensAt: c.registrationOpensAt.toISOString(),
  registrationClosesAt: c.registrationClosesAt.toISOString(),
});

/**
 * A vehicle on the wire. Both plate forms go out, because they answer different
 * questions: `plateDisplay` is what the resident typed and what the register prints,
 * `plate` is the canonical key the gate matches against - and a resident contesting "the
 * camera says my plate is not registered" needs to see the second one.
 */
const presentVehicle = (v: {
  id: string;
  residentId: string;
  plate: string;
  plateDisplay: string;
  make: string | null;
  model: string | null;
  year: number | null;
  colour: string | null;
  notes: string | null;
  photos: readonly string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: v.id,
  residentId: v.residentId,
  plate: v.plate,
  plateDisplay: v.plateDisplay,
  make: v.make,
  model: v.model,
  year: v.year,
  colour: v.colour,
  notes: v.notes,
  photos: [...v.photos],
  isActive: v.isActive,
  createdAt: v.createdAt.toISOString(),
  updatedAt: v.updatedAt.toISOString(),
});

/**
 * A gate-log row on the wire.
 *
 * Both plate forms go out for the same reason the vehicle register sends both: `plate` is
 * the canonical form the match was made on, `rawText` is what the camera actually read,
 * and a resident disputing "the gate says my plate is not registered" needs to see the
 * difference between the two. `fused` goes out beside `confidence` and `quality` rather
 * than instead of them - a reviewer who sees only the product cannot tell a blurred frame
 * the engine was sure about from a sharp frame it was not, and those are opposite faults.
 */
const presentPlateRead = (row: {
  read: {
    id: string;
    captureId: string;
    cameraId: string;
    capturedAt: Date;
    rawText: string | null;
    plate: string | null;
    confidence: number;
    quality: number | null;
    fused: number;
    status: string;
    vehicleId: string | null;
    matchKind: string;
    matchDistance: number | null;
    imageKey: string;
    cropKey: string | null;
    engine: string;
    engineVersion: string | null;
    latencyMs: number | null;
    reviewedAt: Date | null;
    reviewedBy: string | null;
    reviewNote: string | null;
    correctedPlate: string | null;
    candidates: readonly { plate: string; raw: string; confidence: number; score: number }[];
  };
  decision: {
    id: string;
    decision: string;
    reason: string;
    occurredAt: Date;
    residentId: string | null;
    spotId: string | null;
  } | null;
  residentName: string | null;
  unitNumber: string | null;
  spotCode: string | null;
  registeredPlate: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
  vehicleColour: string | null;
}) => ({
  id: row.read.id,
  captureId: row.read.captureId,
  cameraId: row.read.cameraId,
  capturedAt: row.read.capturedAt.toISOString(),
  rawText: row.read.rawText,
  plate: row.read.plate,
  registeredPlate: row.registeredPlate,
  unitNumber: row.unitNumber,
  // The car as the register describes it. Flat fields rather than a nested object: every
  // one of them is null for an unmatched read, and a `vehicle: null` would make the
  // client branch twice to print one line.
  vehicleMake: row.vehicleMake,
  vehicleModel: row.vehicleModel,
  vehicleYear: row.vehicleYear,
  vehicleColour: row.vehicleColour,
  confidence: row.read.confidence,
  quality: row.read.quality,
  fused: Number(row.read.fused.toFixed(4)),
  status: row.read.status,
  matchKind: row.read.matchKind,
  matchDistance: row.read.matchDistance,
  vehicleId: row.read.vehicleId,
  residentId: row.decision?.residentId ?? null,
  residentName: row.residentName,
  spotCode: row.spotCode,
  decision: row.decision?.decision ?? null,
  reason: row.decision?.reason ?? null,
  // The capture reference, not a URL: images are never served by the API, and a list of
  // fifty rows does not hand out fifty five-minute credentials to frames of people's cars.
  imageKey: row.read.imageKey,
  cropKey: row.read.cropKey,
  engine: row.read.engine,
  engineVersion: row.read.engineVersion,
  latencyMs: row.read.latencyMs,
  needsReview: row.read.status === 'REVIEW' && row.read.reviewedAt === null,
  reviewedAt: row.read.reviewedAt?.toISOString() ?? null,
  reviewedBy: row.read.reviewedBy,
  reviewNote: row.read.reviewNote,
  correctedPlate: row.read.correctedPlate,
  candidates: row.read.candidates.map((c) => ({
    plate: c.plate,
    raw: c.raw,
    confidence: c.confidence,
    score: c.score,
  })),
});

const presentAccessEvent = (e: {
  id: string;
  plateReadId: string;
  captureId: string;
  plate: string;
  vehicleId: string | null;
  residentId: string | null;
  residentName: string | null;
  unitNumber: string | null;
  spotId: string | null;
  spotCode: string | null;
  decision: string;
  reason: string;
  cameraId: string;
  occurredAt: Date;
  supersededBy: string | null;
}) => ({
  id: e.id,
  plateReadId: e.plateReadId,
  captureId: e.captureId,
  plate: e.plate,
  vehicleId: e.vehicleId,
  residentId: e.residentId,
  residentName: e.residentName,
  unitNumber: e.unitNumber,
  spotCode: e.spotCode,
  decision: e.decision,
  reason: e.reason,
  cameraId: e.cameraId,
  occurredAt: e.occurredAt.toISOString(),
  /** Non-null means an administrator overturned this row. The row itself never changed. */
  supersededBy: e.supersededBy,
});

const badRequest = (details: { field: string; issue: string }[], ctx: RequestContext) =>
  errorResponse(failure('VALIDATION_FAILED', 'The request failed validation.', details), ctx.traceId);

/**
 * The endpoint inventory of section 16. `resolveResidentId` is the one place a resident's own
 * id is decided: always from the verified token, never from a path or query parameter,
 * so a resident cannot read another resident's data by changing a URL.
 */
export function buildRoutes(app: AppContainer): Route[] {
  /**
   * The one place a resident's own id is decided. It comes from the verified token and
   * nowhere else - never a path, query or body parameter - so a resident cannot read
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

  /**
   * The resident surface, refused to an administrator.
   *
   * These routes back "My parking" and "History" - a resident's own bay, their own draw
   * history, the bay they give up. PRODUCT.md puts an administrator outside all of it:
   * they operate the draw, so they never hold a bay and never enter one. The guards in
   * the web app hide these screens from an administrator; this is the boundary that makes
   * it true, because a guard is only usability (section 17).
   *
   * It cannot be said with the route's `roles` list: that list is an OR, so a principal
   * carrying both groups - the one person who is genuinely both in a small building -
   * satisfies `['RESIDENT']` and walks straight through. Denying on a role takes a check.
   *
   * Returns null when the caller may proceed, so a handler reads as a one-line guard.
   */
  const adminHasNoResidentSurface = (ctx: RequestContext) =>
    hasResidentSurface(ctx.principal)
      ? null
      : errorResponse(failure('FORBIDDEN', ADMIN_NOT_ELIGIBLE_REASON), ctx.traceId);

  /**
   * The vehicle register's authorisation rule: an administrator may manage anyone's
   * vehicles, a resident only their own.
   *
   * It cannot be said with the route's `roles` list, which is an OR over groups and
   * knows nothing about which record is being touched. So the path id is compared with
   * the id the token resolves to - and only ever with that, never with a body or query
   * field, for the same reason `resolveResidentId` exists at all.
   *
   * A resident reaching for someone else's record is answered NOT_FOUND rather than
   * FORBIDDEN: a 403 would confirm that the record exists, which turns the route into a
   * way of enumerating residents by trying ids.
   *
   * Returns the resident id to operate on, or the response that refuses.
   */
  const residentScope = async (
    ctx: RequestContext,
  ): Promise<{ ok: true; residentId: string } | { ok: false; response: ReturnType<typeof errorResponse> }> => {
    const target = ctx.params.id!;
    if (isAdmin(ctx.principal)) return { ok: true, residentId: target };

    const own = await resolveResidentId(ctx);
    if (!own) {
      return {
        ok: false,
        response: errorResponse(failure('NOT_FOUND', 'No resident record for this token.'), ctx.traceId),
      };
    }
    if (own !== target) {
      return {
        ok: false,
        response: errorResponse(failure('NOT_FOUND', 'Resident not found.'), ctx.traceId),
      };
    }
    return { ok: true, residentId: own };
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
        const refused = adminHasNoResidentSurface(ctx);
        if (refused) return refused;
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
        const refused = adminHasNoResidentSurface(ctx);
        if (refused) return refused;
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
        const refused = adminHasNoResidentSurface(ctx);
        if (refused) return refused;
        const id = await resolveResidentId(ctx);
        if (!id) return errorResponse(failure('NOT_FOUND', 'No resident record for this token.'), ctx.traceId);
        return respond(await app.cycles.releaseAssignment(id), ctx);
      },
    },

    // ----------------------------------------------------- registration (self)
    /*
     * The entrants of a period, for the draw screen. It used to list every eligible
     * resident and call that the register the draw would use - which it is not: only a
     * resident who entered is drawn, and the screen showed people who never had.
     */
    {
      method: 'GET',
      path: '/cycles/{id}/registrations',
      roles: ['ADMIN'],
      handler: async (ctx) =>
        respond(await app.cycles.entrants(ctx.params.id!), ctx, (items) =>
          okJson(
            { items: items.map((e) => ({ ...e, registeredAt: e.registeredAt.toISOString() })) },
            ctx.traceId,
          ),
        ),
    },
    {
      method: 'POST',
      path: '/cycles/{id}/registrations',
      roles: ['RESIDENT', 'ADMIN'],
      handler: async (ctx) => {
        const id = await resolveResidentId(ctx);
        if (!id) return errorResponse(failure('NOT_FOUND', 'No resident record for this token.'), ctx.traceId);
        // The role on the token is handed to the use case rather than checked here, so
        // the separation-of-duties rule stays in one place with the `resident.is_admin`
        // check it backs up, and is unit-testable without an HTTP event.
        return respond(await app.cycles.register(ctx.params.id!, id, isAdmin(ctx.principal)), ctx, (v) =>
          created(v, ctx.traceId),
        );
      },
    },
    {
      method: 'DELETE',
      path: '/cycles/{id}/registrations/me',
      roles: ['RESIDENT', 'ADMIN'],
      // Withdrawal is deliberately NOT refused to an administrator. It only ever removes a
      // registration, and an account that was promoted to administrator after it had
      // already registered needs a way out of the draw it may no longer enter.
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

        // Sort keys are an allowlist, never a column name off the query string: that
        // is how a sort parameter turns into an injection point (A03).
        const sort = parse(sortFieldSchema, ctx.query.sort ?? undefined);
        if (!sort.ok) return badRequest(sort.details, ctx);
        const dir = parse(sortDirSchema, ctx.query.dir ?? undefined);
        if (!dir.ok) return badRequest(dir.details, ctx);

        const eligible =
          ctx.query.eligible === undefined ? undefined : ctx.query.eligible === 'true';

        return respond(
          await app.residents.list({
            limit: limit.data,
            sort: sort.data,
            dir: dir.data,
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
      /*
       * The detail view carries the resident's vehicles.
       *
       * Composed here from two use cases rather than joined in one, because the register
       * list does not want them and the rings should not grow a resident-with-vehicles
       * read model for the sake of one screen. The list stays a keyset page over
       * `resident` alone; only the detail pays for the second query.
       *
       * The vehicles are a best-effort addition: if that query fails the resident is
       * still returned, with an empty list, because the record is what was asked for.
       */
      handler: async (ctx) => {
        const resident = await app.residents.get(ctx.params.id!);
        if (!resident.ok) return errorResponse(resident.error, ctx.traceId);
        const vehicles = await app.vehicles.list(ctx.params.id!);
        return okJson(
          {
            ...resident.value,
            vehicles: vehicles.ok ? vehicles.value.map(presentVehicle) : [],
          },
          ctx.traceId,
        );
      },
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
      method: 'PATCH',
      path: '/residents/{id}/participation-start',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const b = parse(participationStartSchema, ctx.body);
        if (!b.ok) return badRequest(b.details, ctx);
        return respond(
          await app.residents.setParticipationStart(ctx.params.id!, b.data.participationStartedAt),
          ctx,
        );
      },
    },
    {
      method: 'DELETE',
      path: '/residents/{id}',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        /*
         * One request, two outcomes: the row is deleted when nothing in the record names
         * this resident, and hidden when something does. Both are 204 - the caller asked
         * for the person to come off the register and that is what happened, and a
         * resident who was deleted has no representation to return.
         */
        const r = await app.residents.remove(ctx.params.id!);
        return r.ok ? noContent(ctx.traceId) : errorResponse(r.error, ctx.traceId);
      },
    },

    // ---------------------------------------------------------------- vehicles
    //
    // The register of cars a resident may bring in. This is what the plate-recognition
    // module matches a recognised plate against, which is why the canonical plate and
    // the typed plate are both carried, and why the normalisation rule lives in the
    // domain rather than in any one caller.
    {
      method: 'GET',
      path: '/residents/{id}/vehicles',
      roles: ['ADMIN', 'RESIDENT'],
      handler: async (ctx) => {
        const scope = await residentScope(ctx);
        if (!scope.ok) return scope.response;
        return respond(await app.vehicles.list(scope.residentId), ctx, (items) =>
          okJson({ items: items.map(presentVehicle) }, ctx.traceId),
        );
      },
    },
    {
      method: 'POST',
      path: '/residents/{id}/vehicles',
      roles: ['ADMIN', 'RESIDENT'],
      handler: async (ctx) => {
        const scope = await residentScope(ctx);
        if (!scope.ok) return scope.response;
        const b = parse(vehicleCreateSchema, ctx.body);
        if (!b.ok) return badRequest(b.details, ctx);
        return respond(await app.vehicles.add(scope.residentId, b.data), ctx, (v) =>
          created(presentVehicle(v), ctx.traceId),
        );
      },
    },
    {
      method: 'PATCH',
      path: '/residents/{id}/vehicles/{vehicleId}',
      roles: ['ADMIN', 'RESIDENT'],
      handler: async (ctx) => {
        const scope = await residentScope(ctx);
        if (!scope.ok) return scope.response;
        const b = parse(vehiclePatchSchema, ctx.body);
        if (!b.ok) return badRequest(b.details, ctx);
        return respond(
          await app.vehicles.update(scope.residentId, ctx.params.vehicleId!, b.data),
          ctx,
          (v) => okJson(presentVehicle(v), ctx.traceId),
        );
      },
    },
    {
      method: 'DELETE',
      path: '/residents/{id}/vehicles/{vehicleId}',
      roles: ['ADMIN', 'RESIDENT'],
      // "Remove", not "delete": the row is deactivated so a past recognition event
      // still resolves to a car, while the plate itself is freed for whoever owns it next.
      handler: async (ctx) => {
        const scope = await residentScope(ctx);
        if (!scope.ok) return scope.response;
        const r = await app.vehicles.remove(scope.residentId, ctx.params.vehicleId!);
        return r.ok ? noContent(ctx.traceId) : errorResponse(r.error, ctx.traceId);
      },
    },
    {
      /*
       * The gate lookup, consumed by the plate-recognition module.
       *
       * Administrator only, and that is a deliberate limit rather than an oversight: the
       * answer is "this plate belongs to this resident", so an open version of it turns
       * the car park into a directory of who drives what. The recognition service calls
       * it with an administrator credential of its own.
       *
       * The path segment is raw text, not a UUID - the router's identifier check keys on
       * parameter names ending in "id", and this one is `plate`, so "ABC-123" reaches the
       * handler intact and is normalised by the use case.
       */
      method: 'GET',
      path: '/vehicles/by-plate/{plate}',
      roles: ['ADMIN'],
      handler: async (ctx) =>
        respond(await app.vehicles.findByPlate(ctx.params.plate ?? ''), ctx, (v) =>
          okJson(presentVehicle(v), ctx.traceId),
        ),
    },

    // ------------------------------------------------------------ plates (M-7)
    //
    // Nothing in this group recognises anything synchronously. A POST that ran OCR would
    // be a 600 ms endpoint inside the VPC waiting on a service the VPC cannot reach, and
    // it would fail with the camera's uplink. The path is always S3 first, then the object
    // notification: `POST /captures` hands out a presigned PUT and returns.
    {
      method: 'POST',
      path: '/captures',
      // CAMERA is a machine role: one Cognito user per gate, whose only permission is
      // this route, so rotating a gate's credential touches no resident. ADMIN is here
      // too for the smoke tests and for an operator capturing a frame by hand.
      roles: ['CAMERA', 'ADMIN'],
      handler: async (ctx) => {
        const b = parse(captureRequestSchema, ctx.body);
        if (!b.ok) return badRequest(b.details, ctx);
        return respond(
          await app.captures.execute({
            cameraId: b.data.cameraId,
            capturedAt: b.data.capturedAt,
            contentType: b.data.contentType,
          }),
          ctx,
          (v) => created(v, ctx.traceId),
        );
      },
    },
    {
      // Before /plate-reads/{id}: the router matches in order, and a literal path
      // registered after a parameterised one of the same depth is never reached - worse,
      // the identifier check would reject "review" as a malformed UUID first.
      method: 'GET',
      path: '/plate-reads/review',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const limit = parse(limitSchema, ctx.query.limit ?? undefined);
        if (!limit.ok) return badRequest(limit.details, ctx);
        // Oldest first, unlike the log: a doubtful read loses its value once the car has
        // gone, so the queue is worked in arrival order.
        return respond(await app.plateReads.reviewQueue(limit.data), ctx, (page) =>
          okJson(
            { items: page.items.map(presentPlateRead), nextCursor: page.nextCursor },
            ctx.traceId,
          ),
        );
      },
    },
    {
      method: 'GET',
      path: '/plate-reads',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const limit = parse(limitSchema, ctx.query.limit ?? undefined);
        if (!limit.ok) return badRequest(limit.details, ctx);

        const status = ctx.query.status
          ? parse(plateReadStatus, ctx.query.status)
          : undefined;
        if (status && !status.ok) return badRequest(status.details, ctx);

        const from = ctx.query.from ? parse(z.coerce.date(), ctx.query.from) : undefined;
        if (from && !from.ok) return badRequest(from.details, ctx);
        const to = ctx.query.to ? parse(z.coerce.date(), ctx.query.to) : undefined;
        if (to && !to.ok) return badRequest(to.details, ctx);

        return respond(
          await app.plateReads.list({
            limit: limit.data,
            ...(ctx.query.cursor ? { cursor: ctx.query.cursor } : {}),
            ...(status?.ok ? { status: status.data } : {}),
            ...(ctx.query.cameraId ? { cameraId: ctx.query.cameraId } : {}),
            // Normalised the same way the register stores it, so "abc-123" finds the
            // read recorded as AB0123 rather than silently matching nothing.
            ...(ctx.query.plate ? { plate: normalizePlate(ctx.query.plate) } : {}),
            ...(from?.ok ? { from: from.data } : {}),
            ...(to?.ok ? { to: to.data } : {}),
            ...(ctx.query.needsReview === 'true' ? { needsReview: true } : {}),
          }),
          ctx,
          (page) =>
            okJson(
              { items: page.items.map(presentPlateRead), nextCursor: page.nextCursor },
              ctx.traceId,
            ),
        );
      },
    },
    {
      method: 'GET',
      path: '/plate-reads/{id}',
      roles: ['ADMIN'],
      // The only route that mints image URLs, and they last five minutes. The API never
      // serves an image itself.
      handler: async (ctx) =>
        respond(await app.plateReads.detail(ctx.params.id!), ctx, (d) =>
          okJson(
            {
              ...presentPlateRead(d),
              imageUrl: d.imageUrl,
              cropUrl: d.cropUrl,
              nearby: d.nearby.map((n) => ({
                vehicleId: n.vehicleId,
                plate: n.plate,
                residentId: n.residentId,
                distance: n.distance,
              })),
            },
            ctx.traceId,
          ),
        ),
    },
    {
      method: 'POST',
      path: '/plate-reads/{id}/resolve',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        // Required for the same reason the draw requires it: a retried click must replay
        // rather than write a second decision.
        if (!ctx.idempotencyKey) {
          return badRequest(
            [{ field: 'Idempotency-Key', issue: 'header is required on this route' }],
            ctx,
          );
        }
        const b = parse(plateReviewSchema, ctx.body);
        if (!b.ok) return badRequest(b.details, ctx);

        return respond(
          await app.resolvePlateRead.execute({
            plateReadId: ctx.params.id!,
            // The reviewer is the administrator's register row when they have one. An
            // administrator without one still reviews; the row then records the decision
            // without a reviewer id, which the CHECK on the table allows as a pair.
            reviewedBy: ctx.principal.residentId,
            verdict: {
              ...(b.data.plate === undefined ? {} : { plate: b.data.plate }),
              ...(b.data.vehicleId === undefined ? {} : { vehicleId: b.data.vehicleId }),
              decision: b.data.decision,
              ...(b.data.note === undefined ? {} : { note: b.data.note }),
              ...(b.data.discard === undefined ? {} : { discard: b.data.discard }),
            },
            idempotencyKey: ctx.idempotencyKey.slice(0, 200),
          }),
          ctx,
          (d) => okJson(presentPlateRead(d), ctx.traceId),
        );
      },
    },
    {
      method: 'GET',
      path: '/access-events',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const limit = parse(limitSchema, ctx.query.limit ?? undefined);
        if (!limit.ok) return badRequest(limit.details, ctx);

        const decision = ctx.query.decision
          ? parse(accessDecisionFilter, ctx.query.decision)
          : undefined;
        if (decision && !decision.ok) return badRequest(decision.details, ctx);

        const residentId = ctx.query.residentId
          ? parse(uuid, ctx.query.residentId)
          : undefined;
        if (residentId && !residentId.ok) return badRequest(residentId.details, ctx);

        const from = ctx.query.from ? parse(z.coerce.date(), ctx.query.from) : undefined;
        if (from && !from.ok) return badRequest(from.details, ctx);
        const to = ctx.query.to ? parse(z.coerce.date(), ctx.query.to) : undefined;
        if (to && !to.ok) return badRequest(to.details, ctx);

        const r = await app.plateReads.accessEvents({
          limit: limit.data,
          ...(ctx.query.cursor ? { cursor: ctx.query.cursor } : {}),
          ...(decision?.ok ? { decision: decision.data } : {}),
          ...(residentId?.ok ? { residentId: residentId.data } : {}),
          ...(from?.ok ? { from: from.data } : {}),
          ...(to?.ok ? { to: to.data } : {}),
        });
        if (!r.ok) return errorResponse(r.error, ctx.traceId);

        const rows = r.value.items.map(presentAccessEvent);
        if (ctx.query.format === 'csv') {
          return csv(rows as never, 'pacs-access-events.csv', ctx.traceId);
        }
        return okJson({ items: rows, nextCursor: r.value.nextCursor }, ctx.traceId);
      },
    },
    {
      method: 'GET',
      path: '/me/access-events',
      roles: ['RESIDENT', 'ADMIN'],
      handler: async (ctx) => {
        // Same separation of duties as the rest of the resident surface: an administrator
        // holds no bay, so "my entries" is not theirs to read - they have /access-events.
        const refused = adminHasNoResidentSurface(ctx);
        if (refused) return refused;
        const id = await resolveResidentId(ctx);
        if (!id) return errorResponse(failure('NOT_FOUND', 'No resident record for this token.'), ctx.traceId);
        const limit = parse(limitSchema, ctx.query.limit ?? undefined);
        if (!limit.ok) return badRequest(limit.details, ctx);
        return respond(await app.plateReads.ownAccessEvents(id, limit.data), ctx, (items) =>
          okJson({ items: items.map(presentAccessEvent), nextCursor: null }, ctx.traceId),
        );
      },
    },
    {
      method: 'GET',
      path: '/metrics/plates',
      roles: ['ADMIN'],
      // The numbers the threshold calibration is argued from, including how many
      // corrections exist - which is the size of the evaluation set.
      handler: async (ctx) => respond(await app.plateReads.metrics(), ctx),
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
    /*
     * Removing a bay, as against retiring one.
     *
     * Allowed only for a bay that has never been assigned and that the allocation
     * history does not name - the same line DELETE /cycles/{id} draws for a period. For
     * anything else the refusal says to retire it, which is what PATCH above does and
     * what an administrator wants in almost every real case.
     *
     * It exists because a bay that was created by mistake, or by a test, otherwise sits
     * on the inventory screen for ever: retiring hides a bay from the active filter but
     * the register lists inactive bays by default.
     */
    {
      method: 'DELETE',
      path: '/spots/{id}',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const r = await app.spots.remove(ctx.params.id!);
        return r.ok ? noContent(ctx.traceId) : errorResponse(r.error, ctx.traceId);
      },
    },

    // -------------------------------------------------------------------- lot
    /*
     * The levels the plan draws, from the inventory. The web app used to generate its own
     * level and bay codes (B1-A01...), which matched nothing in a building whose bays are
     * B1-01, B2-01 - so an assigned bay was never shown on the plan.
     */
    {
      method: 'GET',
      path: '/lots',
      roles: ['RESIDENT', 'ADMIN'],
      handler: async (ctx) =>
        respond(await app.spots.levels(), ctx, (items) =>
          okJson({ items: items.map((l) => ({ levelId: l.level, bays: l.bays })) }, ctx.traceId),
        ),
    },
    /*
     * The lot plan's live state: every bay on a level, as the inventory and the live
     * assignments say it is. Both roles read it; only an administrator is told who holds
     * a bay, and a resident is told one identity, their own, as `isMine`. Before this the
     * web app drew the plan from a generated stand-in that marked the same bay as every
     * resident's own, whether or not they held anything.
     */
    {
      method: 'GET',
      // `{level}`, not `{levelId}`: the router treats every param ending in "id" as a
      // UUID and refuses anything else, which turned `B1` into a 400.
      path: '/lots/{level}/occupancy',
      roles: ['RESIDENT', 'ADMIN'],
      handler: async (ctx) => {
        const level = ctx.params.level ?? '';
        if (!/^[A-Za-z0-9-]{1,20}$/.test(level)) {
          return badRequest([{ field: 'level', issue: 'must be a level code such as B1' }], ctx);
        }
        const admin = isAdmin(ctx.principal);
        const residentId = admin ? null : await resolveResidentId(ctx);
        return respond(
          await app.spots.occupancy(level, { residentId, isAdmin: admin }),
          ctx,
          (items) =>
            okJson(
              {
                items: items.map((b) => ({
                  ...b,
                  validUntil: b.validUntil ? b.validUntil.toISOString() : null,
                })),
              },
              ctx.traceId,
            ),
        );
      },
    },

    // ----------------------------------------------------- configuration (A)
    {
      method: 'GET',
      path: '/config/allocation',
      roles: ['ADMIN'],
      handler: async (ctx) => respond(await app.config.current(), ctx),
    },
    {
      method: 'GET',
      path: '/config/allocation/history',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const limit = parse(limitSchema, ctx.query.limit ?? undefined);
        if (!limit.ok) return badRequest(limit.details, ctx);
        return respond(await app.config.history(limit.data), ctx, (items) =>
          okJson({ items }, ctx.traceId),
        );
      },
    },
    {
      method: 'PATCH',
      path: '/config/allocation',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const b = parse(configPatchSchema, ctx.body);
        if (!b.ok) return badRequest(b.details, ctx);
        // changedBy is the administrator's resident row when they have one; an admin
        // without one is still recorded, by the audit trail on the new version's row.
        const changedBy = ctx.principal.residentId;
        return respond(await app.config.update(b.data, changedBy), ctx);
      },
    },

    // ------------------------------------------------------------------ cycles
    {
      method: 'GET',
      path: '/cycles',
      roles: ['ADMIN', 'RESIDENT'],
      handler: async (ctx) =>
        respond(await app.cycles.list(), ctx, (items) =>
          okJson({ items: items.map(presentCycle) }, ctx.traceId),
        ),
    },
    {
      method: 'POST',
      path: '/cycles',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const b = parse(cycleCreateSchema, ctx.body);
        if (!b.ok) return badRequest(b.details, ctx);
        return respond(await app.cycles.create(b.data), ctx, (v) => created(presentCycle(v), ctx.traceId));
      },
    },
    {
      method: 'PATCH',
      path: '/cycles/{id}',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const b = parse(cycleRenameSchema, ctx.body);
        if (!b.ok) return badRequest(b.details, ctx);
        return respond(await app.cycles.rename(ctx.params.id!, b.data.label), ctx);
      },
    },
    {
      method: 'DELETE',
      path: '/cycles/{id}',
      roles: ['ADMIN'],
      handler: async (ctx) => respond(await app.cycles.remove(ctx.params.id!), ctx),
    },
    {
      method: 'POST',
      path: '/cycles/{id}/open-registration',
      roles: ['ADMIN'],
      handler: async (ctx) =>
        respond(await app.cycles.guardedTransition(ctx.params.id!, 'REGISTRATION_OPEN'), ctx, (v) =>
          okJson(presentCycle(v), ctx.traceId),
        ),
    },
    {
      method: 'POST',
      path: '/cycles/{id}/close-registration',
      roles: ['ADMIN'],
      handler: async (ctx) =>
        respond(await app.cycles.guardedTransition(ctx.params.id!, 'REGISTRATION_CLOSED'), ctx, (v) =>
          okJson(presentCycle(v), ctx.traceId),
        ),
    },
    /*
     * Ending the period that is in effect, which expires the assignments it handed out.
     *
     * Separate from close-registration, and the names are worth keeping apart: that one
     * shuts the door on entrants before a draw, this one ends the arrangement the draw
     * produced. It is also what unblocks the next draw, since one is refused while an
     * allocation is in force.
     */
    {
      method: 'POST',
      path: '/cycles/{id}/close',
      roles: ['ADMIN'],
      handler: async (ctx) =>
        respond(await app.cycles.close(ctx.params.id!), ctx, (v) =>
          okJson(presentCycle(v), ctx.traceId),
        ),
    },

    // -------------------------------------------------------------------- runs
    {
      method: 'POST',
      path: '/cycles/{id}/runs',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        // section 16: the header is required, so a retried click cannot draw twice.
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
      // Before /runs/{id}: the router matches in order, and a literal path registered
      // after a parameterised one of the same depth would never be reached.
      method: 'GET',
      path: '/runs',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const limit = parse(limitSchema, ctx.query.limit ?? undefined);
        if (!limit.ok) return badRequest(limit.details, ctx);

        const runs = await app.allocationRepo.listRuns(limit.data);
        const cycles = await app.cycles.list();
        // The report is read by a person, so a run names its period rather than its
        // period's id. Resolved here from one list rather than per row.
        const labelOf = new Map(
          (cycles.ok ? cycles.value : []).map((c) => [c.id, c.label] as const),
        );

        return okJson(
          {
            items: runs.map((run) => ({
              runId: run.id,
              cycleId: run.cycleId,
              cycleLabel: labelOf.get(run.cycleId) ?? null,
              state: run.state,
              algorithmVersion: run.algorithmVersion,
              configVersion: run.configVersion,
              randomSeedHex: run.randomSeedHex,
              decidedAt: run.decidedAt.toISOString(),
              entrants: run.entrantsCount,
              spots: run.spotsCount,
              assigned: run.assignedCount,
              finishedAt: run.finishedAt?.toISOString() ?? null,
              errorDetail: run.errorDetail,
            })),
          },
          ctx.traceId,
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
            // The seed and its commitment are deliberately exposed: together they are
            // what makes the run auditable. sha256(randomSeedHex) must equal
            // seedCommitmentHex, which was written before the candidate list was read.
            randomSeedHex: run.randomSeedHex,
            seedCommitmentHex: run.seedCommitmentHex,
            decidedAt: run.decidedAt.toISOString(),
            configVersion: run.configVersion,
            inputHashHex: run.inputHashHex,
            resultHashHex: run.resultHashHex,
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
      path: '/runs/{id}/explanation',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const run = await app.allocationRepo.findRun(ctx.params.id!);
        if (!run) return errorResponse(failure('NOT_FOUND', 'Run not found.'), ctx.traceId);
        return respond(
          await app.dashboard.runExplanation(run.id, run.configVersion, run.assignedCount),
          ctx,
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
      // "quarterly" is kept as the path only so existing clients do not break; the report
      // itself is per allocation period, whatever the configured duration is.
      method: 'GET',
      path: '/reports/quarterly/{cycleId}',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const r = await app.dashboard.periodReport(ctx.params.cycleId!);
        if (!r.ok) return errorResponse(r.error, ctx.traceId);
        if (ctx.query.format === 'csv') {
          return csv(r.value as never, `pacs-${ctx.params.cycleId}.csv`, ctx.traceId);
        }
        return okJson({ items: r.value }, ctx.traceId);
      },
    },
    {
      method: 'GET',
      path: '/reports/period/{cycleId}',
      roles: ['ADMIN'],
      handler: async (ctx) => {
        const r = await app.dashboard.periodReport(ctx.params.cycleId!);
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
  // The gate lookup answers "whose car is this", so it stays administrator-only. The
  // per-resident vehicle routes are deliberately not in this list: a resident manages
  // their own, scoped by the token rather than by the role.
  '/vehicles/by-plate/{plate}',
  '/spots',
  '/config/allocation',
  '/metrics/fairness',
  '/reports/quarterly/{cycleId}',
  '/reports/period/{cycleId}',
  // The gate log and the access log name which resident drives which car and when they
  // came in, so both are administrator-only. `POST /captures` is deliberately NOT in
  // this list: it is the CAMERA role's one route, and `/me/access-events` is not either,
  // because it is scoped by the token rather than by the role.
  '/plate-reads',
  '/plate-reads/review',
  '/plate-reads/{id}',
  '/plate-reads/{id}/resolve',
  '/access-events',
  '/metrics/plates',
] as const;

export { isAdmin };
