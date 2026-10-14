import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { VehiclesFacade } from './admin.facades';
import { VehicleRepository } from '../domain/repositories';
import type { Vehicle } from '../domain/models';

/** The facade half of "I added a car and the vehicle list shows nothing". */
describe('VehiclesFacade', () => {
  const car = { id: 'v1', residentId: 'r1', plate: '1234ABC', plateDisplay: '1234-ABC' } as Vehicle;

  const settle = async () => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      TestBed.tick();
    }
  };

  const setup = (stored: Vehicle[]) => {
    const list = vi.fn(async (residentId: string) => stored.filter((v) => v.residentId === residentId));
    const add = vi.fn(async (residentId: string) => {
      const v = { ...car, id: `v${stored.length + 1}`, residentId };
      stored.push(v);
      return v;
    });
    TestBed.configureTestingModule({
      providers: [
        VehiclesFacade,
        { provide: VehicleRepository, useValue: { list, add, update: vi.fn(), remove: vi.fn() } },
      ],
    });
    return { facade: TestBed.inject(VehiclesFacade), list, add };
  };

  it('loads the vehicles of the resident it is pointed at', async () => {
    const { facade, list } = setup([car]);
    facade.for('r1');
    await settle();
    expect(list).toHaveBeenCalledWith('r1');
    expect(facade.vehicles().map((v) => v.plateDisplay)).toEqual(['1234-ABC']);
  });

  it('shows a car the moment it has been added', async () => {
    const { facade } = setup([]);
    facade.for('r1');
    await settle();
    expect(facade.vehicles()).toHaveLength(0);
    await facade.add({ plate: '9999-XYZ' } as never);
    await settle();
    expect(facade.vehicles()).toHaveLength(1);
  });
});
