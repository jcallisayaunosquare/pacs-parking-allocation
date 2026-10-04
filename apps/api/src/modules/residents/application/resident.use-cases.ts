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
  readonly externalSubject: string | null;
  readonly createdAt: Date;
  readonly deactivatedAt: Date | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface ResidentRepository {
  findById(id: string): Promise<Resident | null>;
  findBySubject(subject: string): Promise<Resident | null>;
  findByEmail(email: string): Promise<Resident | null>;
  list(input: { limit: number; cursor?: string; unit?: string; eligible?: boolean }): Promise<Page<Resident>>;
  create(input: {
    email: string;
    fullName: string;
    unitNumber: string;
    needsAccessibleSpot: boolean;
  }): Promise<Resident>;
  update(id: string, patch: Partial<Pick<Resident, 'fullName' | 'unitNumber' | 'needsAccessibleSpot'>>): Promise<Resident | null>;
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

  async list(input: { limit: number; cursor?: string; unit?: string; eligible?: boolean }) {
    return ok(await this.repo.list(input));
  }

  async get(id: string): Promise<Result<Resident>> {
    const r = await this.repo.findById(id);
    return r ? ok(r) : fail('NOT_FOUND', 'Resident not found.');
  }

  /**
   * FR-10 — create a resident. The Cognito user is provisioned asynchronously.
   *
   * This function runs inside the VPC and has no route to Cognito (ADR-016), so it
   * does not call it. Instead the row and a `ResidentCreated` event are written in one
   * transaction — the outbox guarantee: no event can survive a rolled-back insert, and
   * no insert can be silently unannounced. The event is then pushed to the stream so
   * `integrations`, which runs outside the VPC, provisions the user within a second.
   * If that push fails, the sweeper relays the outbox row on its next pass.
   */
  async create(input: {
    email: string;
    fullName: string;
    unitNumber: string;
    needsAccessibleSpot?: boolean;
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
    patch: { fullName?: string; unitNumber?: string; needsAccessibleSpot?: boolean },
  ): Promise<Result<Resident>> {
    const r = await this.repo.update(id, patch);
    return r ? ok(r) : fail('NOT_FOUND', 'Resident not found.');
  }

  /** FR-15 — eligibility always carries a reason, and the change is audit-logged. */
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

  /** Soft delete: history is preserved (§16 DELETE /residents/{id}). */
  async deactivate(id: string): Promise<Result<{ deactivated: true }>> {
    if (await this.repo.hasActiveAssignment(id)) {
      return fail('SPOT_IN_USE', 'This resident currently holds a spot; release it first.');
    }
    const done = await this.repo.softDelete(id, this.clock.now());
    return done ? ok({ deactivated: true } as const) : fail('NOT_FOUND', 'Resident not found.');
  }
}
