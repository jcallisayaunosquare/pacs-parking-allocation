import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../shared/db/schema';
import type { RegisteredVehicle } from '../domain/access-decision';
import type { VehicleLookup } from '../application/ports';

/**
 * The gate lookup, over the register the residents module owns.
 *
 * It reads `vehicle`, `resident` and `spot_assignment` and writes nothing. The reason it
 * lives in the plates module rather than being a method on the vehicle repository is the
 * shape of the question: the register answers "is this plate registered", and the gate
 * needs "which registrations could this read plausibly be, and may their owner enter" -
 * a different query, with a different index behind it and a confidence score behind the
 * answer.
 */

interface Row {
  vehicle_id: string;
  resident_id: string;
  plate: string;
  is_active: boolean;
  is_eligible: boolean;
  spot_id: string | null;
}

const toVehicle = (r: Row): RegisteredVehicle => ({
  vehicleId: r.vehicle_id,
  residentId: r.resident_id,
  plate: r.plate,
  isActive: r.is_active,
  residentIsEligible: r.is_eligible,
  spotId: r.spot_id,
});

export class KyselyVehicleLookupRepository implements VehicleLookup {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * The two-step match of MODULO-PLACAS.md section 2.1, with the first step in SQL.
   *
   * Step one narrows the universe by length: a plate within one character of the read's
   * length. Step two - the edit distance - is computed in the domain, because edit
   * distance cannot be indexed and TypeScript is where it is testable without a database.
   *
   * Inactive rows are included on purpose, and only for the exact plate. The decision
   * table has a `VEHICLE_INACTIVE` row, and it can only fire if the lookup is allowed to
   * see the deactivated registration - filtering it out here would turn a car whose
   * registration was removed into "not registered at all", which is a different fact and
   * a different conversation with the resident.
   *
   * `spot_assignment.state` is the column, not `status`: MODULO-PLACAS.md section 2.1
   * writes `sa.status = 'ACTIVE'`, and the real schema calls it `state`.
   */
  async candidatesFor(plate: string): Promise<readonly RegisteredVehicle[]> {
    const rows = (await this.baseQuery()
      .where((eb) =>
        eb.or([
          eb('v.plate', '=', plate),
          eb.and([
            eb('v.is_active', '=', true),
            eb(sql<number>`length(v.plate)`, '>=', plate.length - 1),
            eb(sql<number>`length(v.plate)`, '<=', plate.length + 1),
          ]),
        ]),
      )
      .execute()) as unknown as Row[];
    return rows.map(toVehicle);
  }

  /**
   * Every active registration. Read by the review screen, for the "plates within two
   * edits" list and to resolve a plate the administrator typed to a vehicle.
   *
   * No pagination, and that is sized to the problem: this is one residential building, so
   * the active register is tens of rows. A building with thousands of cars would want the
   * `pg_trgm` route instead, which is written down in MODULO-PLACAS.md section 2.1 and
   * deliberately not built, because it needs an extension to solve a problem that does
   * not exist yet.
   */
  async allActive(): Promise<readonly RegisteredVehicle[]> {
    const rows = (await this.baseQuery()
      .where('v.is_active', '=', true)
      .orderBy('v.plate', 'asc')
      .execute()) as unknown as Row[];
    return rows.map(toVehicle);
  }

  private baseQuery() {
    return this.db
      .selectFrom('vehicle as v')
      .innerJoin('resident as r', 'r.id', 'v.resident_id')
      .leftJoin('spot_assignment as sa', (join) =>
        join.onRef('sa.resident_id', '=', 'r.id').on('sa.state', '=', 'ACTIVE'),
      )
      .select([
        'v.id as vehicle_id',
        'v.resident_id as resident_id',
        'v.plate as plate',
        'v.is_active as is_active',
        'r.is_eligible as is_eligible',
        'sa.spot_id as spot_id',
      ]);
  }
}
