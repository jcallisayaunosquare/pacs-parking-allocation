import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { ResidentsFacade } from '../../application/admin.facades';
import type { Resident } from '../../domain/models';

/**
 * The register's dialogs.
 *
 * Each one performs its own mutation and closes only once the server has accepted it,
 * which is why the facade is injected here rather than the dialog handing a value back
 * to the page. A rejected edit has to stay on screen with the typed values intact —
 * closing first and showing the error behind would throw the work away.
 */

@Component({
  selector: 'app-add-resident-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  template: `
    <h2 mat-dialog-title>Add resident</h2>

    <mat-dialog-content class="form">
      <mat-form-field appearance="outline">
        <mat-label>Full name</mat-label>
        <input matInput [(ngModel)]="form.fullName" autocomplete="off" cdkFocusInitial />
      </mat-form-field>

      <mat-form-field appearance="outline">
        <mat-label>Unit</mat-label>
        <input matInput [(ngModel)]="form.unitNumber" autocomplete="off" />
      </mat-form-field>

      <mat-form-field appearance="outline">
        <mat-label>Email</mat-label>
        <input matInput type="email" [(ngModel)]="form.email" autocomplete="off" />
        <mat-hint>The invitation goes to this address.</mat-hint>
      </mat-form-field>

      <mat-checkbox [(ngModel)]="form.needsAccessibleSpot">Needs an accessible bay</mat-checkbox>

      <p class="note">
        The resident gets an invitation by email. Their sign-in links itself to this
        record the first time they use it, which is when "Sign-in" turns to "Linked".
      </p>

      @if (facade.error(); as e) {
        <div class="msg msg--bad" role="alert">{{ e.message }}</div>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button matButton="filled" [disabled]="!valid() || facade.busy()" (click)="submit()">
        Add resident
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
      .note {
        font-size: var(--t-fine);
        color: var(--steel-faint);
      }
    `,
  ],
})
export class AddResidentDialog {
  readonly facade = inject(ResidentsFacade);
  private readonly ref = inject(MatDialogRef<AddResidentDialog>);

  form = { fullName: '', unitNumber: '', email: '', needsAccessibleSpot: false };

  constructor() {
    this.facade.dismissError();
  }

  valid(): boolean {
    return (
      this.form.fullName.trim().length > 0 &&
      this.form.unitNumber.trim().length > 0 &&
      /.+@.+\..+/.test(this.form.email)
    );
  }

  async submit(): Promise<void> {
    const created = await this.facade.create({
      email: this.form.email.trim(),
      fullName: this.form.fullName.trim(),
      unitNumber: this.form.unitNumber.trim(),
      needsAccessibleSpot: this.form.needsAccessibleSpot,
    });
    if (created) this.ref.close(true);
  }
}

@Component({
  selector: 'app-edit-resident-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  template: `
    <h2 mat-dialog-title>Edit — {{ resident.fullName }}</h2>

    <mat-dialog-content class="form">
      <mat-form-field appearance="outline">
        <mat-label>Full name</mat-label>
        <input matInput id="er-name" [(ngModel)]="form.fullName" autocomplete="off" cdkFocusInitial />
      </mat-form-field>

      <mat-form-field appearance="outline">
        <mat-label>Unit</mat-label>
        <input matInput id="er-unit" [(ngModel)]="form.unitNumber" autocomplete="off" />
      </mat-form-field>

      <mat-checkbox [(ngModel)]="form.needsAccessibleSpot">Needs an accessible bay</mat-checkbox>

      <div class="fixed">
        <span class="fixed__label">Email</span>
        <span class="fixed__value">{{ resident.email }}</span>
        <p class="note">
          The email cannot be changed here. It is what a resident's sign-in matches itself
          against, so editing it would detach the account from this record. Add the
          resident again under the new address instead.
        </p>
      </div>

      @if (facade.error(); as e) {
        <div class="msg msg--bad" role="alert">{{ e.message }}</div>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button matButton="filled" [disabled]="!changed() || facade.busy()" (click)="submit()">
        Save changes
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
      .fixed {
        display: flex;
        flex-direction: column;
        gap: var(--sp-1);
      }
      .fixed__label {
        font-size: var(--t-fine);
        font-weight: 600;
        color: var(--steel-soft);
      }
      .fixed__value {
        font-weight: 600;
        word-break: break-all;
      }
      .note {
        font-size: var(--t-fine);
        color: var(--steel-faint);
      }
    `,
  ],
})
export class EditResidentDialog {
  readonly facade = inject(ResidentsFacade);
  private readonly ref = inject(MatDialogRef<EditResidentDialog>);
  readonly resident = inject<Resident>(MAT_DIALOG_DATA);

  form = {
    fullName: this.resident.fullName,
    unitNumber: this.resident.unitNumber,
    needsAccessibleSpot: this.resident.needsAccessibleSpot,
  };

  constructor() {
    this.facade.dismissError();
  }

  /**
   * Only what actually changed is sent, and Save stays disabled until something does.
   * The server rejects an empty patch, and sending a field back unchanged would still
   * write an audit entry claiming it was edited.
   */
  private patch(): { fullName?: string; unitNumber?: string; needsAccessibleSpot?: boolean } {
    const r = this.resident;
    const name = this.form.fullName.trim();
    const unit = this.form.unitNumber.trim();
    return {
      ...(name && name !== r.fullName ? { fullName: name } : {}),
      ...(unit && unit !== r.unitNumber ? { unitNumber: unit } : {}),
      ...(this.form.needsAccessibleSpot !== r.needsAccessibleSpot
        ? { needsAccessibleSpot: this.form.needsAccessibleSpot }
        : {}),
    };
  }

  changed(): boolean {
    return Object.keys(this.patch()).length > 0;
  }

  async submit(): Promise<void> {
    const patch = this.patch();
    if (Object.keys(patch).length === 0) return;
    const done = await this.facade.update(this.resident.id, patch);
    if (done) this.ref.close(true);
  }
}

@Component({
  selector: 'app-eligibility-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  template: `
    <h2 mat-dialog-title>Eligibility — {{ resident.fullName }}</h2>

    <mat-dialog-content class="form">
      <mat-checkbox [(ngModel)]="eligible" cdkFocusInitial>May enter the draw</mat-checkbox>

      @if (!eligible) {
        <mat-form-field appearance="outline">
          <mat-label>Reason</mat-label>
          <textarea
            matInput
            rows="3"
            [(ngModel)]="reason"
            placeholder="For example: unpaid dues"
          ></textarea>
          <mat-hint>
            Recorded in the audit log and shown to the resident, so write it as you would
            say it to them.
          </mat-hint>
        </mat-form-field>
      }

      @if (facade.error(); as e) {
        <div class="msg msg--bad" role="alert">{{ e.message }}</div>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button
        matButton="filled"
        [disabled]="(!eligible && !reason.trim()) || facade.busy()"
        (click)="submit()"
      >
        Save
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .form {
        display: flex;
        flex-direction: column;
        gap: var(--sp-4);
        padding-top: var(--sp-2);
      }
    `,
  ],
})
export class EligibilityDialog {
  readonly facade = inject(ResidentsFacade);
  private readonly ref = inject(MatDialogRef<EligibilityDialog>);
  readonly resident = inject<Resident>(MAT_DIALOG_DATA);

  eligible = this.resident.isEligible;
  reason = this.resident.ineligibleReason ?? '';

  constructor() {
    this.facade.dismissError();
  }

  async submit(): Promise<void> {
    const done = await this.facade.setEligibility(
      this.resident.id,
      this.eligible,
      this.eligible ? null : this.reason.trim(),
    );
    if (done) this.ref.close(true);
  }
}
