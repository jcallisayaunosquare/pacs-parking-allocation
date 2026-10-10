import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { SpotsFacade } from '../../application/admin.facades';
import type { ParkingSpot, SpotType } from '../../domain/models';

/** One list, used by both dialogs, so the two cannot offer different types. */
const TYPE_OPTIONS: { label: string; value: SpotType }[] = [
  { label: 'Standard', value: 'STANDARD' },
  { label: 'Accessible', value: 'ACCESSIBLE' },
  { label: 'EV', value: 'EV' },
];

@Component({
  selector: 'app-add-bay-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  template: `
    <h2 mat-dialog-title>Add bay</h2>

    <mat-dialog-content class="form">
      <mat-form-field appearance="outline">
        <mat-label>Bay code</mat-label>
        <input matInput [(ngModel)]="form.spotCode" placeholder="B2-14" cdkFocusInitial />
        <mat-hint>Use the code painted on the floor — it is what residents read.</mat-hint>
      </mat-form-field>

      <mat-form-field appearance="outline">
        <mat-label>Level</mat-label>
        <input matInput [(ngModel)]="form.level" placeholder="B2" />
      </mat-form-field>

      <mat-form-field appearance="outline">
        <mat-label>Type</mat-label>
        <mat-select [(ngModel)]="form.type">
          @for (o of typeOptions; track o.value) {
            <mat-option [value]="o.value">{{ o.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <mat-form-field appearance="outline">
        <mat-label>Notes</mat-label>
        <input matInput [(ngModel)]="form.notes" placeholder="Optional" />
      </mat-form-field>

      @if (facade.error(); as e) {
        <div class="msg msg--bad" role="alert">{{ e.message }}</div>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button matButton="filled" [disabled]="!valid() || facade.busy()" (click)="submit()">
        Add bay
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
    `,
  ],
})
export class AddBayDialog {
  readonly facade = inject(SpotsFacade);
  private readonly ref = inject(MatDialogRef<AddBayDialog>);

  readonly typeOptions = TYPE_OPTIONS;

  form: { spotCode: string; level: string; type: SpotType; notes: string } = {
    spotCode: '',
    level: '',
    type: 'STANDARD',
    notes: '',
  };

  constructor() {
    this.facade.dismissError();
  }

  valid(): boolean {
    return this.form.spotCode.trim().length > 0 && this.form.level.trim().length > 0;
  }

  async submit(): Promise<void> {
    const created = await this.facade.create({
      spotCode: this.form.spotCode.trim().toUpperCase(),
      level: this.form.level.trim(),
      type: this.form.type,
      notes: this.form.notes.trim() || null,
    });
    if (created) this.ref.close(true);
  }
}

/**
 * Editing a bay.
 *
 * The code is shown but not editable. A bay code is painted on the floor and printed on
 * every past allocation record; letting it be retyped here would silently rename the
 * thing a resident reads on the wall, and break the join between the record and the
 * place. A miscoded bay is removed from service and added again under the right code.
 */
@Component({
  selector: 'app-edit-bay-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  template: `
    <h2 mat-dialog-title>Edit {{ bay.spotCode }}</h2>

    <mat-dialog-content class="form">
      <p class="fixed">
        <span class="fixed__l">Bay code</span>
        <span class="fixed__v stencil">{{ bay.spotCode }}</span>
        <span class="fixed__h">
          Painted on the floor and stamped on every past allocation, so it does not change
          here. Recode a bay by taking it out of service and adding it again.
        </span>
      </p>

      <mat-form-field appearance="outline">
        <mat-label>Level</mat-label>
        <input matInput [(ngModel)]="form.level" cdkFocusInitial />
      </mat-form-field>

      <mat-form-field appearance="outline">
        <mat-label>Type</mat-label>
        <mat-select [(ngModel)]="form.type">
          @for (o of typeOptions; track o.value) {
            <mat-option [value]="o.value">{{ o.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <mat-form-field appearance="outline">
        <mat-label>Notes</mat-label>
        <input matInput [(ngModel)]="form.notes" placeholder="Optional" />
      </mat-form-field>

      @if (facade.error(); as e) {
        <div class="msg msg--bad" role="alert">{{ e.message }}</div>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button matButton="filled" [disabled]="!dirty() || facade.busy()" (click)="submit()">
        {{ facade.busy() ? 'Saving...' : 'Save changes' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .form {
        display: flex;
        flex-direction: column;
        gap: var(--sp-2);
        min-width: 22rem;
      }
      .fixed {
        display: flex;
        flex-direction: column;
        gap: var(--sp-1);
        margin: var(--sp-2) 0 var(--sp-3);
      }
      .fixed__l {
        font-size: var(--t-fine);
        color: var(--steel-faint);
      }
      .fixed__v {
        font-size: var(--t-title);
      }
      .fixed__h {
        font-size: var(--t-fine);
        color: var(--steel-faint);
        max-width: 42ch;
      }
      @media (max-width: 30rem) {
        .form {
          min-width: 0;
        }
      }
    `,
  ],
})
export class EditBayDialog {
  readonly facade = inject(SpotsFacade);
  private readonly ref = inject(MatDialogRef<EditBayDialog>);
  readonly bay = inject<ParkingSpot>(MAT_DIALOG_DATA);

  readonly typeOptions = TYPE_OPTIONS;

  form: { level: string; type: SpotType; notes: string };

  constructor() {
    this.facade.dismissError();
    this.form = {
      level: this.bay.level,
      type: this.bay.type,
      notes: this.bay.notes ?? '',
    };
  }

  /** Saving an unchanged bay would insert a no-op audit entry, so the button waits. */
  dirty(): boolean {
    return (
      this.form.level.trim() !== this.bay.level ||
      this.form.type !== this.bay.type ||
      (this.form.notes.trim() || null) !== (this.bay.notes ?? null)
    );
  }

  async submit(): Promise<void> {
    const saved = await this.facade.update(this.bay.id, {
      level: this.form.level.trim(),
      type: this.form.type,
      notes: this.form.notes.trim() || null,
    });
    if (saved) this.ref.close(true);
  }
}
