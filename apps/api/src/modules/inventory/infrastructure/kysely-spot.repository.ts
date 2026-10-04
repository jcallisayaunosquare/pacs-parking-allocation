import type { Kysely } from 'kysely';
import type { Database } from '../../../shared/db/schema';
import type { SpotType } from '../../allocation/domain/types';
import type { ParkingSpot, SpotRepository } from '../application/spot.use-cases';

type Row = {
  id: string;
  spot_code: string;
  level: string;
  type: SpotType;
  is_active: boolean;
  notes: string | null;
  created_at: Date;
};

const toSpot = (r: Row): ParkingSpot => ({
  id: r.id,
  spotCode: r.spot_code,
  level: r.level,
  type: r.type,
  isActive: r.is_active,
  notes: r.notes,
  createdAt: new Date(r.created_at),
});

export class KyselySpotRepository implements SpotRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async findById(id: string): Promise<ParkingSpot | null> {
    const r = await this.db.selectFrom('parking_spot').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toSpot(r as Row) : null;
  }

  async findByCode(code: string): Promise<ParkingSpot | null> {
    const r = await this.db
      .selectFrom('parking_spot')
      .selectAll()
      .where('spot_code', '=', code)
      .executeTakeFirst();
    return r ? toSpot(r as Row) : null;
  }

  async list(input: { activeOnly?: boolean; type?: SpotType }): Promise<readonly ParkingSpot[]> {
    let q = this.db.selectFrom('parking_spot').selectAll();
    if (input.activeOnly) q = q.where('is_active', '=', true);
    if (input.type) q = q.where('type', '=', input.type);
    const rows = (await q.orderBy('spot_code').execute()) as Row[];
    return rows.map(toSpot);
  }

  async create(input: {
    spotCode: string;
    level: string;
    type: SpotType;
    notes: string | null;
  }): Promise<ParkingSpot> {
    const r = await this.db
      .insertInto('parking_spot')
      .values({
        spot_code: input.spotCode,
        level: input.level,
        type: input.type,
        notes: input.notes,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSpot(r as Row);
  }

  async update(
    id: string,
    patch: { level?: string; type?: SpotType; notes?: string | null; isActive?: boolean },
    deactivatedAt: Date | null,
  ): Promise<ParkingSpot | null> {
    const values: Record<string, unknown> = {};
    if (patch.level !== undefined) values.level = patch.level;
    if (patch.type !== undefined) values.type = patch.type;
    if (patch.notes !== undefined) values.notes = patch.notes;
    if (patch.isActive !== undefined) {
      values.is_active = patch.isActive;
      values.deactivated_at = patch.isActive ? null : deactivatedAt;
    }
    if (Object.keys(values).length === 0) return this.findById(id);

    const r = await this.db
      .updateTable('parking_spot')
      .set(values as never)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    return r ? toSpot(r as Row) : null;
  }

  async isCurrentlyAssigned(id: string): Promise<boolean> {
    const r = await this.db
      .selectFrom('spot_assignment')
      .select('id')
      .where('spot_id', '=', id)
      .where('state', '=', 'ACTIVE')
      .executeTakeFirst();
    return r !== undefined;
  }
}
