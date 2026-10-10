import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../shared/db/schema';
import type {
  Page,
  Resident,
  ResidentListQuery,
  ResidentRepository,
  ResidentSortField,
  SortDirection,
} from '../application/resident.use-cases';

type Row = {
  id: string;
  external_subject: string | null;
  email: string;
  full_name: string;
  unit_number: string;
  is_eligible: boolean;
  ineligible_reason: string | null;
  needs_accessible_spot: boolean;
  has_electric_vehicle: boolean;
  is_admin: boolean;
  participation_started_at: Date;
  created_at: Date;
  deactivated_at: Date | null;
};

/** The sort key an administrator picks, mapped to the column that implements it. */
const SORT_COLUMNS: Record<ResidentSortField, 'full_name' | 'unit_number' | 'email' | 'is_eligible' | 'created_at'> = {
  name: 'full_name',
  unit: 'unit_number',
  email: 'email',
  eligibility: 'is_eligible',
  created: 'created_at',
};

/** The value stored in the cursor for a row, in the column's own text form. */
const cursorValue = (field: ResidentSortField, row: Row): string => {
  switch (field) {
    case 'name':
      return row.full_name;
    case 'unit':
      return row.unit_number;
    case 'email':
      return row.email;
    case 'eligibility':
      return String(row.is_eligible);
    case 'created':
      return new Date(row.created_at).toISOString();
  }
};

/** Turns that text back into something Postgres will compare against the column. */
const parseCursorValue = (field: ResidentSortField, raw: string): string | boolean | Date => {
  switch (field) {
    case 'eligibility':
      return raw === 'true';
    case 'created':
      return new Date(raw);
    default:
      return raw;
  }
};

const toResident = (r: Row, currentSpotCode: string | null = null): Resident => ({
  id: r.id,
  email: r.email,
  fullName: r.full_name,
  unitNumber: r.unit_number,
  isEligible: r.is_eligible,
  ineligibleReason: r.ineligible_reason,
  needsAccessibleSpot: r.needs_accessible_spot,
  hasElectricVehicle: r.has_electric_vehicle,
  isAdmin: r.is_admin,
  participationStartedAt: new Date(r.participation_started_at),
  externalSubject: r.external_subject,
  currentSpotCode,
  createdAt: new Date(r.created_at),
  deactivatedAt: r.deactivated_at ? new Date(r.deactivated_at) : null,
});

export class KyselyResidentRepository implements ResidentRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async findById(id: string): Promise<Resident | null> {
    const r = await this.db.selectFrom('resident').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toResident(r as Row) : null;
  }

  async findBySubject(subject: string): Promise<Resident | null> {
    const r = await this.db
      .selectFrom('resident')
      .selectAll()
      .where('external_subject', '=', subject)
      .executeTakeFirst();
    return r ? toResident(r as Row) : null;
  }

  async findByEmail(email: string): Promise<Resident | null> {
    const r = await this.db
      .selectFrom('resident')
      .selectAll()
      .where('email', '=', email)
      .executeTakeFirst();
    return r ? toResident(r as Row) : null;
  }

  /**
   * Keyset pagination, sorted by whichever column the administrator chose.
   *
   * The cursor has to be keyed on the same column as the sort, not on created_at:
   * a cursor that remembers "the last row by creation date" is meaningless once the
   * list is ordered by name, and page two comes back wrong. So the cursor carries the
   * sort value and the id, and the query asks for the rows after that pair.
   *
   * The id is the tie-breaker, which is what makes the order total - without it, two
   * residents with the same surname can straddle a page boundary and one of them is
   * never shown. OFFSET would avoid the bookkeeping but skips rows when something is
   * inserted between requests.
   */
  /** The bay each of these residents holds right now, for the ones that hold one. */
  private async activeBays(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .selectFrom('spot_assignment as sa')
      .innerJoin('parking_spot as ps', 'ps.id', 'sa.spot_id')
      .select(['sa.resident_id as residentId', 'ps.spot_code as spotCode'])
      .where('sa.resident_id', 'in', [...ids])
      .where('sa.state', '=', 'ACTIVE')
      .execute();
    return new Map(rows.map((r) => [r.residentId, r.spotCode]));
  }

  async list(input: ResidentListQuery): Promise<Page<Resident>> {
    const field: ResidentSortField = input.sort ?? 'created';
    const dir: SortDirection = input.dir ?? (field === 'created' ? 'asc' : 'asc');
    const column = SORT_COLUMNS[field];
    const after = dir === 'asc';

    let q = this.db.selectFrom('resident').selectAll().where('deactivated_at', 'is', null);

    if (input.unit) q = q.where('unit_number', '=', input.unit);
    if (input.eligible !== undefined) q = q.where('is_eligible', '=', input.eligible);

    if (input.cursor) {
      const decoded = Buffer.from(input.cursor, 'base64url').toString('utf8');
      const sep = decoded.lastIndexOf('|');
      const rawValue = decoded.slice(0, sep);
      const id = decoded.slice(sep + 1);

      if (id) {
        // Row comparison: (col, id) > (value, id). Postgres compares the tuple
        // left to right, which is exactly the keyset rule, in one index-friendly
        // expression rather than an OR of inequalities.
        const value = parseCursorValue(field, rawValue);
        q = q.where(
          after
            ? sql<boolean>`(${sql.ref(column)}, "id") > (${value}, ${id})`
            : sql<boolean>`(${sql.ref(column)}, "id") < (${value}, ${id})`,
        );
      }
    }

    const rows = (await q
      .orderBy(column, dir)
      .orderBy('id', dir)
      .limit(input.limit + 1)
      .execute()) as Row[];

    const page = rows.slice(0, input.limit);

    /*
     * The held bay, for the page that was actually returned.
     *
     * One extra query rather than a join, and deliberately: the list query above is a
     * keyset page whose cursor comparison and ordering are tuned around esident alone,
     * and a join would widen that tuple for a column nothing sorts or pages by. One
     * round trip for the whole page is also not N+1 - the ids are already in hand.
     */
    const bayByResident = await this.activeBays(page.map((r) => r.id));
    const items = page.map((r) => toResident(r, bayByResident.get(r.id) ?? null));
    const last = rows.length > input.limit ? page[page.length - 1] : undefined;
    const nextCursor = last
      ? Buffer.from(`${cursorValue(field, last)}|${last.id}`, 'utf8').toString('base64url')
      : null;

    return { items, nextCursor };
  }

  /**
   * One transaction for two writes: the resident and the `ResidentCreated` outbox event.
   * The outbox guarantee only holds if the event is committed with the change it
   * describes - a rolled-back insert must not leave an event behind, and a committed
   * insert must not go unannounced (section 15).
   *
   * There is no fairness row to create any more: waiting time is computed from
   * participation_started_at, which the column default sets to now(), so a resident
   * starts accruing the moment they exist and nothing has to be kept up to date.
   */
  async create(input: {
    email: string;
    fullName: string;
    unitNumber: string;
    needsAccessibleSpot: boolean;
    hasElectricVehicle: boolean;
    isAdmin: boolean;
  }): Promise<Resident> {
    const row = await this.db.transaction().execute(async (trx) => {
      const r = await trx
        .insertInto('resident')
        .values({
          email: input.email,
          full_name: input.fullName,
          unit_number: input.unitNumber,
          needs_accessible_spot: input.needsAccessibleSpot,
          has_electric_vehicle: input.hasElectricVehicle,
          is_admin: input.isAdmin,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('event_outbox')
        .values({
          event_type: 'ResidentCreated',
          aggregate_type: 'Resident',
          aggregate_id: r.id,
          payload: JSON.stringify({
            residentId: r.id,
            email: input.email,
            fullName: input.fullName,
          }),
        })
        .execute();

      return r;
    });

    return toResident(row as Row);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<Resident, 'fullName' | 'unitNumber' | 'needsAccessibleSpot' | 'hasElectricVehicle' | 'isAdmin'>
    >,
  ): Promise<Resident | null> {
    const values: Record<string, unknown> = {};
    if (patch.fullName !== undefined) values.full_name = patch.fullName;
    if (patch.unitNumber !== undefined) values.unit_number = patch.unitNumber;
    if (patch.needsAccessibleSpot !== undefined) {
      values.needs_accessible_spot = patch.needsAccessibleSpot;
    }
    if (patch.hasElectricVehicle !== undefined) {
      values.has_electric_vehicle = patch.hasElectricVehicle;
    }
    if (patch.isAdmin !== undefined) values.is_admin = patch.isAdmin;
    if (Object.keys(values).length === 0) return this.findById(id);

    const r = await this.db
      .updateTable('resident')
      .set(values as never)
      .where('id', '=', id)
      .where('deactivated_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    return r ? toResident(r as Row) : null;
  }

  async setEligibility(id: string, isEligible: boolean, reason: string | null): Promise<Resident | null> {
    const r = await this.db
      .updateTable('resident')
      .set({ is_eligible: isEligible, ineligible_reason: reason })
      .where('id', '=', id)
      .where('deactivated_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    return r ? toResident(r as Row) : null;
  }

  /**
   * Moving the anchor is recorded on the row itself: participation_reset_at says when it
   * last moved, so a resident who asks "why did my waiting time change?" has an answer
   * that does not depend on reading a log.
   */
  async setParticipationStartedAt(id: string, at: Date): Promise<Resident | null> {
    const r = await this.db
      .updateTable('resident')
      .set({ participation_started_at: at, participation_reset_at: new Date() })
      .where('id', '=', id)
      .where('deactivated_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    return r ? toResident(r as Row) : null;
  }

  async linkSubject(id: string, subject: string): Promise<void> {
    await this.db
      .updateTable('resident')
      .set({ external_subject: subject })
      .where('id', '=', id)
      .execute();
  }

  async softDelete(id: string, at: Date): Promise<boolean> {
    const r = await this.db
      .updateTable('resident')
      .set({ deactivated_at: at })
      .where('id', '=', id)
      .where('deactivated_at', 'is', null)
      .executeTakeFirst();
    return Number(r.numUpdatedRows ?? 0) > 0;
  }

  async hasActiveAssignment(id: string): Promise<boolean> {
    const r = await this.db
      .selectFrom('spot_assignment')
      .select('id')
      .where('resident_id', '=', id)
      .where('state', '=', 'ACTIVE')
      .executeTakeFirst();
    return r !== undefined;
  }
}
