import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { ResidentsFacade } from '../../application/admin.facades';
import type { ApiError, Resident, Vehicle } from '../../domain/models';
import { AddResidentDialog, VehicleFormDialog } from './residents-dialogs';

/** A ResidentsFacade double: the calls the dialogs make, recorded. */
const facadeDouble = () => {
  const error = signal<ApiError | null>(null);
  return {
    error,
    busy: signal(false),
    dismissError: () => error.set(null),
    create: vi.fn(async () => ({ id: 'r1' }) as Resident),
    addVehicle: vi.fn(async () => ({ id: 'v1' }) as Vehicle),
    updateVehicle: vi.fn(async () => ({ id: 'v1' }) as Vehicle),
  };
};

const errorsIn = (fixture: ComponentFixture<unknown>): string[] =>
  Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('mat-error'))
    .map((e) => e.textContent?.trim() ?? '')
    .filter(Boolean);

/**
 * The add form is where validation earns its keep: a bad address there is an invitation
 * that never arrives. These go through the rendered dialog, not the schema alone, because
 * the defect being fixed was that nothing was ever SHOWN - a rule that holds but prints no
 * message is the bug again.
 */
describe('AddResidentDialog', () => {
  let fixture: ComponentFixture<AddResidentDialog>;
  let facade: ReturnType<typeof facadeDouble>;
  const close = vi.fn();

  const type = (selector: string, value: string): void => {
    const input = fixture.nativeElement.querySelector(selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
  };

  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    fixture.detectChanges();
  };

  const fillResident = (): void => {
    fixture.componentInstance.model.set({
      fullName: '  Ana Quispe ',
      unitNumber: '4B',
      email: 'ana@example.com',
      needsAccessibleSpot: false,
    });
  };

  beforeEach(async () => {
    facade = facadeDouble();
    close.mockClear();
    TestBed.configureTestingModule({
      imports: [AddResidentDialog],
      providers: [
        { provide: ResidentsFacade, useValue: facade },
        { provide: MatDialogRef, useValue: { close } },
      ],
    });
    fixture = TestBed.createComponent(AddResidentDialog);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('names both sections, each with its glyph', () => {
    const headings = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.sec__h'),
    ).map((h) => h.textContent?.replace(/\s+/g, ' ').trim());
    expect(headings).toEqual(['person Resident', 'directions_car Vehicle Optional']);
  });

  it('shows every missing resident field on a press of Add, and sends nothing', async () => {
    await fixture.componentInstance.submit();
    await settle();
    expect(errorsIn(fixture)).toEqual([
      "Enter the resident's full name.",
      'Enter the unit, as it is written on the door.',
      'Enter the email the invitation should go to.',
    ]);
    expect(facade.create).not.toHaveBeenCalled();
  });

  it('refuses an address with no dotted domain, as the server would', async () => {
    type('input[type="email"]', 'ana@building');
    fixture.detectChanges();
    expect(errorsIn(fixture)).toContain('Enter an address like name@example.com.');
  });

  it('refuses a name of only spaces', async () => {
    fixture.componentInstance.model.update((m) => ({ ...m, fullName: '   ' }));
    await fixture.componentInstance.submit();
    await settle();
    expect(errorsIn(fixture)).toContain("Enter the resident's full name.");
  });

  it('adds the resident alone, trimmed, when the vehicle section is left empty', async () => {
    fillResident();
    await fixture.componentInstance.submit();
    expect(facade.create).toHaveBeenCalledWith({
      fullName: 'Ana Quispe',
      unitNumber: '4B',
      email: 'ana@example.com',
      needsAccessibleSpot: false,
    });
    expect(facade.addVehicle).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(true);
  });

  it('adds the resident, then their car against the new id', async () => {
    fillResident();
    fixture.componentInstance.vehicle.set({
      plate: '1234-ABC',
      make: 'Toyota',
      model: '',
      year: '2019',
      colour: '',
    });
    await fixture.componentInstance.submit();
    expect(facade.create).toHaveBeenCalledTimes(1);
    expect(facade.addVehicle).toHaveBeenCalledWith('r1', {
      plate: '1234-ABC',
      make: 'Toyota',
      model: null,
      year: 2019,
      colour: null,
      notes: null,
      photos: [],
    });
    expect(close).toHaveBeenCalledWith(true);
  });

  it('catches a half-filled car before creating anyone', async () => {
    fillResident();
    fixture.componentInstance.vehicle.update((v) => ({ ...v, make: 'Toyota' }));
    await fixture.componentInstance.submit();
    await settle();
    expect(errorsIn(fixture)).toContain('Enter the plate, as it is painted.');
    expect(facade.create).not.toHaveBeenCalled();
  });

  it('keeps the resident when the car is refused, and retries only the car', async () => {
    facade.addVehicle.mockResolvedValueOnce(null as unknown as Vehicle);
    fillResident();
    fixture.componentInstance.vehicle.set({
      plate: '1234-ABC',
      make: '',
      model: '',
      year: '',
      colour: '',
    });
    await fixture.componentInstance.submit();
    expect(fixture.componentInstance.createdId()).toBe('r1');
    expect(close).not.toHaveBeenCalled();

    await fixture.componentInstance.saveVehicle();
    expect(facade.create).toHaveBeenCalledTimes(1);
    expect(facade.addVehicle).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledWith(true);
  });
});

describe('VehicleFormDialog', () => {
  const resident = { id: 'r1', fullName: 'Ana', unitNumber: '4B' } as Resident;
  const car = {
    id: 'v1',
    residentId: 'r1',
    plate: '1234ABC',
    plateDisplay: '1234-ABC',
    make: 'Toyota',
    model: 'Corolla',
    year: 2019,
    colour: 'Grey',
    notes: 'Roof box',
    photos: ['s3://a.jpg'],
  } as unknown as Vehicle;

  const open = (vehicle: Vehicle | null) => {
    const facade = facadeDouble();
    const close = vi.fn();
    TestBed.configureTestingModule({
      imports: [VehicleFormDialog],
      providers: [
        { provide: ResidentsFacade, useValue: facade },
        { provide: MatDialogRef, useValue: { close } },
        { provide: MAT_DIALOG_DATA, useValue: { resident, vehicle } },
      ],
    });
    const fixture = TestBed.createComponent(VehicleFormDialog);
    fixture.detectChanges();
    return { fixture, facade, close };
  };

  it('adds a car typed into the real inputs and sent with the real button', async () => {
    const { fixture, facade, close } = open(null);
    const el = fixture.nativeElement as HTMLElement;
    const plate = el.querySelector('input.stencil') as HTMLInputElement;
    plate.value = '9999-XYZ';
    plate.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const button = Array.from(el.querySelectorAll('button')).find((b) =>
      /Add vehicle/.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    button.click();
    await fixture.whenStable();
    expect(facade.addVehicle).toHaveBeenCalledWith('r1', expect.objectContaining({ plate: '9999-XYZ' }));
    expect(close).toHaveBeenCalledWith(true);
  });

  it('starts from the car on record when editing', () => {
    const { fixture } = open(car);
    expect(fixture.componentInstance.vehicle()).toEqual({
      plate: '1234-ABC',
      make: 'Toyota',
      model: 'Corolla',
      year: '2019',
      colour: 'Grey',
    });
  });

  it('sends only what changed, and never the notes or photos it does not edit', async () => {
    const { fixture, facade } = open(car);
    fixture.componentInstance.vehicle.update((v) => ({ ...v, colour: 'Blue' }));
    await fixture.componentInstance.submit();
    expect(facade.updateVehicle).toHaveBeenCalledWith('r1', 'v1', { colour: 'Blue' });
  });

  it('has nothing to save until something changes', () => {
    const { fixture } = open(car);
    expect(fixture.componentInstance.dirty()).toBe(false);
  });
});
