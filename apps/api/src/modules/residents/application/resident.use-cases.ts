import { fail } from '../../../shared/errors';
import { ok, type Result } from '../../../shared/result';
import type { Clock } from '../../../shared/clock';
import type { EventBus } from '../../../shared/events/dynamodb-event-bus';

export interface Resident {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly unitNumber: string;
  readonly isEligible: boolean;
  readonly ineligibleReason: string | null;
  readonly needsAccessibleSpot: boolean;
  readonly hasElectricVehicle: boolean;
  /**
   * Separation of duties: an administrator operates the raffle, so an administrator never
   * holds a bay and never enters the draw.
   */
  readonly isAdmin: boolean;
  /** Rule C's anchor for a resident who has never held a bay. Admin-correctable. */
  readonly participationStartedAt: Date;
  readonly externalSubject: string | null;
  /**
   * The bay this resident holds right now, or null.
   *
   * Carried on the register so an administrator is told before they act rather than
   * after: removing a resident who holds a bay is refused, and a refusal that only
   * arrives once the button has been pressed is a worse answer than a row that already
   * said so.
   */
  readonly currentSpotCode: string | null;
  readonly createdAt: Date;
  readonly deactivatedAt: Date | null;
}

/** The reason an administrator account is never a candidate, shown wherever it is refused. */
export const ADMIN_NOT_ELIGIBLE_REASON =
  'Administrator accounts cannot hold a bay or enter the draw: the administrator operates the raffle.';

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** The columns an administrator may sort the register by. */
export const RESIDENT_SORT_FIELDS = ['name', 'unit', 'email', 'eligibility', 'created'] as const;
export type ResidentSortField = (typeof RESIDENT_SORT_FIELDS)[number];
export type SortDirection = 'asc' | 'desc';

export interface ResidentListQuery {
  readonly limit: number;
  readonly cursor?: string;
  readonly unit?: string;
  readonly eligible?: boolean;
  readonly sort?: ResidentSortField;
  readonly dir?: SortDirection;
}

export interface ResidentRepository {
  findById(id: string): Promise<Resident | null>;
  findBySubject(subject: string): Promise<Resident | null>;
  findByEmail(email: string): Promise<Resident | null>;
  list(input: ResidentListQuery): Promise<Page<Resident>>;
  create(input: {
    email: string;
    fullName: string;
    unitNumber: string;
    needsAccessibleSpot: boolean;
    hasElectricVehicle: boolean;
    isAdmin: boolean;
  }): Promise<Resident>;
  update(
    id: string,
    patch: Partial<
      Pick<Resident, 'fullName' | 'unitNumber' | 'needsAccessibleSpot' | 'hasElectricVehicle' | 'isAdmin'>
    >,
  ): Promise<Resident | null>;
  /** Rule C: the anchor is a stored, correctable column, and a correction is audited. */
  setParticipationStartedAt(id: string, at: Date): Promise<Resident | null>;
  setEligibility(id: string, isEligible: boolean, reason: string | null): Promise<Resident | null>;
  linkSubject(id: string, subject: string): Promise<void>;
  softDelete(id: string, at: Date): Promise<boolean>;
  hasActiveAssignment(id: string): Promise<boolean>;
}

export class ResidentUseCases {
  constructor(
    private readonly repo: ResidentRepository,
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  async list(input: ResidentListQuery) {
    return ok(await this.repo.list(input));
  }

  async get(id: string): Promise<Result<Resident>> {
    const r = await this.repo.findById(id);
    return r ? ok(r) : fail('NOT_FOUND', 'Resident not found.');
  }

  /**
   * FR-10 - create a resident. The Cognito user is provisioned asynchronously.
   *
   * This function runs inside the VPC and has no route to Cognito (ADR-016), so it
   * does not call it. Instead the row and a `ResidentCreated` event are written in one
   * transaction - the outbox guarantee: no event can survive a rolled-back insert, and
   * no insert can be silently unannounced. The event is then pushed to the stream so
   * `integrations`, which runs outside the VPC, provisions the user within a second.
   * If that push fails, the sweeper relays the outbox row on its next pass.
   */
  async create(input: {
    email: string;
    fullName: string;
    unitNumber: string;
    needsAccessibleSpot?: boolean;
    hasElectricVehicle?: boolean;
    isAdmin?: boolean;
  }): Promise<Result<Resident>> {
    if (await this.repo.findByEmail(input.email)) {
      return fail('VALIDATION_FAILED', 'A resident with that email already exists.', [
        { field: 'email', issue: 'already in use' },
      ]);
    }

    const resident = await this.repo.create({
      email: input.email,
      fullName: input.fullName,
      unitNumber: input.unitNumber,
      needsAccessibleSpot: input.needsAccessibleSpot ?? false,
      hasElectricVehicle: input.hasElectricVehicle ?? false,
      isAdmin: input.isAdmin ?? false,
    });

    // Eager relay: latency only. The transactional outbox row is the source of truth,
    // so a failure here delays provisioning rather than losing it.
    await this.bus
      .publish([
        {
          eventType: 'ResidentCreated',
          aggregateType: 'Resident',
          aggregateId: resident.id,
          payload: {
            residentId: resident.id,
            email: resident.email,
            fullName: resident.fullName,
          },
        },
      ])
      .catch(() => undefined);

    return ok(resident);
  }

  async update(
    id: string,
    patch: {
      fullName?: string;
      unitNumber?: string;
      needsAccessibleSpot?: boolean;
      hasElectricVehicle?: boolean;
      isAdmin?: boolean;
    },
  ): Promise<Result<Resident>> {
    // Marking a resident as an administrator takes them out of the draw, so it cannot be
    // done while they are holding a bay - the bay has to be released first.
    if (patch.isAdmin === true && (await this.repo.hasActiveAssignment(id))) {
      return fail(
        'SPOT_IN_USE',
        'This resident holds a bay. Release it before making the account an administrator.',
      );
    }
    const r = await this.repo.update(id, patch);
    return r ? ok(r) : fail('NOT_FOUND', 'Resident not found.');
  }

  /**
   * FR-15's sibling for rule C: correcting the waiting anchor. "The admin set me up late"
   * is an inevitable dispute, and it has one correctable field with an audit row rather
   * than requiring history surgery.
   */
  async setParticipationStart(id: string, at: Date): Promise<Result<Resident>> {
    if (Number.isNaN(at.getTime())) {
      return fail('VALIDATION_FAILED', 'That is not a valid instant.', [
        { field: 'participationStartedAt', issue: 'must be an ISO-8601 instant' },
      ]);
    }
    if (at.getTime() > this.clock.now().getTime()) {
      return fail('VALIDATION_FAILED', 'Waiting cannot start in the future.', [
        { field: 'participationStartedAt', issue: 'must not be in the future' },
      ]);
    }
    const r = await this.repo.setParticipationStartedAt(id, at);
    return r ? ok(r) : fail('NOT_FOUND', 'Resident not found.');
  }

  /** FR-15 - eligibility always carries a reason, and the change is audit-logged. */
  async setEligibility(
    id: string,
    isEligible: boolean,
    reason: string | null,
  ): Promise<Result<Resident>> {
    if (!isEligible && !reason?.trim()) {
      return fail('VALIDATION_FAILED', 'A reason is required when marking a resident ineligible.', [
        { field: 'reason', issue: 'required' },
      ]);
    }
    const r = await this.repo.setEligibility(id, isEligible, isEligible ? null : reason!.trim());
    return r ? ok(r) : fail('NOT_FOUND', 'Resident not found.');
  }

  /** Soft delete: history is preserved (section 16 DELETE /residents/{id}). */
  async deactivate(id: string): Promise<Result<{ deactivated: true }>> {
    if (await this.repo.hasActiveAssignment(id)) {
      return fail(
        'SPOT_IN_USE',
        'This resident holds a bay. Release it before removing them from the register.',
      );
    }
    const done = await this.repo.softDelete(id, this.clock.now());
    return done ? ok({ deactivated: true } as const) : fail('NOT_FOUND', 'Resident not found.');
  }
}
