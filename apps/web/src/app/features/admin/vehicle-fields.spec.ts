import { describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form } from '@angular/forms/signals';
import {
  blankVehicle,
  isBlankVehicle,
  toVehicleDraft,
  vehicleRules,
  yearPattern,
  type VehicleForm,
} from './vehicle-fields';

describe('vehicle fields', () => {
  it('accepts model years from 1900 to the top year and nothing else', () => {
    const p = yearPattern(2027);
    for (const ok of ['1900', '1999', '2000', '2019', '2020', '2027']) expect(p.test(ok)).toBe(true);
    for (const bad of ['1899', '2028', '2030', '219', '20190', 'abcd', '']) {
      expect(p.test(bad)).toBe(false);
    }
  });

  it('handles a top year at the start of a decade', () => {
    const p = yearPattern(2030);
    expect(p.test('2029')).toBe(true);
    expect(p.test('2030')).toBe(true);
    expect(p.test('2031')).toBe(false);
  });

  it('leaves an empty year valid - the year is optional', () => {
    const model = signal<VehicleForm>({ ...blankVehicle(), plate: '1234-ABC' });
    const f = TestBed.runInInjectionContext(() => form(model, vehicleRules));
    expect(f.year().valid()).toBe(true);
    model.update((m) => ({ ...m, year: '1850' }));
    expect(f.year().valid()).toBe(false);
  });

  it('turns empty optional fields into null and the year into a number', () => {
    expect(toVehicleDraft({ plate: ' 1234-ABC ', make: '', model: 'X', year: '2019', colour: ' ' })).toEqual({
      plate: '1234-ABC',
      make: null,
      model: 'X',
      year: 2019,
      colour: null,
    });
  });

  it('knows a skipped vehicle step', () => {
    expect(isBlankVehicle(blankVehicle())).toBe(true);
    expect(isBlankVehicle({ ...blankVehicle(), make: 'Toyota' })).toBe(false);
  });
});
