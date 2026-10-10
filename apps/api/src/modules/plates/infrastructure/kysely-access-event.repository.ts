import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../shared/db/schema';
import type { AccessEvent } from '../domain/plate-read';
import type {
  AccessEventInsert,
  AccessEventListQuery,
  AccessEventPage,
  AccessEventRepository,
  AccessEventRow,
} from '../application/ports';
import { toAccessEvent } from './kysely-plate-read.repository';

/**
 * `access_event` - the access log.
 *
 * Insert and read only. There is no update method and that is the design: a decision is
 * overturned by inserting a new row and linking the old one, which the review transaction
 * in `kysely-plate-read.repository.ts` does because it has to happen atomically with the
 * read's update. The grant behind this role allows UPDATE on exactly one column
 * (`superseded_by`), so even a mistake in this file cannot rewrite a decision.
 */

interface Row {
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
  resident_name: string | null;
  unit_number: string | null;
  spot_code: string | null;
  capture_id: string;
}

const toRow = (r: Row): AccessEventRow => ({
  ...toAccessEvent(r),
  residentName: r.resident_name,
  unitNumber: r.unit_number,
  spotCode: r.spot_code,
  captureId: r.capture_id,
});

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

export class KyselyAccessEventRepository implements AccessEventRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async insert(plateReadId: string, input: AccessEventInsert): Promise<AccessEvent> {
    const r = await this.db
      .insertInto('access_event')
      .values({
        plate_read_id: plateReadId,
        plate: input.plate,
        vehicle_id: input.vehicleId,
        resident_id: input.residentId,
        spot_id: input.spotId,
        decision: input.decision,
        reason: input.reason,
        camera_id: input.cameraId,
        occurred_at: input.occurredAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toAccessEvent(r as unknown as Row);
  }

  async list(query: AccessEventListQuery): Promise<AccessEventPage> {
    let q = this.baseQuery();

    if (query.decision !== undefined) q = q.where('ae.decision', '=', query.decision);
    if (query.residentId !== undefined) q = q.where('ae.resident_id', '=', query.residentId);
    if (query.from !== undefined) q = q.where('ae.occurred_at', '>=', query.from);
    if (query.to !== undefined) q = q.where('ae.occurred_at', '<=', query.to);

    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (cursor) {
      q = q.where(sql<boolean>`(ae.occurred_at, ae.id) < (${cursor.at}, ${cursor.id})`);
    }

    const rows = (await q
      .orderBy('ae.occurred_at', 'desc')
      .orderBy('ae.id', 'desc')
      .limit(query.limit + 1)
      .execute()) as unknown as Row[];

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map(toRow),
      nextCursor: hasMore && last ? encodeCursor(new Date(last.occurred_at), last.id) : null,
    };
  }

  /**
   * A resident's own entries. The id comes from the token, resolved by the route, and the
   * superseded rows are excluded - a resident should see what the building concluded, not
   * the administrator's working.
   */
  async listForResident(residentId: string, limit: number): Promise<readonly AccessEventRow[]> {
    const rows = (await this.baseQuery()
      .where('ae.resident_id', '=', residentId)
      .where('ae.superseded_by', 'is', null)
      .orderBy('ae.occurred_at', 'desc')
      .orderBy('ae.id', 'desc')
      .limit(limit)
      .execute()) as unknown as Row[];
    return rows.map(toRow);
  }

  private baseQuery() {
    return this.db
      .selectFrom('access_event as ae')
      .innerJoin('plate_read as pr', 'pr.id', 'ae.plate_read_id')
      .leftJoin('resident as r', 'r.id', 'ae.resident_id')
      .leftJoin('parking_spot as ps', 'ps.id', 'ae.spot_id')
      .select([
        'ae.id',
        'ae.plate_read_id',
        'ae.plate',
        'ae.vehicle_id',
        'ae.resident_id',
        'ae.spot_id',
        'ae.decision',
        'ae.reason',
        'ae.camera_id',
        'ae.occurred_at',
        'ae.created_at',
        'ae.superseded_by',
        'r.full_name as resident_name',
        'r.unit_number as unit_number',
        'ps.spot_code as spot_code',
        'pr.capture_id as capture_id',
      ]);
  }
}
