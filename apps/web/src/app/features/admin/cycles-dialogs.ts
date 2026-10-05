import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { CyclesFacade } from '../../application/admin.facades';

/**
 * The dates are native `type="date"` inputs inside Material fields rather than
 * `MatDatepicker`.
 *
 * The contract is a `yyyy-MM-dd` string and a native date input speaks exactly that,
 * while the datepicker hands back a `Date` that has to be converted at both ends. That
 * conversion is where a quarter beginning on 1 January was once displayed as 31
 * December, so the string stays a string the whole way through.
 */
@Component({
  selector: 'app-new-cycle-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatButtonModule, MatDialogModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>New cycle</h2>

    <mat-dialog-content class="form">
      <div class="dates">
        <mat-form-field appearance="outline">
          <mat-label>Quarter begins</mat-label>
          <input matInput type="date" [(ngModel)]="form.startsOn" cdkFocusInitial />
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Quarter ends</mat-label>
          <input matInput type="date" [(ngModel)]="form.endsOn" />
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Registration opens</mat-label>
          <input matInput type="date" [(ngModel)]="form.opensAt" />
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Registration closes</mat-label>
          <input matInput type="date" [(ngModel)]="form.closesAt" />
        </mat-form-field>
      </div>

      <p class="note">
        The label, such as 2026-Q2, comes from the start date, so two administrators
        cannot spell it differently.
      </p>

      @if (facade.error(); as e) {
        <div class="msg msg--bad" role="alert">{{ e.message }}</div>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button matButton="filled" [disabled]="!valid() || facade.busy()" (click)="submit()">
        Create cycle
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .form {
        display: flex;
        flex-direction: column;
        gap: var(--sp-2);
      }
      .dates {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--sp-2);
        padding-top: var(--sp-2);
      }
      .note {
        font-size: var(--t-fine);
        color: var(--steel-faint);
      }
      @media (max-width: 30rem) {
        .dates {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class NewCycleDialog {
  readonly facade = inject(CyclesFacade);
  private readonly ref = inject(MatDialogRef<NewCycleDialog>);

  form = { startsOn: '', endsOn: '', opensAt: '', closesAt: '' };

  constructor() {
    this.facade.dismissError();
  }

  valid(): boolean {
    const f = this.form;
    return Boolean(f.startsOn && f.endsOn && f.opensAt && f.closesAt);
  }

  async submit(): Promise<void> {
    if (!this.valid()) return;
    const f = this.form;
    const created = await this.facade.create({
      startsOn: f.startsOn,
      endsOn: f.endsOn,
      // The window is a timestamp in the contract; midnight UTC on the chosen day.
      registrationOpensAt: new Date(`${f.opensAt}T00:00:00Z`).toISOString(),
      registrationClosesAt: new Date(`${f.closesAt}T23:59:59Z`).toISOString(),
    });
    if (created) this.ref.close(true);
  }
}
