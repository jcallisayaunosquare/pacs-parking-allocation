import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { ResidentsFacade } from '../../application/admin.facades';
import { AddResidentDialog } from './residents-dialogs';

/**
 * The add form is where validation earns its keep: a bad address there is an invitation
 * that never arrives. These go through the rendered dialog, not the schema alone, because
 * the defect being fixed was that nothing was ever SHOWN - a rule that holds but prints no
 * message is the bug again.
 */
describe('AddResidentDialog validation', () => {
  let fixture: ComponentFixture<AddResidentDialog>;
  const create = vi.fn(async () => ({ id: 'r1' }));
  const close = vi.fn();

  const type = (selector: string, value: string): void => {
    const input = fixture.nativeElement.querySelector(selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
  };

  const errors = (): string[] =>
    Array.from(fixture.nativeElement.querySelectorAll('mat-error') as NodeListOf<HTMLElement>)
      .map((e) => e.textContent?.trim() ?? '')
      .filter(Boolean);

  const press = async (): Promise<void> => {
    fixture.componentInstance.submit();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    create.mockClear();
    close.mockClear();
    TestBed.configureTestingModule({
      imports: [AddResidentDialog],
      providers: [
        {
          provide: ResidentsFacade,
          useValue: {
            busy: signal(false),
            error: signal(null),
            dismissError: () => undefined,
            create,
          },
        },
        { provide: MatDialogRef, useValue: { close } },
      ],
    });
    fixture = TestBed.createComponent(AddResidentDialog);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('shows every missing field on a press of Add, and sends nothing', async () => {
    await press();
    expect(errors()).toEqual([
      "Enter the resident's full name.",
      'Enter the unit, as it is written on the door.',
      'Enter the email the invitation should go to.',
    ]);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses an address that is not an email', async () => {
    type('input[type="email"]', 'ana at building');
    fixture.detectChanges();
    expect(errors()).toContain('Enter an address like name@example.com.');
  });

  it('refuses an address with no dotted domain, as the server would', async () => {
    type('input[type="email"]', 'ana@building');
    fixture.detectChanges();
    expect(errors()).toContain('Enter an address like name@example.com.');
  });

  it('refuses a name of only spaces', async () => {
    fixture.componentInstance.model.update((m) => ({ ...m, fullName: '   ' }));
    await press();
    expect(errors()).toContain("Enter the resident's full name.");
  });

  it('sends a valid form, trimmed, and closes', async () => {
    fixture.componentInstance.model.set({
      fullName: '  Ana Quispe ',
      unitNumber: '4B',
      email: 'ana@example.com',
      needsAccessibleSpot: false,
    });
    await press();
    expect(create).toHaveBeenCalledWith({
      fullName: 'Ana Quispe',
      unitNumber: '4B',
      email: 'ana@example.com',
      needsAccessibleSpot: false,
    });
    expect(close).toHaveBeenCalledWith(true);
    expect(errors()).toEqual([]);
  });
});
