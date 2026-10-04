import { fail } from '../../../shared/errors';
import { ok, type Result } from '../../../shared/result';
import type { Clock } from '../../../shared/clock';
import { canTransitionCycle, isRegistrationOpen, quarterLabel } from '../domain/cycle';
import type {
  AssignmentRepository,
  CachePort,
  CycleRecord,
  CycleRepository,
  RegistrationRepository,
} from './ports';
import type { ResidentRepository } from '../../residents/application/resident.use-cases';

export class CycleUseCases {
  constructor(
    private readonly cycles: CycleRepository,
    private readonly registrations: RegistrationRepository,
    private readonly residents: ResidentRepository,
    private readonly assignments: AssignmentRepository,
    private readonly clock: Clock,
    private readonly cache: CachePort,
  ) {}

  async list() {
    return ok(await this.cycles.list());
  }

  /** UC-04 — create a cycle. The label is derived so two admins cannot disagree about it. */
  async create(input: {
    startsOn: Date;
    endsOn: Date;
    registrationOpensAt: Date;
    registrationClosesAt: Date;
    label?: string;
  }): Promise<Result<CycleRecord>> {
    if (input.endsOn <= input.startsOn) {
      return fail('VALIDATION_FAILED', 'The cycle must end after it starts.', [
        { field: 'endsOn', issue: 'must be after startsOn' },
      ]);
    }
    if (input.registrationClosesAt <= input.registrationOpensAt) {
      return fail('VALIDATION_FAILED', 'Registration must close after it opens.', [
        { field: 'registrationClosesAt', issue: 'must be after registrationOpensAt' },
      ]);
    }
    return ok(
      await this.cycles.create({
        label: input.label ?? quarterLabel(input.startsOn),
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        registrationOpensAt: input.registrationOpensAt,
        registrationClosesAt: input.registrationClosesAt,
      }),
    );
  }

  async openRegistration(cycleId: string): Promise<Result<CycleRecord>> {
    return this.transition(cycleId, 'REGISTRATION_OPEN');
  }

  /** Normally the scheduler's job; exposed for the admin override of §16. */
  async closeRegistration(cycleId: string): Promise<Result<CycleRecord>> {
    return this.transition(cycleId, 'REGISTRATION_CLOSED');
  }

  private async transition(
    cycleId: string,
    to: CycleRecord['state'],
  ): Promise<Result<CycleRecord>> {
    const cycle = await this.cycles.transition(cycleId, to);
    if (cycle === null) return fail('NOT_FOUND', 'Cycle not found.');
    return ok(cycle);
  }

  async guardedTransition(cycleId: string, to: CycleRecord['state']): Promise<Result<CycleRecord>> {
    const existing = (await this.cycles.list()).find((c) => c.id === cycleId);
    if (!existing) return fail('NOT_FOUND', 'Cycle not found.');
    if (!canTransitionCycle(existing.state, to)) {
      return fail('INVALID_CYCLE_STATE', `A cycle cannot go from ${existing.state} to ${to}.`);
    }
    return this.transition(cycleId, to);
  }

  /** UC-08 — enter the raffle. Idempotent: registering twice is not an error (§16). */
  async register(cycleId: string, residentId: string): Promise<Result<{ registered: true }>> {
    const cycle = (await this.cycles.list()).find((c) => c.id === cycleId);
    if (!cycle) return fail('NOT_FOUND', 'Cycle not found.');
    if (!isRegistrationOpen(cycle.state)) {
      return fail('REGISTRATION_CLOSED', 'Registration for this cycle is not open.');
    }

    const resident = await this.residents.findById(residentId);
    if (!resident || resident.deactivatedAt !== null) {
      return fail('NOT_FOUND', 'Resident not found.');
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

  /** Withdrawal is only possible while registration is still open (§16). */
  async withdraw(cycleId: string, residentId: string): Promise<Result<{ withdrawn: true }>> {
    const cycle = (await this.cycles.list()).find((c) => c.id === cycleId);
    if (!cycle) return fail('NOT_FOUND', 'Cycle not found.');
    if (!isRegistrationOpen(cycle.state)) {
      return fail('REGISTRATION_CLOSED', 'Registration has closed; you can no longer withdraw.');
    }
    const done = await this.registrations.withdraw(cycleId, residentId);
    if (!done) return fail('NOT_FOUND', 'You are not registered for this cycle.');
    await this.cache.invalidate(`dashboard:${residentId}`).catch(() => undefined);
    return ok({ withdrawn: true } as const);
  }

  /** UC-11 — give up a spot; the waitlist head is promoted in the same transaction. */
  async releaseAssignment(residentId: string): Promise<Result<{ promotedResidentId: string | null }>> {
    const current = await this.assignments.findActiveForResident(residentId);
    if (!current) return fail('NOT_FOUND', 'You do not currently hold a parking spot.');

    const { promotedResidentId } = await this.assignments.release(current.id, this.clock.now());

    await this.cache.invalidate(`dashboard:${residentId}`).catch(() => undefined);
    if (promotedResidentId) {
      await this.cache.invalidate(`dashboard:${promotedResidentId}`).catch(() => undefined);
    }
    return ok({ promotedResidentId });
  }
}
