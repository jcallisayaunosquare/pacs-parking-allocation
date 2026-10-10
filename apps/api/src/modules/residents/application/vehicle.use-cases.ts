import { fail } from '../../../shared/errors';
import { ok, type Result } from '../../../shared/result';
import type { Clock } from '../../../shared/clock';
import {
  normalizePlate,
  validateVehicle,
  validateVehiclePatch,
  type NormalizedVehicle,
  type Vehicle,
  type VehicleInput,
  type VehiclePatch,
} from '../domain/vehicle';
import type { ResidentRepository } from './resident.use-cases';

/**
 * The vehicle register's application ring: knows ports and the domain, nothing else.
 * No Kysely, no HTTP, no clock of its own - which is what makes the plate rules
 * testable without a database.
 */

export interface VehicleRepository {
  listByResident(residentId: string, includeInactive: boolean): Promise<readonly Vehicle[]>;
  findById(id: string): Promise<Vehicle | null>;
  /**
   * The gate lookup, and the uniqueness check behind every write. Takes an already
   * normalised plate: normalising twice is harmless, but accepting raw text here would
   * let a caller bypass the folding rule and get a false miss.
   */
  findActiveByPlate(plate: string): Promise<Vehicle | null>;
  create(residentId: string, input: NormalizedVehicle, at: Date): Promise<Vehicle>;
  update(id: string, input: NormalizedVehicle, at: Date): Promise<Vehicle | null>;
  /** Removal is a deactivation: the row stays, and the partial index frees the plate. */
  deactivate(id: string, at: Date): Promise<boolean>;
}

export class VehicleUseCases {
  constructor(
    private readonly vehicles: VehicleRepository,
    private readonly residents: ResidentRepository,
    private readonly clock: Clock,
  ) {}

  async list(residentId: string): Promise<Result<readonly Vehicle[]>> {
    if (!(await this.residents.findById(residentId))) {
      return fail('NOT_FOUND', 'Resident not found.');
    }
    return ok(await this.vehicles.listByResident(residentId, false));
  }

  /**
   * The gate's question: is this plate registered, and to whom.
   *
   * Normalised here rather than at the adapter, so every caller - the HTTP route, the
   * plates module, a future batch import - asks it the same way.
   */
  async findByPlate(rawPlate: string): Promise<Result<Vehicle>> {
    const plate = normalizePlate(rawPlate);
    if (plate.length === 0) {
      return fail('VALIDATION_FAILED', 'That is not a plate.', [
        { field: 'plate', issue: 'must contain letters or digits' },
      ]);
    }
    const found = await this.vehicles.findActiveByPlate(plate);
    return found ? ok(found) : fail('NOT_FOUND', 'No vehicle is registered with that plate.');
  }

  async add(residentId: string, input: VehicleInput): Promise<Result<Vehicle>> {
    const resident = await this.residents.findById(residentId);
    if (!resident || resident.deactivatedAt) {
      return fail('NOT_FOUND', 'Resident not found.');
    }

    const validated = validateVehicle(input, this.clock.now());
    if (!validated.ok) return validated;

    // Checked before the insert so the answer names who holds the plate, rather than
    // surfacing a unique-violation the administrator cannot act on. The partial index
    // is still the authority - this is the message, not the guarantee.
    const clash = await this.vehicles.findActiveByPlate(validated.value.plate);
    if (clash) {
      return fail(
        'VALIDATION_FAILED',
        clash.residentId === residentId
          ? 'This resident has already registered that plate.'
          : 'That plate is already registered to another resident.',
        [{ field: 'plate', issue: 'already registered' }],
      );
    }

    return ok(await this.vehicles.create(residentId, validated.value, this.clock.now()));
  }

  async update(residentId: string, vehicleId: string, patch: VehiclePatch): Promise<Result<Vehicle>> {
    const existing = await this.vehicles.findById(vehicleId);
    // Ownership is part of identity here, not an afterthought: a vehicle id that belongs
    // to another resident is answered as not found rather than as forbidden, so the
    // route cannot be used to discover which ids exist.
    if (!existing || existing.residentId !== residentId || !existing.isActive) {
      return fail('NOT_FOUND', 'Vehicle not found.');
    }

    const validated = validateVehiclePatch(existing, patch, this.clock.now());
    if (!validated.ok) return validated;

    if (validated.value.plate !== existing.plate) {
      const clash = await this.vehicles.findActiveByPlate(validated.value.plate);
      if (clash && clash.id !== existing.id) {
        return fail('VALIDATION_FAILED', 'That plate is already registered.', [
          { field: 'plate', issue: 'already registered' },
        ]);
      }
    }

    const updated = await this.vehicles.update(vehicleId, validated.value, this.clock.now());
    return updated ? ok(updated) : fail('NOT_FOUND', 'Vehicle not found.');
  }

  /**
   * Removal, in the product's sense of the word: the row is deactivated, not deleted.
   *
   * It stays because a recognition log entry from last month refers to a plate that was
   * registered then, and an administrator answering "whose car was that?" needs the row
   * to still exist. The plate itself is freed, because the uniqueness index is partial
   * on is_active - so the neighbour who buys the car can register it.
   */
  async remove(residentId: string, vehicleId: string): Promise<Result<{ removed: true }>> {
    const existing = await this.vehicles.findById(vehicleId);
    if (!existing || existing.residentId !== residentId || !existing.isActive) {
      return fail('NOT_FOUND', 'Vehicle not found.');
    }
    const done = await this.vehicles.deactivate(vehicleId, this.clock.now());
    return done ? ok({ removed: true } as const) : fail('NOT_FOUND', 'Vehicle not found.');
  }
}
