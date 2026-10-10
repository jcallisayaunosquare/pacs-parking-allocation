import type { Kysely } from 'kysely';
import type { Database } from '../../../shared/db/schema';
import type { NormalizedVehicle, Vehicle } from '../domain/vehicle';
import type { VehicleRepository } from '../application/vehicle.use-cases';

type Row = {
  id: string;
  resident_id: string;
  plate: string;
  plate_display: string;
  make: string | null;
  model: string | null;
  year: number | null;
  colour: string | null;
  notes: string | null;
  photos: unknown;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

/**
 * jsonb comes back from pg already parsed, but a column written by an older build - or
 * by hand - can be a JSON string instead of an array. Normalised here rather than
 * trusted, because the domain's `photos` is a `string[]` and a page that iterates a
 * string renders one letter per photo.
 */
const toPhotos = (v: unknown): readonly string[] => {
  const raw = typeof v === 'string' ? safeParse(v) : v;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
};

const safeParse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
};

const toVehicle = (r: Row): Vehicle => ({
  id: r.id,
  residentId: r.resident_id,
  plate: r.plate,
  plateDisplay: r.plate_display,
  make: r.make,
  model: r.model,
  // smallint arrives as a number, but a numeric cast on an older column can arrive as
  // a string; coerced once here rather than wherever it is rendered.
  year: r.year === null ? null : Number(r.year),
  colour: r.colour,
  notes: r.notes,
  photos: toPhotos(r.photos),
  isActive: r.is_active,
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
});

/** The columns a write sets, in the shape the table wants them. */
const values = (input: NormalizedVehicle) => ({
  plate: input.plate,
  plate_display: input.plateDisplay,
  make: input.make,
  model: input.model,
  year: input.year,
  colour: input.colour,
  notes: input.notes,
  photos: JSON.stringify(input.photos),
});

export class KyselyVehicleRepository implements VehicleRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async listByResident(residentId: string, includeInactive: boolean): Promise<readonly Vehicle[]> {
    let q = this.db.selectFrom('vehicle').selectAll().where('resident_id', '=', residentId);
    if (!includeInactive) q = q.where('is_active', '=', true);
    // Oldest first: the register reads as the order the resident added them, which is
    // the order they expect to find them in. Plate is the tie-break so the list is total.
    const rows = (await q.orderBy('created_at', 'asc').orderBy('plate', 'asc').execute()) as Row[];
    return rows.map(toVehicle);
  }

  async findById(id: string): Promise<Vehicle | null> {
    const r = await this.db.selectFrom('vehicle').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toVehicle(r as Row) : null;
  }

  /**
   * The gate lookup. Active rows only, which is what makes the partial unique index the
   * right one: at most one active row can carry a plate, so this cannot be ambiguous.
   */
  async findActiveByPlate(plate: string): Promise<Vehicle | null> {
    const r = await this.db
      .selectFrom('vehicle')
      .selectAll()
      .where('plate', '=', plate)
      .where('is_active', '=', true)
      .executeTakeFirst();
    return r ? toVehicle(r as Row) : null;
  }

  async create(residentId: string, input: NormalizedVehicle, at: Date): Promise<Vehicle> {
    const r = await this.db
      .insertInto('vehicle')
      .values({ ...values(input), resident_id: residentId, created_at: at, updated_at: at })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toVehicle(r as Row);
  }

  async update(id: string, input: NormalizedVehicle, at: Date): Promise<Vehicle | null> {
    const r = await this.db
      .updateTable('vehicle')
      .set({ ...values(input), updated_at: at })
      .where('id', '=', id)
      .where('is_active', '=', true)
      .returningAll()
      .executeTakeFirst();
    return r ? toVehicle(r as Row) : null;
  }

  async deactivate(id: string, at: Date): Promise<boolean> {
    const r = await this.db
      .updateTable('vehicle')
      .set({ is_active: false, updated_at: at })
      .where('id', '=', id)
      .where('is_active', '=', true)
      .executeTakeFirst();
    return Number(r.numUpdatedRows ?? 0) > 0;
  }
}
