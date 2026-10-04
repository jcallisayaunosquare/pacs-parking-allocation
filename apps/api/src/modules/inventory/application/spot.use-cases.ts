import { fail } from '../../../shared/errors';
import { ok, type Result } from '../../../shared/result';
import type { Clock } from '../../../shared/clock';
import type { SpotType } from '../../allocation/domain/types';

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
}

export class SpotUseCases {
  constructor(
    private readonly repo: SpotRepository,
    private readonly clock: Clock,
  ) {}

  async list(input: { activeOnly?: boolean; type?: SpotType }) {
    return ok(await this.repo.list(input));
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
}
