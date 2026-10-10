import { describe, expect, it } from 'vitest';
import {
  COLOUR_MAX_LENGTH,
  displayPlate,
  maxYear,
  normalizePlate,
  platesMatch,
  PHOTOS_MAX,
  validateVehicle,
  validateVehiclePatch,
  YEAR_MIN,
  type Vehicle,
} from './vehicle';

const NOW = new Date('2026-10-09T12:00:00Z');

const issues = (r: ReturnType<typeof validateVehicle>) =>
  r.ok ? [] : (r.error.details ?? []).map((d) => d.field);

describe('normalizePlate', () => {
  it('strips the separators a person might type', () => {
    expect(normalizePlate('abc 123')).toBe('ABC123');
    expect(normalizePlate('ABC-123')).toBe('ABC123');
    expect(normalizePlate('A.B.C.123')).toBe('ABC123');
    expect(normalizePlate('  abc\t123\n')).toBe('ABC123');
  });

  it('folds the three confusable glyphs onto their digit', () => {
    // O, Q and I are indistinguishable from 0 and 1 in every plate face in use, so a
    // plate written either way has to be the same plate.
    expect(normalizePlate('OQI')).toBe('001');
    expect(normalizePlate('ABO12')).toBe('AB012');
    expect(normalizePlate('AB012')).toBe('AB012');
    expect(normalizePlate('IO-OI')).toBe('1001');
  });

  it('leaves the pairs it deliberately does not fold alone', () => {
    // S/5, B/8, Z/2, G/6 and D/0 are OCR confusions, but folding them makes two real
    // plates collide and refuses a registration with no way through.
    expect(normalizePlate('SBZGD')).toBe('SBZGD');
    expect(normalizePlate('58260')).toBe('58260');
    expect(normalizePlate('BS12')).not.toBe(normalizePlate('8512'));
  });

  it('strips diacritics instead of inventing a different plate', () => {
    expect(normalizePlate('ÑAB12')).toBe('NAB12');
    expect(normalizePlate('ÁBC12')).toBe('ABC12');
  });

  it('is idempotent, because the stored column is already folded', () => {
    for (const raw of ['abc-123', 'OQI 000', 'ñb.1', 'ABC123']) {
      expect(normalizePlate(normalizePlate(raw))).toBe(normalizePlate(raw));
    }
  });

  it('returns empty for input with no alphanumeric content', () => {
    expect(normalizePlate('---')).toBe('');
    expect(normalizePlate('')).toBe('');
  });
});

describe('displayPlate', () => {
  it('keeps the resident’s own punctuation, uppercased', () => {
    expect(displayPlate('abc-123')).toBe('ABC-123');
    expect(displayPlate(' abc  123 ')).toBe('ABC 123');
  });

  it('does not fold, so a resident can still find their own plate in the list', () => {
    expect(displayPlate('ABO-12')).toBe('ABO-12');
    expect(normalizePlate('ABO-12')).toBe('AB012');
  });

  it('drops anything a plate is not written with', () => {
    expect(displayPlate('https://x/ABC123')).toBe('HTTPSXABC123');
  });
});

describe('platesMatch', () => {
  it('matches across separators, case and the folded glyphs', () => {
    expect(platesMatch('abc 123', 'ABC-123')).toBe(true);
    expect(platesMatch('ABO12', 'AB012')).toBe(true);
    expect(platesMatch('ABC123', 'ABC124')).toBe(false);
  });

  it('never matches two plates that are both empty after normalisation', () => {
    expect(platesMatch('--', '..')).toBe(false);
  });
});

describe('validateVehicle', () => {
  it('normalises a plate and keeps the typed form beside it', () => {
    const r = validateVehicle({ plate: 'abo-12', colour: 'Dark blue', year: 2021 }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.plate).toBe('AB012');
    expect(r.value.plateDisplay).toBe('ABO-12');
    expect(r.value.colour).toBe('Dark blue');
    expect(r.value.year).toBe(2021);
  });

  it('reports a plate with nothing in it as a field error', () => {
    expect(issues(validateVehicle({ plate: ' -- ' }, NOW))).toEqual(['plate']);
    expect(issues(validateVehicle({ plate: 'A' }, NOW))).toEqual(['plate']);
  });

  it('accepts next year as a model year and refuses the one after', () => {
    expect(maxYear(NOW)).toBe(2027);
    expect(validateVehicle({ plate: 'ABC12', year: 2027 }, NOW).ok).toBe(true);
    expect(issues(validateVehicle({ plate: 'ABC12', year: 2028 }, NOW))).toEqual(['year']);
    expect(issues(validateVehicle({ plate: 'ABC12', year: YEAR_MIN - 1 }, NOW))).toEqual(['year']);
    expect(issues(validateVehicle({ plate: 'ABC12', year: 2020.5 }, NOW))).toEqual(['year']);
  });

  it('wants a colour name rather than whatever was pasted into the field', () => {
    expect(validateVehicle({ plate: 'ABC12', colour: 'Off-white' }, NOW).ok).toBe(true);
    expect(validateVehicle({ plate: 'ABC12', colour: 'Black/grey' }, NOW).ok).toBe(true);
    expect(issues(validateVehicle({ plate: 'ABC12', colour: '#1188ff' }, NOW))).toEqual(['colour']);
    expect(
      issues(validateVehicle({ plate: 'ABC12', colour: 'x'.repeat(COLOUR_MAX_LENGTH + 1) }, NOW)),
    ).toEqual(['colour']);
  });

  it('treats an empty optional string as absent rather than as an empty value', () => {
    const r = validateVehicle({ plate: 'ABC12', make: '  ', model: '', colour: null }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.make).toBeNull();
    expect(r.value.model).toBeNull();
    expect(r.value.colour).toBeNull();
  });

  it('bounds the photo list and drops blank keys', () => {
    const r = validateVehicle({ plate: 'ABC12', photos: ['a/1.jpg', '  ', ' b/2.jpg'] }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.photos).toEqual(['a/1.jpg', 'b/2.jpg']);

    const tooMany = validateVehicle(
      { plate: 'ABC12', photos: Array.from({ length: PHOTOS_MAX + 1 }, (_, i) => `k${i}`) },
      NOW,
    );
    expect(issues(tooMany)).toEqual(['photos']);
  });

  it('reports every offending field at once, not the first one', () => {
    expect(issues(validateVehicle({ plate: '!', year: 1800, colour: '42' }, NOW)).sort()).toEqual([
      'colour',
      'plate',
      'year',
    ]);
  });
});

describe('validateVehiclePatch', () => {
  const current: Vehicle = {
    id: 'v1',
    residentId: 'r1',
    plate: 'AB012',
    plateDisplay: 'ABO-12',
    make: 'Toyota',
    model: 'Corolla',
    year: 2019,
    colour: 'Silver',
    notes: null,
    photos: ['k/1.jpg'],
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('keeps what the patch leaves out', () => {
    const r = validateVehiclePatch(current, { colour: 'Black' }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.colour).toBe('Black');
    expect(r.value.make).toBe('Toyota');
    expect(r.value.year).toBe(2019);
    expect(r.value.photos).toEqual(['k/1.jpg']);
    // The display form round-trips, so an untouched plate is not quietly re-folded.
    expect(r.value.plateDisplay).toBe('ABO-12');
    expect(r.value.plate).toBe('AB012');
  });

  it('lets a patch clear an optional field', () => {
    const r = validateVehiclePatch(current, { model: null, notes: null }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.model).toBeNull();
  });

  it('validates the patched plate, not the stored one', () => {
    expect(issues(validateVehiclePatch(current, { plate: '--' }, NOW))).toEqual(['plate']);
    const r = validateVehiclePatch(current, { plate: 'xyz 99' }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.plate).toBe('XYZ99');
  });
});
