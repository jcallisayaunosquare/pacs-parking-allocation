import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AllocationConfigFacade } from './allocation-config.facade';
import { AllocationConfigRepository } from '../domain/repositories';

/**
 * The rules form validates against the contract's ranges before sending. These pin the
 * two halves of that: an out-of-range value is named under its field, and Save does not
 * reach the server while one is.
 */
describe('AllocationConfigFacade client validation', () => {
  const saved = {
    version: 4,
    allocationDurationMonths: 3,
    earlyWaitingBiasHours: 24,
    waitQuantumMinutes: 60,
    absenceResetPeriods: null,
    totalBays: 0,
  };

  const setup = () => {
    const patch = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AllocationConfigRepository,
          useValue: { current: async () => ({ config: saved, warnings: [] }), patch },
        },
      ],
    });
    return { facade: TestBed.inject(AllocationConfigFacade), patch };
  };

  it('shows nothing for a form nobody has touched', () => {
    const { facade } = setup();
    expect(facade.issues().size).toBe(0);
  });

  it('names each out-of-range value under its own field', () => {
    const { facade } = setup();
    facade.edit('allocationDurationMonths', 0);
    facade.edit('earlyWaitingBiasHours', 9000);
    facade.edit('waitQuantumMinutes', 1.5);
    expect(facade.issues().get('allocationDurationMonths')).toBe(
      'A whole number of months, from 1 to 60.',
    );
    expect(facade.issues().get('earlyWaitingBiasHours')).toContain('from 0 to 8760');
    expect(facade.issues().get('waitQuantumMinutes')).toBe('A whole number of minutes, 1 or more.');
  });

  it('accepts the edges of each range', () => {
    const { facade } = setup();
    facade.edit('allocationDurationMonths', 60);
    facade.edit('earlyWaitingBiasHours', 0);
    facade.edit('totalBays', 0);
    expect(facade.clientIssues().size).toBe(0);
  });

  it('does not send a patch while a value is out of range', async () => {
    const { facade, patch } = setup();
    await TestBed.inject(AllocationConfigFacade).refresh();
    await new Promise((r) => setTimeout(r));
    TestBed.tick();
    facade.edit('allocationDurationMonths', 61);
    expect(await facade.save()).toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });
});
