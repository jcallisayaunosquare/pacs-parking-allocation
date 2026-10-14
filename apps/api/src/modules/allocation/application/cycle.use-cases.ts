import { fail } from '../../../shared/errors';
import { ok, type Result } from '../../../shared/result';
import type { Clock } from '../../../shared/clock';
import {
  canTransitionCycle,
  cycleRemovalBlocker,
  isRegistrationOpen,
  periodEnd,
  periodLabel,
} from '../domain/cycle';
import { terminationPolicy } from '../domain/termination-policy';
import type {
  AllocationConfigProvider,
  AssignmentRepository,
  CachePort,
  CycleRecord,
  CycleRepository,
  RegistrationRepository,
} from './ports';
import {
  ADMIN_NOT_ELIGIBLE_REASON,
  type ResidentRepository,
} from '../../residents/application/resident.use-cases';

export class CycleUseCases {
  constructor(
    private readonly cycles: CycleRepository,
    private readonly registrations: RegistrationRepository,
    private readonly residents: ResidentRepository,
    private readonly assignments: AssignmentRepository,
    private readonly config: AllocationConfigProvider,
    private readonly clock: Clock,
    private readonly cache: CachePort,
  ) {}

  async list() {
    return ok(await this.cycles.list());
  }

  /**
   * Renaming a period. The only field an administrator may change after creation.
   *
   * The dates are deliberately not editable: a period's boundary is stamped onto every
   * assignment it made and onto the run that made them, so moving it would silently
   * rewrite when a resident's bay ended and therefore when their waiting time restarted.
   * A name carries no such weight - it is how people refer to the period, not how the
   * rule reads it.
   */
  async rename(cycleId: string, label: string): Promise<Result<CycleRecord>> {
    const trimmed = label.trim();
    if (trimmed.length === 0) {
      return fail('VALIDATION_FAILED', 'A period needs a name.', [
        { field: 'label', issue: 'must not be empty' },
      ]);
    }
    const saved = await this.cycles.rename(cycleId, trimmed);
    if (!saved) return fail('NOT_FOUND', 'No such period.');
    await this.cache.invalidate('dashboard:').catch(() => undefined);
    return ok(saved);
  }

  /**
   * Removing a period. The domain decides whether it may go; this reads the facts the
   * decision needs and reports the domain's own words back when the answer is no.
   */
  async remove(cycleId: string): Promise<Result<{ removed: true }>> {
    const cycle = await this.cycles.findById(cycleId);
    if (!cycle) return fail('NOT_FOUND', 'No such period.');

    const consequences = await this.cycles.consequences(cycleId);
    const blocker = cycleRemovalBlocker({ state: cycle.state, ...consequences });
    // INVALID_CYCLE_STATE, not a generic conflict: what refuses the removal is the
    // state the period has reached, which is exactly what this code means (422).
    if (blocker) return fail('INVALID_CYCLE_STATE', blocker);

    const removed = await this.cycles.remove(cycleId);
    if (!removed) return fail('NOT_FOUND', 'No such period.');

    await this.cache.invalidate('dashboard:').catch(() => undefined);
    return ok({ removed: true as const });
  }

  /**
   * UC-04 - create a cycle.
   *
   * `endsOn` is optional: left out, it is computed from the configured allocation
   * duration with end-of-month clamping, and the label carries that duration rather than
   * a quarter number. Both are then *persisted*, so a later change to the duration
   * applies to the next cycle and can never move the boundary of this one (E-6, E-9).
   */
  async create(input: {
    startsOn: Date;
    endsOn?: Date;
    registrationOpensAt: Date;
    registrationClosesAt: Date;
    label?: string;
  }): Promise<Result<CycleRecord>> {
    const { allocationDurationMonths } = await this.config.current();
    const endsOn = input.endsOn ?? periodEnd(input.startsOn, allocationDurationMonths);

    if (endsOn <= input.startsOn) {
      return fail('VALIDATION_FAILED', 'The cycle must end after it starts.', [
        { field: 'endsOn', issue: 'must be after startsOn' },
      ]);
    }
    if (input.registrationClosesAt <= input.registrationOpensAt) {
      return fail('VALIDATION_FAILED', 'Registration must close after it opens.', [
        { field: 'registrationClosesAt', issue: 'must be after registrationOpensAt' },
      ]);
    }
    const created = await this.cycles.create({
      label: input.label ?? periodLabel(input.startsOn, allocationDurationMonths),
      startsOn: input.startsOn,
      endsOn,
      registrationOpensAt: input.registrationOpensAt,
      registrationClosesAt: input.registrationClosesAt,
    });
    // A new period can be the one every resident's dashboard announces as next.
    await this.cache.invalidate('dashboard:').catch(() => undefined);
    return ok(created);
  }

  async openRegistration(cycleId: string): Promise<Result<CycleRecord>> {
    return this.transition(cycleId, 'REGISTRATION_OPEN');
  }

  /** Normally the scheduler's job; exposed for the admin override of section 16. */
  async closeRegistration(cycleId: string): Promise<Result<CycleRecord>> {
    return this.transition(cycleId, 'REGISTRATION_CLOSED');
  }

  private async transition(
    cycleId: string,
    to: CycleRecord['state'],
  ): Promise<Result<CycleRecord>> {
    const cycle = await this.cycles.transition(cycleId, to);
    if (cycle === null) return fail('NOT_FOUND', 'Cycle not found.');
    /*
     * The state is what every resident's dashboard keys its action on: opening
     * registration is what shows "Enter the draw". Without this the cached payload kept
     * saying DRAFT for up to five minutes after the period was opened, and the button
     * did not appear.
     */
    await this.cache.invalidate('dashboard:').catch(() => undefined);
    return ok(cycle);
  }

  /**
   * Ends the period that is in effect.
   *
   * The administrator needs this because a draw is refused while an allocation is in
   * force - see drawBlocker - and without a way to end one early the next draw would
   * have to wait for `ends_on` and the sweeper. Ending a period is also a real operation
   * in its own right: the building changes the arrangement before the quarter is out.
   *
   * It is not a transition anyone can make from anywhere: ACTIVE is the only state this
   * means anything from, which is what CYCLE_TRANSITIONS already says, and the repository
   * repeats the condition in its WHERE so two callers at once cannot both believe they
   * closed it.
   */
  async close(cycleId: string): Promise<Result<CycleRecord>> {
    const existing = await this.cycles.findById(cycleId);
    if (!existing) return fail('NOT_FOUND', 'No such period.');
    if (!canTransitionCycle(existing.state, 'CLOSED')) {
      return fail(
        'INVALID_CYCLE_STATE',
        `Only a period in effect can be closed; this one is ${existing.state}.`,
      );
    }

    const closed = await this.cycles.closeNow(cycleId, this.clock.now());
    if (!closed) return fail('INVALID_CYCLE_STATE', 'This period is no longer in effect.');

    await this.cache.invalidate('dashboard:').catch(() => undefined);
    const after = await this.cycles.findById(cycleId);
    return after ? ok(after) : fail('NOT_FOUND', 'No such period.');
  }

  async guardedTransition(cycleId: string, to: CycleRecord['state']): Promise<Result<CycleRecord>> {
    const existing = (await this.cycles.list()).find((c) => c.id === cycleId);
    if (!existing) return fail('NOT_FOUND', 'Cycle not found.');
    if (!canTransitionCycle(existing.state, to)) {
      return fail('INVALID_CYCLE_STATE', `A cycle cannot go from ${existing.state} to ${to}.`);
    }
    return this.transition(cycleId, to);
  }

  /**
   * UC-08 - enter the raffle. Idempotent: registering twice is not an error (section 16).
   *
   * `actorIsAdmin` is the ADMIN role on the *verified token*, which is a second and
   * independent source of the same fact as `resident.is_admin` below. They can disagree:
   * an account added to the Cognito ADMIN group whose register row was never flagged used
   * to pass every check here and go on to be ranked as a candidate. Both are refused, and
   * neither is trusted alone — the register row because an operator edits it, the token
   * because it is the thing that actually grants the administrator their powers.
   */
  async register(
    cycleId: string,
    residentId: string,
    actorIsAdmin = false,
  ): Promise<Result<{ registered: true }>> {
    if (actorIsAdmin) return fail('FORBIDDEN', ADMIN_NOT_ELIGIBLE_REASON);

    const cycle = (await this.cycles.list()).find((c) => c.id === cycleId);
    if (!cycle) return fail('NOT_FOUND', 'Cycle not found.');
    if (!isRegistrationOpen(cycle.state)) {
      return fail('REGISTRATION_CLOSED', 'Registration for this cycle is not open.');
    }

    const resident = await this.residents.findById(residentId);
    if (!resident || resident.deactivatedAt !== null) {
      return fail('NOT_FOUND', 'Resident not found.');
    }
    // Separation of duties, and it is refused here as well as excluded at snapshot time:
    // the administrator operates the raffle, so an administrator account never enters it.
    if (resident.isAdmin) {
      return fail('FORBIDDEN', ADMIN_NOT_ELIGIBLE_REASON);
    }
    if (!resident.isEligible) {
      return fail(
        'NOT_ELIGIBLE',
        resident.ineligibleReason ?? 'You are not currently eligible for the parking raffle.',
      );
    }

    await this.registrations.register(cycleId, residentId);
    await this.cache.invalidate(`dashboard:${residentId}`).catch(() => undefined);
    return ok({ registered: true } as const);
  }

  /** Withdrawal is only possible while registration is still open (section 16). */
  async withdraw(cycleId: string, residentId: string): Promise<Result<{ withdrawn: true }>> {
    const cycle = (await this.cycles.list()).find((c) => c.id === cycleId);
    if (!cycle) return fail('NOT_FOUND', 'Cycle not found.');
    if (!isRegistrationOpen(cycle.state)) {
      return fail('REGISTRATION_CLOSED', 'Registration has closed; you can no longer withdraw.');
    }
    const done = await this.registrations.withdraw(cycleId, residentId, this.clock.now());
    if (!done) return fail('NOT_FOUND', 'You are not registered for this cycle.');
    await this.cache.invalidate(`dashboard:${residentId}`).catch(() => undefined);
    return ok({ withdrawn: true } as const);
  }

  /**
   * UC-11 - give up a bay; the waitlist head is promoted in the same transaction.
   *
   * The termination is decided by the pure domain policy and passed to the repository, so
   * whether this counted as an allocation is one testable function rather than a rule
   * spread across SQL. A release counts as served and the anchor moves to the release
   * instant: you trade parking days for waiting days, one for one.
   */
  async releaseAssignment(residentId: string): Promise<Result<{ promotedResidentId: string | null }>> {
    const current = await this.assignments.findActiveForResident(residentId);
    if (!current) return fail('NOT_FOUND', 'You do not currently hold a parking spot.');

    const at = this.clock.now();
    const termination = terminationPolicy({ reason: 'RELEASED', at });

    const { promotedResidentId } = await this.assignments.release(current.id, at, termination);

    await this.cache.invalidate(`dashboard:${residentId}`).catch(() => undefined);
    if (promotedResidentId) {
      await this.cache.invalidate(`dashboard:${promotedResidentId}`).catch(() => undefined);
    }
    return ok({ promotedResidentId });
  }
}
