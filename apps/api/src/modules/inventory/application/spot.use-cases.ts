import { fail } from '../../../shared/errors';
import { ok, type Result } from '../../../shared/result';
import type { Clock } from '../../../shared/clock';
import type { SpotType } from '../../allocation/domain/types';
import { lotOccupancy, spotRemovalBlocker, type BayRow } from '../domain/spot';

export interface ParkingSpot {
  readonly id: string;
  readonly spotCode: string;
  readonly level: string;
  readonly type: SpotType;
  readonly isActive: boolean;
  readonly notes: string | null;
  readonly createdAt: Date;
}

export interface SpotRepository {
  findById(id: string): Promise<ParkingSpot | null>;
  findByCode(code: string): Promise<ParkingSpot | null>;
  list(input: { activeOnly?: boolean; type?: SpotType }): Promise<readonly ParkingSpot[]>;
  create(input: { spotCode: string; level: string; type: SpotType; notes: string | null }): Promise<ParkingSpot>;
  update(
    id: string,
    patch: { level?: string; type?: SpotType; notes?: string | null; isActive?: boolean },
    deactivatedAt: Date | null,
  ): Promise<ParkingSpot | null>;
  isCurrentlyAssigned(id: string): Promise<boolean>;
  consequences(id: string): Promise<{ assignments: number; historyRows: number }>;
  remove(id: string): Promise<boolean>;
  /** Every bay on a level with its live (ACTIVE) assignment, if it has one. */
  occupancy(level: string): Promise<readonly BayRow[]>;
  /** Levels with at least one bay in service, with how many bays each, in level order. */
  levels(): Promise<readonly { readonly level: string; readonly bays: number }[]>;
}

export class SpotUseCases {
  constructor(
    private readonly repo: SpotRepository,
    private readonly clock: Clock,
  ) {}

  async list(input: { activeOnly?: boolean; type?: SpotType }) {
    return ok(await this.repo.list(input));
  }

  /** The levels of the lot, as the inventory has them - the plan draws one per level. */
  async levels() {
    return ok(await this.repo.levels());
  }

  /** The lot plan's live state for one level, redacted for who is asking. */
  async occupancy(
    level: string,
    viewer: { residentId: string | null; isAdmin: boolean },
  ) {
    return ok(lotOccupancy(await this.repo.occupancy(level), viewer));
  }

  /** FR-16 — spot codes are the human identifier and must stay unique. */
  async create(input: {
    spotCode: string;
    level: string;
    type?: SpotType;
    notes?: string | null;
  }): Promise<Result<ParkingSpot>> {
    const code = input.spotCode.trim().toUpperCase();
    if (await this.repo.findByCode(code)) {
      return fail('VALIDATION_FAILED', 'A spot with that code already exists.', [
        { field: 'spotCode', issue: 'already in use' },
      ]);
    }
    return ok(
      await this.repo.create({
        spotCode: code,
        level: input.level.trim(),
        type: input.type ?? 'STANDARD',
        notes: input.notes ?? null,
      }),
    );
  }

  /**
   * Deactivation refuses while the spot is assigned (§16). Taking a bay out of the
   * inventory under a resident who is parked in it is an operational problem, not a
   * data one, so it is blocked rather than cascaded.
   */
  async update(
    id: string,
    patch: { level?: string; type?: SpotType; notes?: string | null; isActive?: boolean },
  ): Promise<Result<ParkingSpot>> {
    const existing = await this.repo.findById(id);
    if (!existing) return fail('NOT_FOUND', 'Parking spot not found.');

    if (patch.isActive === false && (await this.repo.isCurrentlyAssigned(id))) {
      return fail('SPOT_IN_USE', 'This spot is assigned for the current cycle and cannot be deactivated.');
    }

    const deactivatedAt = patch.isActive === false ? this.clock.now() : null;
    const updated = await this.repo.update(id, patch, deactivatedAt);
    return updated ? ok(updated) : fail('NOT_FOUND', 'Parking spot not found.');
  }

  /**
   * Removes a bay that has never been given to anybody.
   *
   * The counterpart of removing a period that never drew, and refused on the same
   * grounds: a bay the allocation record names is part of that record. Retiring stays
   * the answer for everything else, which is why the refusal says so.
   *
   * SPOT_IN_USE rather than a generic conflict, because what refuses this is the bay's
   * own history - which is exactly what that code means (409).
   */
  async remove(id: string): Promise<Result<{ removed: true }>> {
    const existing = await this.repo.findById(id);
    if (!existing) return fail('NOT_FOUND', 'Parking spot not found.');

    const blocker = spotRemovalBlocker(await this.repo.consequences(id));
    if (blocker) return fail('SPOT_IN_USE', blocker);

    const removed = await this.repo.remove(id);
    return removed ? ok({ removed: true } as const) : fail('NOT_FOUND', 'Parking spot not found.');
  }
}
