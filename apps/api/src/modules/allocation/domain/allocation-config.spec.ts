import { describe, expect, it } from 'vitest';
import {
  applyConfigPatch,
  biasQuanta,
  configWarnings,
  DEFAULT_ALLOCATION_CONFIG,
  validateConfig,
  type AllocationConfig,
} from './allocation-config';
import { addMonths, periodEnd, periodLabel } from './cycle';

const CFG: AllocationConfig = { ...DEFAULT_ALLOCATION_CONFIG, version: 4 };

describe('allocation config', () => {
  it('defaults to rule A: 3 months, 24 hours, 60 minutes', () => {
    expect(DEFAULT_ALLOCATION_CONFIG.allocationDurationMonths).toBe(3);
    expect(DEFAULT_ALLOCATION_CONFIG.earlyWaitingBiasHours).toBe(24);
    expect(DEFAULT_ALLOCATION_CONFIG.waitQuantumMinutes).toBe(60);
  });

  it('expresses the bias in whole quanta, whatever the quantum is', () => {
    expect(biasQuanta(CFG)).toBe(24);
    expect(biasQuanta({ ...CFG, waitQuantumMinutes: 30 })).toBe(48);
    expect(biasQuanta({ ...CFG, waitQuantumMinutes: 1440 })).toBe(1);
  });

  it('rejects values outside the bounds the DDL also enforces', () => {
    const fields = (c: Omit<AllocationConfig, 'version'>) => validateConfig(c).map((i) => i.field);
    expect(fields({ ...CFG, allocationDurationMonths: 0 })).toEqual(['allocationDurationMonths']);
    expect(fields({ ...CFG, allocationDurationMonths: 61 })).toEqual(['allocationDurationMonths']);
    expect(fields({ ...CFG, earlyWaitingBiasHours: -1 })).toEqual(['earlyWaitingBiasHours']);
    expect(fields({ ...CFG, earlyWaitingBiasHours: 9000 })).toEqual(['earlyWaitingBiasHours']);
    expect(fields({ ...CFG, waitQuantumMinutes: 0 })).toEqual(['waitQuantumMinutes']);
    expect(fields({ ...CFG, waitQuantumMinutes: 1.5 })).toEqual(['waitQuantumMinutes']);
    expect(fields({ ...CFG, absenceResetPeriods: 0 })).toEqual(['absenceResetPeriods']);
    expect(fields({ ...CFG, totalBays: -1 })).toEqual(['totalBays']);
    expect(validateConfig({ ...CFG, absenceResetPeriods: null })).toEqual([]);
    expect(validateConfig(CFG)).toEqual([]);
  });

  it('E-7: warns when the bias is wider than one allocation period', () => {
    expect(configWarnings(CFG)).toEqual([]);
    const warnings = configWarnings({ ...CFG, earlyWaitingBiasHours: 8000 });
    expect(warnings.join(' ')).toContain('freezes');
  });

  it('warns when the quantum would make the raffle decide nearly everything', () => {
    expect(configWarnings({ ...CFG, waitQuantumMinutes: 1440 }).join(' ')).toContain('raffle');
  });

  it('warns when the bias is smaller than one quantum and so rounds away', () => {
    expect(
      configWarnings({ ...CFG, earlyWaitingBiasHours: 1, waitQuantumMinutes: 120 }).join(' '),
    ).toContain('rounds away');
  });

  it('patches one field at a time and can clear the absence reset', () => {
    expect(applyConfigPatch(CFG, { earlyWaitingBiasHours: 0 })).toEqual({
      ...DEFAULT_ALLOCATION_CONFIG,
      earlyWaitingBiasHours: 0,
    });
    expect(applyConfigPatch(CFG, { absenceResetPeriods: null }).absenceResetPeriods).toBeNull();
    expect(applyConfigPatch(CFG, {}).absenceResetPeriods).toBe(CFG.absenceResetPeriods);
  });
});

describe('period arithmetic', () => {
  it('U-22: clamps to the end of the month instead of overflowing (E-10)', () => {
    expect(addMonths(new Date('2026-01-31T00:00:00Z'), 3).toISOString()).toBe(
      '2026-04-30T00:00:00.000Z',
    );
    expect(addMonths(new Date('2026-11-30T00:00:00Z'), 3).toISOString()).toBe(
      '2027-02-28T00:00:00.000Z',
    );
    expect(addMonths(new Date('2024-11-30T00:00:00Z'), 3).toISOString()).toBe(
      '2025-02-28T00:00:00.000Z',
    );
    // A leap day survives the round trip of a whole year.
    expect(addMonths(new Date('2024-02-29T00:00:00Z'), 12).toISOString()).toBe(
      '2025-02-28T00:00:00.000Z',
    );
  });

  it('ends a period one second before the next one begins', () => {
    expect(periodEnd(new Date('2026-04-01T00:00:00Z'), 3).toISOString()).toBe(
      '2026-06-30T23:59:59.000Z',
    );
  });

  it('labels a period by its duration, never by a quarter number', () => {
    expect(periodLabel(new Date('2026-02-14T00:00:00Z'), 3)).toBe('2026-02+3M');
    expect(periodLabel(new Date('2026-02-14T00:00:00Z'), 1)).toBe('2026-02+1M');
    // The label of a 5-month period is still honest, which "2026-Q1" would not be.
    expect(periodLabel(new Date('2026-11-01T00:00:00Z'), 5)).toBe('2026-11+5M');
  });
});
