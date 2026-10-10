import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../shared/db/schema';
import { fuseConfidence, type ScoredCandidate } from '../domain/plate-candidate';
import type { AccessEvent, PlateRead, PlateReadWithDecision } from '../domain/plate-read';
import type {
  AccessEventInsert,
  PlateMetrics,
  PlateReadInsert,
  PlateReadListQuery,
  PlateReadPage,
  PlateReadRepository,
} from '../application/ports';

/**
 * `plate_read`, and the one transaction that spans both tables.
 *
 * The infrastructure ring: Kysely, numeric coercion and the SQL that the two indexes of
 * the migration exist for. Nothing here decides anything - the status, the decision and
 * the reason all arrive already settled from `decide()` or `resolveReview()`.
 */

interface ReadRow {
  id: string;
  capture_id: string;
  camera_id: string;
  captured_at: Date;
  received_at: Date;
  raw_text: string | null;
  plate: string | null;
  confidence: string | number;
  quality: string | number | null;
  status: PlateRead['status'];
  vehicle_id: string | null;
  match_kind: PlateRead['matchKind'];
  match_distance: number | null;
  candidates: unknown;
  image_key: string;
  crop_key: string | null;
  engine: string;
  engine_version: string | null;
  latency_ms: number | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  corrected_plate: string | null;
}

interface EventRow {
  id: string;
  plate_read_id: string;
  plate: string;
  vehicle_id: string | null;
  resident_id: string | null;
  spot_id: string | null;
  decision: AccessEvent['decision'];
  reason: string;
  camera_id: string;
  occurred_at: Date;
  created_at: Date;
  superseded_by: string | null;
}

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * jsonb comes back from pg already parsed, but a column written by an older build - or
 * by hand during an incident - can be a JSON string. Normalised here rather than trusted,
 * because the review screen iterates it and a string iterates one character at a time.
 */
const toCandidates = (v: unknown): readonly ScoredCandidate[] => {
  const raw = typeof v === 'string' ? safeParse(v) : v;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c): ScoredCandidate[] => {
    if (typeof c !== 'object' || c === null) return [];
    const o = c as Record<string, unknown>;
    if (typeof o.plate !== 'string') return [];
    return [
      {
        plate: o.plate,
        raw: typeof o.raw === 'string' ? o.raw : o.plate,
        confidence: num(o.confidence as number) ?? 0,
        score: num(o.score as number) ?? 0,
        box: o.box as ScoredCandidate['box'],
      },
    ];
  });
};

const safeParse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
};

export const toPlateRead = (r: ReadRow): PlateRead => {
  const confidence = num(r.confidence) ?? 0;
  const quality = num(r.quality);
  return {
    id: r.id,
    captureId: r.capture_id,
    cameraId: r.camera_id,
    capturedAt: new Date(r.captured_at),
    receivedAt: new Date(r.received_at),
    rawText: r.raw_text,
    plate: r.plate,
    confidence,
    quality,
    // Derived, never stored: a third copy of a number computed from two others is a
    // number that disagrees with its own inputs the first time either one is corrected.
    fused: fuseConfidence(confidence, quality),
    status: r.status,
    vehicleId: r.vehicle_id,
    matchKind: r.match_kind,
    matchDistance: r.match_distance === null ? null : Number(r.match_distance),
    candidates: toCandidates(r.candidates),
    imageKey: r.image_key,
    cropKey: r.crop_key,
    engine: r.engine,
    engineVersion: r.engine_version,
    latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at === null ? null : new Date(r.reviewed_at),
    reviewNote: r.review_note,
    correctedPlate: r.corrected_plate,
  };
};

export const toAccessEvent = (r: EventRow): AccessEvent => ({
  id: r.id,
  plateReadId: r.plate_read_id,
  plate: r.plate,
  vehicleId: r.vehicle_id,
  residentId: r.resident_id,
  spotId: r.spot_id,
  decision: r.decision,
  reason: r.reason,
  cameraId: r.camera_id,
  occurredAt: new Date(r.occurred_at),
  createdAt: new Date(r.created_at),
  supersededBy: r.superseded_by,
});

const values = (input: PlateReadInsert) => ({
  capture_id: input.captureId,
  camera_id: input.cameraId,
  captured_at: input.capturedAt,
  raw_text: input.rawText,
  plate: input.plate,
  confidence: input.confidence,
  quality: input.quality,
  status: input.status,
  vehicle_id: input.vehicleId,
  match_kind: input.matchKind,
  match_distance: input.matchDistance,
  candidates: JSON.stringify(input.candidates),
  image_key: input.imageKey,
  crop_key: input.cropKey,
  engine: input.engine,
  engine_version: input.engineVersion,
  latency_ms: input.latencyMs,
});

/** The keyset cursor: the row's captured_at and id, so paging is total and stable. */
const encodeCursor = (at: Date, id: string): string =>
  Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');

const decodeCursor = (cursor: string): { at: Date; id: string } | null => {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!iso || !id) return null;
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? null : { at, id };
  } catch {
    return null;
  }
};

export class KyselyPlateReadRepository implements PlateReadRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * The idempotent insert, and the load-bearing one.
   *
   * `ON CONFLICT (capture_id) DO NOTHING RETURNING *` returns no row when the capture was
   * already applied, which is what turns at-least-once stream delivery into
   * exactly-once effect without the consumer having to ask first - and without a race,
   * because a SELECT-then-INSERT has a window and this does not.
   */
  async insertIfAbsent(input: PlateReadInsert): Promise<PlateRead | null> {
    const r = await this.db
      .insertInto('plate_read')
      .values(values(input))
      .onConflict((oc) => oc.column('capture_id').doNothing())
      .returningAll()
      .executeTakeFirst();
    return r ? toPlateRead(r as unknown as ReadRow) : null;
  }

  async findById(id: string): Promise<PlateRead | null> {
    const r = await this.db
      .selectFrom('plate_read')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return r ? toPlateRead(r as unknown as ReadRow) : null;
  }

  async findByCaptureId(captureId: string): Promise<PlateRead | null> {
    const r = await this.db
      .selectFrom('plate_read')
      .selectAll()
      .where('capture_id', '=', captureId)
      .executeTakeFirst();
    return r ? toPlateRead(r as unknown as ReadRow) : null;
  }

  async list(query: PlateReadListQuery): Promise<PlateReadPage> {
    const rows = await this.selectLog(query);

    // One more than asked for, so "is there another page" needs no count(*) over a
    // table that only grows.
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map(toLogRow),
      nextCursor: hasMore && last ? encodeCursor(new Date(last.captured_at), last.id) : null,
    };
  }

  async findDetail(id: string): Promise<PlateReadWithDecision | null> {
    const rows = await this.logQuery().where('pr.id', '=', id).execute();
    const row = rows[0];
    return row ? toLogRow(row as LogRow) : null;
  }

  /**
   * The review, in one transaction.
   *
   * The order is forced by the partial unique index `ux_access_event_live_per_read`: at
   * most one event per read may have `superseded_by IS NULL`, so the standing row has to
   * be pointed at the new one BEFORE the new one exists. Hence the explicit id - the
   * column's DEFAULT would only be known after the insert, which is one statement too
   * late.
   *
   * The guard is `reviewed_at IS NULL` on the UPDATE. Two administrators on the same row
   * means the second update matches nothing, this returns null, and the route answers
   * 409. The database decides, not the application - the same shape as the partial index
   * behind the draw lock.
   */
  async applyReview(input: {
    plateReadId: string;
    reviewedBy: string | null;
    reviewedAt: Date;
    status: PlateRead['status'];
    plate: string | null;
    correctedPlate: string | null;
    vehicleId: string | null;
    matchKind: PlateRead['matchKind'];
    note: string | null;
    event: AccessEventInsert | null;
  }): Promise<PlateReadWithDecision | null> {
    const applied = await this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('plate_read')
        .set({
          status: input.status,
          plate: input.plate,
          corrected_plate: input.correctedPlate,
          vehicle_id: input.vehicleId,
          match_kind: input.matchKind,
          reviewed_by: input.reviewedBy,
          reviewed_at: input.reviewedAt,
          review_note: input.note,
        })
        .where('id', '=', input.plateReadId)
        .where('reviewed_at', 'is', null)
        .returning('id')
        .executeTakeFirst();

      if (!updated) return false;

      if (input.event !== null) {
        const newId = randomUUID();

        await trx
          .updateTable('access_event')
          .set({ superseded_by: newId })
          .where('plate_read_id', '=', input.plateReadId)
          .where('superseded_by', 'is', null)
          .execute();

        await trx
          .insertInto('access_event')
          .values({
            id: newId,
            plate_read_id: input.plateReadId,
            plate: input.event.plate,
            vehicle_id: input.event.vehicleId,
            resident_id: input.event.residentId,
            spot_id: input.event.spotId,
            decision: input.event.decision,
            reason: input.event.reason,
            camera_id: input.event.cameraId,
            occurred_at: input.event.occurredAt,
          })
          .execute();
      }

      // The outbox, in the same transaction as the rows it announces: no notification can
      // outlive a rolled-back review, and no review goes unannounced. The sweeper relays
      // it, and `integrations` is what eventually tells the resident.
      await trx
        .insertInto('event_outbox')
        .values({
          event_type: 'AccessReviewResolved',
          aggregate_type: 'plate_read',
          aggregate_id: input.plateReadId,
          payload: JSON.stringify({
            plateReadId: input.plateReadId,
            plate: input.plate,
            correctedPlate: input.correctedPlate,
            vehicleId: input.vehicleId,
            decision: input.event?.decision ?? null,
            reason: input.event?.reason ?? null,
            reviewedBy: input.reviewedBy,
            reviewedAt: input.reviewedAt.toISOString(),
          }),
        })
        .execute();

      return true;
    });

    return applied ? this.findDetail(input.plateReadId) : null;
  }

  /**
   * The calibration numbers, in one round trip.
   *
   * Aggregated in SQL rather than by loading the window: a month of a busy gate is tens
   * of thousands of rows, and the screen wants eight numbers.
   */
  async metrics(since: Date): Promise<PlateMetrics> {
    const totals = await this.db
      .selectFrom('plate_read')
      .select([
        sql<string>`count(*)`.as('reads'),
        sql<string>`count(*) filter (where status = 'MATCHED')`.as('matched'),
        sql<string>`count(*) filter (where status = 'UNMATCHED')`.as('unmatched'),
        sql<string>`count(*) filter (where status = 'REVIEW' and reviewed_at is null)`.as(
          'pending',
        ),
        sql<string>`count(*) filter (where corrected_plate is not null)`.as('corrections'),
        // The same fusion the domain applies, in SQL, so the reported mean is the mean of
        // the quantity the thresholds actually compare against rather than of the raw
        // confidence - which would read higher than anything the gate ever decided on.
        sql<string | null>`avg(confidence * (0.6 + 0.4 * coalesce(quality, 1)))`.as('fused'),
        sql<Date | null>`min(captured_at) filter (where status = 'REVIEW' and reviewed_at is null)`.as(
          'oldest_pending',
        ),
      ])
      .where('captured_at', '>=', since)
      .executeTakeFirstOrThrow();

    const decisions = await this.db
      .selectFrom('access_event')
      .select([
        sql<string>`count(*) filter (where decision = 'ALLOW')`.as('allowed'),
        sql<string>`count(*) filter (where decision = 'DENY')`.as('denied'),
      ])
      .where('occurred_at', '>=', since)
      .where('superseded_by', 'is', null)
      .executeTakeFirstOrThrow();

    const cameras = await this.db
      .selectFrom('plate_read')
      .select([
        'camera_id',
        sql<string>`count(*)`.as('reads'),
        sql<string>`count(*) filter (where status = 'MATCHED')`.as('matched'),
      ])
      .where('captured_at', '>=', since)
      .groupBy('camera_id')
      .orderBy('camera_id', 'asc')
      .execute();

    const oldest = totals.oldest_pending;
    return {
      reads: Number(totals.reads),
      matched: Number(totals.matched),
      unmatched: Number(totals.unmatched),
      pendingReview: Number(totals.pending),
      oldestPendingHours:
        oldest === null
          ? null
          : Math.round(((Date.now() - new Date(oldest).getTime()) / 3_600_000) * 10) / 10,
      allowed: Number(decisions.allowed),
      denied: Number(decisions.denied),
      averageFused: num(totals.fused),
      byCamera: cameras.map((c) => ({
        cameraId: c.camera_id,
        reads: Number(c.reads),
        matched: Number(c.matched),
      })),
      corrections: Number(totals.corrections),
    };
  }

  /**
   * The gate log's one query: the read, its standing decision, and the two names the
   * screen prints.
   *
   * The joins are left joins throughout, deliberately. A read with no match has no
   * vehicle, no resident and no bay, and that row is the most interesting one on the
   * screen - an inner join anywhere here would hide exactly the rows an administrator
   * opened the page for.
   */
  private logQuery() {
    return this.db
      .selectFrom('plate_read as pr')
      .leftJoin('access_event as ae', (join) =>
        join.onRef('ae.plate_read_id', '=', 'pr.id').on('ae.superseded_by', 'is', null),
      )
      .leftJoin('vehicle as v', 'v.id', 'pr.vehicle_id')
      .leftJoin('resident as r', 'r.id', 'v.resident_id')
      .leftJoin('parking_spot as ps', 'ps.id', 'ae.spot_id')
      .select([
        'pr.id',
        'pr.capture_id',
        'pr.camera_id',
        'pr.captured_at',
        'pr.received_at',
        'pr.raw_text',
        'pr.plate',
        'pr.confidence',
        'pr.quality',
        'pr.status',
        'pr.vehicle_id',
        'pr.match_kind',
        'pr.match_distance',
        'pr.candidates',
        'pr.image_key',
        'pr.crop_key',
        'pr.engine',
        'pr.engine_version',
        'pr.latency_ms',
        'pr.reviewed_by',
        'pr.reviewed_at',
        'pr.review_note',
        'pr.corrected_plate',
        'ae.id as ae_id',
        'ae.plate as ae_plate',
        'ae.vehicle_id as ae_vehicle_id',
        'ae.resident_id as ae_resident_id',
        'ae.spot_id as ae_spot_id',
        'ae.decision as ae_decision',
        'ae.reason as ae_reason',
        'ae.camera_id as ae_camera_id',
        'ae.occurred_at as ae_occurred_at',
        'ae.created_at as ae_created_at',
        'ae.superseded_by as ae_superseded_by',
        'r.full_name as resident_name',
        'r.unit_number as unit_number',
        'ps.spot_code as spot_code',
        'v.plate as registered_plate',
        // The car itself, for the arrivals board: the person at the barrier is comparing
        // what the register says against what is in the lane.
        'v.make as vehicle_make',
        'v.model as vehicle_model',
        'v.year as vehicle_year',
        'v.colour as vehicle_colour',
      ]);
  }

  private async selectLog(query: PlateReadListQuery): Promise<LogRow[]> {
    let q = this.logQuery();

    if (query.needsReview === true) {
      q = q.where('pr.status', '=', 'REVIEW').where('pr.reviewed_at', 'is', null);
    } else if (query.status !== undefined) {
      q = q.where('pr.status', '=', query.status);
    }
    if (query.cameraId !== undefined) q = q.where('pr.camera_id', '=', query.cameraId);
    if (query.plate !== undefined) q = q.where('pr.plate', '=', query.plate);
    if (query.from !== undefined) q = q.where('pr.captured_at', '>=', query.from);
    if (query.to !== undefined) q = q.where('pr.captured_at', '<=', query.to);

    /*
     * The review queue runs oldest first and the log newest first, and both page with the
     * same keyset. A doubtful read loses its value once the car has gone, so the queue is
     * worked in arrival order; the log is a log and is read from the top.
     */
    const ascending = query.needsReview === true;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (cursor) {
      q = q.where(
        ascending
          ? sql<boolean>`(pr.captured_at, pr.id) > (${cursor.at}, ${cursor.id})`
          : sql<boolean>`(pr.captured_at, pr.id) < (${cursor.at}, ${cursor.id})`,
      );
    }

    const rows = await q
      .orderBy('pr.captured_at', ascending ? 'asc' : 'desc')
      .orderBy('pr.id', ascending ? 'asc' : 'desc')
      .limit(query.limit + 1)
      .execute();

    return rows as unknown as LogRow[];
  }
}

type LogRow = ReadRow & {
  ae_id: string | null;
  ae_plate: string | null;
  ae_vehicle_id: string | null;
  ae_resident_id: string | null;
  ae_spot_id: string | null;
  ae_decision: AccessEvent['decision'] | null;
  ae_reason: string | null;
  ae_camera_id: string | null;
  ae_occurred_at: Date | null;
  ae_created_at: Date | null;
  ae_superseded_by: string | null;
  resident_name: string | null;
  unit_number: string | null;
  spot_code: string | null;
  registered_plate: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_year: number | null;
  vehicle_colour: string | null;
};

const toLogRow = (r: LogRow): PlateReadWithDecision => ({
  read: toPlateRead(r),
  decision:
    r.ae_id === null
      ? null
      : toAccessEvent({
          id: r.ae_id,
          plate_read_id: r.id,
          plate: r.ae_plate ?? '',
          vehicle_id: r.ae_vehicle_id,
          resident_id: r.ae_resident_id,
          spot_id: r.ae_spot_id,
          decision: r.ae_decision ?? 'REVIEW',
          reason: r.ae_reason ?? '',
          camera_id: r.ae_camera_id ?? r.camera_id,
          occurred_at: r.ae_occurred_at ?? r.captured_at,
          created_at: r.ae_created_at ?? r.received_at,
          superseded_by: r.ae_superseded_by,
        }),
  residentName: r.resident_name,
  unitNumber: r.unit_number,
  spotCode: r.spot_code,
  registeredPlate: r.registered_plate,
  vehicleMake: r.vehicle_make,
  vehicleModel: r.vehicle_model,
  // smallint comes back as a number from pg, but a null year is common and must stay null
  // rather than becoming 0 - a 0 would print as a model year.
  vehicleYear: r.vehicle_year === null ? null : Number(r.vehicle_year),
  vehicleColour: r.vehicle_colour,
});
