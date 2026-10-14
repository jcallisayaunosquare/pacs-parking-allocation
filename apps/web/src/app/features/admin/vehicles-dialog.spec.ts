import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { VehiclesFacade } from '../../application/admin.facades';
import { ConfirmService } from '../../shared/ui/confirm';
import type { Vehicle } from '../../domain/models';
import { VehiclesDialog } from './residents-dialogs';

/** Reproduces "I added a car and the vehicle list shows nothing". */
describe('VehiclesDialog', () => {
  let fixture: ComponentFixture<VehiclesDialog>;
  const vehicles = signal<readonly Vehicle[]>([]);
  const add = vi.fn(async () => ({ id: 'v1' }));
  const forResident = vi.fn();

  const car: Vehicle = {
    id: 'v1',
    residentId: 'r1',
    plate: '1234ABC',
    plateDisplay: '1234-ABC',
    make: 'Toyota',
    model: 'Corolla',
    year: 2019,
    colour: 'Grey',
    notes: null,
    photos: [],
    isActive: true,
  } as unknown as Vehicle;

  beforeEach(async () => {
    vehicles.set([]);
    add.mockClear();
    forResident.mockClear();
    TestBed.overrideComponent(VehiclesDialog, {
      set: {
        providers: [
          {
            provide: VehiclesFacade,
            useValue: {
              vehicles,
              state: signal({ kind: 'ready', stale: false }),
              busy: signal(false),
              error: signal(null),
              for: forResident,
              dismissError: () => undefined,
              refresh: () => undefined,
              add,
              update: vi.fn(),
              remove: vi.fn(),
            },
          },
        ],
      },
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: { id: 'r1', fullName: 'Ana', unitNumber: '4B' } },
        { provide: MatDialogRef, useValue: { close: vi.fn() } },
        { provide: ConfirmService, useValue: { ask: async () => true } },
      ],
    });
    fixture = TestBed.createComponent(VehiclesDialog);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('asks the facade for this resident', () => {
    expect(forResident).toHaveBeenCalledWith('r1');
  });

  it('draws the vehicles the facade holds', async () => {
    vehicles.set([car]);
    fixture.detectChanges();
    await fixture.whenStable();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('1234-ABC');
  });

  it('sends a plate typed with nothing else', async () => {
    fixture.componentInstance.model.update((m) => ({ ...m, plate: '1234-ABC' }));
    await fixture.componentInstance.submit();
    expect(add).toHaveBeenCalledTimes(1);
  });
});
