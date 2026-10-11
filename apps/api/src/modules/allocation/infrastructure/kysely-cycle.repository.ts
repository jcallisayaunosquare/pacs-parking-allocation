import type { Kysely } from 'kysely';
import type { Database } from '../../../shared/db/schema';
import { sql } from 'kysely';
import type { CycleState, TerminationReason } from '../domain/types';
import type {
  AssignmentRepository,
  CycleRecord,
  CycleRepository,
  RegistrationRepository,
} from '../application/ports';

const toCycle = (r: {
  id: string;
  label: string;
  starts_on: Date;
  ends_on: Date;
  state: CycleState;
  registration_opens_at: Date;
  registration_closes_at: Date;
}): CycleRecord => ({
  id: r.id,
  label: r.label,
  startsOn: new Date(r.starts_on),
  endsOn: new Date(r.ends_on),
  state: r.state,
  registrationOpensAt: new Date(r.registration_opens_at),
  registrationClosesAt: new Date(r.registration_closes_at),
});

export class KyselyCycleRepository implements CycleRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: Omit<CycleRecord, 'id' | 'state'>): Promise<CycleRecord> {
    const r = await this.db
      .insertInto('allocation_cycle')
      .values({
        label: input.label,
        starts_on: input.startsOn,
        ends_on: input.endsOn,
        registration_opens_at: input.registrationOpensAt,
        registration_closes_at: input.registrationClosesAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toCycle(r as never);
  }

  async list(): Promise<readonly CycleRecord[]> {
    const rows = await this.db
      .selectFrom('allocation_cycle')
      .selectAll()
      .orderBy('starts_on', 'desc')
      .execute();
    return rows.map((r) => toCycle(r as never));
  }

  async transition(cycleId: string, to: CycleState): Promise<CycleRecord | null> {
    const r = await this.db
      .updateTable('allocation_cycle')
      .set({ state: to })
      .where('id', '=', cycleId)
      .returningAll()
      .executeTakeFirst();
    return r ? toCycle(r as never) : null;
  }

  async findByState(state: CycleState): Promise<readonly CycleRecord[]> {
    const rows = await this.db
      .selectFrom('allocation_cycle')
      .selectAll()
      .where('state', '=', state)
      .execute();
    return rows.map((r) => toCycle(r as never));
  }

  async findUpcoming(now: Date): Promise<CycleRecord | null> {
    const r = await this.db
      .selectFrom('allocation_cycle')
      .selectAll()
      .where('registration_closes_at', '>', now)
      .where('state', 'in', ['DRAFT', 'REGISTRATION_OPEN'])
      .orderBy('registration_opens_at')
      .executeTakeFirst();
    return r ? toCycle(r as never) : null;
  }

  async findById(cycleId: string): Promise<CycleRecord | null> {
    const r = await this.db
      .selectFrom('allocation_cycle')
      .selectAll()
      .where('id', '=', cycleId)
      .executeTakeFirst();
    return r ? toCycle(r as never) : null;
  }

  async rename(cycleId: string, label: string): Promise<CycleRecord | null> {
    const r = await this.db
      .updateTable('allocation_cycle')
      .set({ label })
      .where('id', '=', cycleId)
      .returningAll()
      .executeTakeFirst();
    return r ? toCycle(r as never) : null;
  }

  /**
   * What the period has produced. Counted rather than existence-checked, because the
   * number is what the refusal message says back to the administrator.
   */
  async consequences(cycleId: string): Promise<{ hasRun: boolean; assignments: number }> {
    const [run, assigned] = await Promise.all([
      this.db
        .selectFrom('allocation_run')
        .select('id')
        .where('cycle_id', '=', cycleId)
        .executeTakeFirst(),
      this.db
        .selectFrom('spot_assignment')
        .select(({ fn }) => fn.countAll<string>().as('n'))
        .where('cycle_id', '=', cycleId)
        .executeTakeFirst(),
    ]);
    return { hasRun: run !== undefined, assignments: Number(assigned?.n ?? 0) };
  }

  /**
   * A real delete, not a soft one, and only ever called for a period the domain has
   * already ruled has no history. Registrations go with it: a registration for a period
   * that never drew records nothing anybody can contest.
   */
  async remove(cycleId: string): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('raffle_registration').where('cycle_id', '=', cycleId).execute();
      const r = await trx
        .deleteFrom('allocation_cycle')
        .where('id', '=', cycleId)
        .executeTakeFirst();
      return Number(r.numDeletedRows ?? 0) > 0;
    });
  }

  /**
   * Closes one period now, ending the assignments it handed out.
   *
   * The administrator's version of what the sweeper does on a schedule, and the
   * difference is the instant: the sweeper closes a period whose `ends_on` has passed and
   * sets benefit_ended_at to valid_until, because the benefit ended when the period did
   * and a late sweep must not cost the resident waiting time. Closing early ends the
   * benefit *now*, so now is what is recorded - the resident had the bay until this
   * moment and rule C should say so.
   *
   * counts_as_served stays true: they held the bay and consumed the allocation, which is
   * the EXPIRED row of terminationPolicy. One transaction, because a closed period whose
   * assignments are still ACTIVE would read as residents holding bays in a period that
   * is over.
   */
  async closeNow(cycleId: string, at: Date): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const closed = await trx
        .updateTable('allocation_cycle')
        .set({ state: 'CLOSED' })
        .where('id', '=', cycleId)
        .where('state', '=', 'ACTIVE')
        .executeTakeFirst();
      if (Number(closed.numUpdatedRows ?? 0) === 0) return false;

      await trx
        .updateTable('spot_assignment')
        .set({
          state: 'EXPIRED',
          benefit_ended_at: at,
          counts_as_served: true,
          termination_reason: 'EXPIRED',
        })
        .where('cycle_id', '=', cycleId)
        .where('state', '=', 'ACTIVE')
        .execute();

      return true;
    });
  }
}

export class KyselyRegistrationRepository implements RegistrationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Idempotent: a second POST un-withdraws rather than erroring (section 16). */
  async register(cycleId: string, residentId: string): Promise<{ created: boolean }> {
    const r = await this.db
      .insertInto('raffle_registration')
      .values({ cycle_id: cycleId, resident_id: residentId, withdrawn: false })
      .onConflict((oc) =>
        oc.constraint('uq_registration_per_cycle').doUpdateSet({ withdrawn: false }),
      )
      .returning('id')
      .executeTakeFirst();
    return { created: r !== undefined };
  }

  /**
   * The withdrawal instant is kept even if the resident registers again afterwards: the
   * boolean answers "are they in this draw", the timestamp answers "did they once take a
   * bay off the board", and only the second one decides anything about fairness.
   */
  async withdraw(cycleId: string, residentId: string, at: Date): Promise<boolean> {
    const r = await this.db
      .updateTable('raffle_registration')
      .set({ withdrawn: true, withdrawn_at: at })
      .where('cycle_id', '=', cycleId)
      .where('resident_id', '=', residentId)
      .where('withdrawn', '=', false)
      .executeTakeFirst();
    return Number(r.numUpdatedRows ?? 0) > 0;
  }

  async isRegistered(cycleId: string, residentId: string): Promise<boolean> {
    const r = await this.db
      .selectFrom('raffle_registration')
      .select('id')
      .where('cycle_id', '=', cycleId)
      .where('resident_id', '=', residentId)
      .where('withdrawn', '=', false)
      .executeTakeFirst();
    return r !== undefined;
  }
}

export class KyselyAssignmentRepository implements AssignmentRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async findActiveForResident(residentId: string) {
    const r = await this.db
      .selectFrom('spot_assignment as sa')
      .innerJoin('parking_spot as ps', 'ps.id', 'sa.spot_id')
      .select([
        'sa.id as id',
        'sa.cycle_id as cycleId',
        'sa.spot_id as spotId',
        'ps.spot_code as spotCode',
        'ps.level as level',
        'ps.type as type',
        'sa.state as state',
        'sa.valid_from as validFrom',
        'sa.valid_until as validUntil',
      ])
      .where('sa.resident_id', '=', residentId)
      .where('sa.state', '=', 'ACTIVE')
      .executeTakeFirst();

    return r
      ? {
          ...r,
          validFrom: new Date(r.validFrom),
          validUntil: new Date(r.validUntil),
        }
      : null;
  }

  async listForRun(runId: string) {
    const rows = await this.db
      .selectFrom('spot_assignment as sa')
      .innerJoin('parking_spot as ps', 'ps.id', 'sa.spot_id')
      .select(['sa.resident_id as residentId', 'sa.spot_id as spotId', 'ps.spot_code as spotCode'])
      .where('sa.run_id', '=', runId)
      .orderBy('ps.spot_code')
      .execute();
    return rows;
  }

  /**
   * Release and promote in one transaction: the released bay goes to the waitlist head,
   * so there is no window in which the bay is unassigned but the waitlist is unchanged.
   *
   * benefit_ended_at and counts_as_served come from the domain's termination policy, not
   * from this method: the repository records the decision, it does not make it. Writing
   * benefit_ended_at here *is* rule C's "receiving an allocation resets waiting time" -
   * no counter is touched, because there is no counter.
   */
  async release(
    assignmentId: string,
    at: Date,
    termination: { benefitEndedAt: Date; countsAsServed: boolean; reason: TerminationReason },
  ): Promise<{ promotedResidentId: string | null }> {
    return this.db.transaction().execute(async (trx) => {
      const released = await trx
        .updateTable('spot_assignment')
        .set({
          state: 'RELEASED',
          released_at: at,
          benefit_ended_at: termination.benefitEndedAt,
          counts_as_served: termination.countsAsServed,
          termination_reason: termination.reason,
        })
        .where('id', '=', assignmentId)
        .where('state', '=', 'ACTIVE')
        .returningAll()
        .executeTakeFirst();

      if (!released) return { promotedResidentId: null };

      const head = await trx
        .selectFrom('waitlist_entry')
        .selectAll()
        .where('cycle_id', '=', released.cycle_id)
        .where('state', '=', 'WAITING')
        .orderBy('position')
        .executeTakeFirst();

      if (!head) return { promotedResidentId: null };

      await trx
        .updateTable('waitlist_entry')
        .set({ state: 'PROMOTED' })
        .where('id', '=', head.id)
        .execute();

      await trx
        .insertInto('spot_assignment')
        .values({
          cycle_id: released.cycle_id,
          run_id: released.run_id,
          resident_id: head.resident_id,
          spot_id: released.spot_id,
          state: 'ACTIVE',
          valid_from: at,
          valid_until: released.valid_until,
        })
        .execute();

      await trx
        .insertInto('event_outbox')
        .values([
          {
            event_type: 'AssignmentReleased',
            aggregate_type: 'SpotAssignment',
            aggregate_id: released.id,
            payload: JSON.stringify({
              residentId: released.resident_id,
              spotId: released.spot_id,
            }),
          },
          {
            event_type: 'WaitlistPromoted',
            aggregate_type: 'WaitlistEntry',
            aggregate_id: head.id,
            payload: JSON.stringify({
              residentId: head.resident_id,
              spotId: released.spot_id,
            }),
          },
        ])
        .execute();

      return { promotedResidentId: head.resident_id };
    });
  }

  /**
   * UC-14 - expire assignments whose cycle has ended, and close those cycles.
   *
   * The benefit ended when the period did, not when the sweeper happened to run, so
   * benefit_ended_at is valid_until: a late sweep must not cost the resident waiting time.
   */
  async expireDue(now: Date): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const res = await trx
        .updateTable('spot_assignment')
        .set({
          state: 'EXPIRED',
          benefit_ended_at: sql`valid_until`,
          counts_as_served: true,
          termination_reason: 'EXPIRED',
        })
        .where('state', '=', 'ACTIVE')
        .where('valid_until', '<', now)
        .executeTakeFirst();

      await trx
        .updateTable('allocation_cycle')
        .set({ state: 'CLOSED' })
        .where('state', '=', 'ACTIVE')
        .where('ends_on', '<', now)
        .execute();

      return Number(res.numUpdatedRows ?? 0);
    });
  }
}
