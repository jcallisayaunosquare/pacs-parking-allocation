import type { Kysely } from 'kysely';
import type { Database } from '../../../shared/db/schema';
import type { Page, Resident, ResidentRepository } from '../application/resident.use-cases';

type Row = {
  id: string;
  external_subject: string | null;
  email: string;
  full_name: string;
  unit_number: string;
  is_eligible: boolean;
  ineligible_reason: string | null;
  needs_accessible_spot: boolean;
  created_at: Date;
  deactivated_at: Date | null;
};

const toResident = (r: Row): Resident => ({
  id: r.id,
  email: r.email,
  fullName: r.full_name,
  unitNumber: r.unit_number,
  isEligible: r.is_eligible,
  ineligibleReason: r.ineligible_reason,
  needsAccessibleSpot: r.needs_accessible_spot,
  externalSubject: r.external_subject,
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
   * Cursor pagination keyed on (created_at, id) — stable under concurrent inserts,
   * unlike OFFSET. Hard ceiling of 100 is enforced by the HTTP schema (§16).
   */
  async list(input: {
    limit: number;
    cursor?: string;
    unit?: string;
    eligible?: boolean;
  }): Promise<Page<Resident>> {
    let q = this.db.selectFrom('resident').selectAll().where('deactivated_at', 'is', null);

    if (input.unit) q = q.where('unit_number', '=', input.unit);
    if (input.eligible !== undefined) q = q.where('is_eligible', '=', input.eligible);
    if (input.cursor) {
      const [at, id] = Buffer.from(input.cursor, 'base64url').toString('utf8').split('|');
      if (at && id) {
        q = q.where((eb) =>
          eb.or([
            eb('created_at', '>', new Date(at)),
            eb.and([eb('created_at', '=', new Date(at)), eb('id', '>', id)]),
          ]),
        );
      }
    }

    const rows = (await q
      .orderBy('created_at')
      .orderBy('id')
      .limit(input.limit + 1)
      .execute()) as Row[];

    const items = rows.slice(0, input.limit).map(toResident);
    const last = rows.length > input.limit ? items[items.length - 1] : undefined;
    const nextCursor = last
      ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`, 'utf8').toString('base64url')
      : null;

    return { items, nextCursor };
  }

  /**
   * One transaction for three writes: the resident, their fairness row, and the
   * `ResidentCreated` outbox event. The outbox guarantee only holds if the event is
   * committed with the change it describes — a rolled-back insert must not leave an
   * event behind, and a committed insert must not go unannounced (§15).
   */
  async create(input: {
    email: string;
    fullName: string;
    unitNumber: string;
    needsAccessibleSpot: boolean;
  }): Promise<Resident> {
    const row = await this.db.transaction().execute(async (trx) => {
      const r = await trx
        .insertInto('resident')
        .values({
          email: input.email,
          full_name: input.fullName,
          unit_number: input.unitNumber,
          needs_accessible_spot: input.needsAccessibleSpot,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // Every resident has exactly one fairness row from the start, so the draw never
      // has to cope with a missing one.
      await trx
        .insertInto('fairness_state')
        .values({ resident_id: r.id })
        .onConflict((oc) => oc.column('resident_id').doNothing())
        .execute();

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
    patch: Partial<Pick<Resident, 'fullName' | 'unitNumber' | 'needsAccessibleSpot'>>,
  ): Promise<Resident | null> {
    const values: Record<string, unknown> = {};
    if (patch.fullName !== undefined) values.full_name = patch.fullName;
    if (patch.unitNumber !== undefined) values.unit_number = patch.unitNumber;
    if (patch.needsAccessibleSpot !== undefined) {
      values.needs_accessible_spot = patch.needsAccessibleSpot;
    }
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
