import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import {
  FormField,
  form,
  maxLength,
  pattern,
  required,
  submit as submitForm,
} from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { SpotsFacade } from '../../application/admin.facades';
import type { ParkingSpot, SpotType } from '../../domain/models';
import { LoadingOverlay } from '../../shared/ui/loading-overlay';
import { LIMITS, NOT_BLANK, fieldError } from '../../shared/forms/limits';

/** One list, used by both dialogs, so the two cannot offer different types. */
const TYPE_OPTIONS: { label: string; value: SpotType }[] = [
  { label: 'Standard', value: 'STANDARD' },
  { label: 'Accessible', value: 'ACCESSIBLE' },
  { label: 'EV', value: 'EV' },
];

const LEVEL_MESSAGE = 'Enter the level, as it is signed in the car park.';

@Component({
  selector: 'app-add-bay-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormField,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    LoadingOverlay,
  ],
  template: `
    <h2 mat-dialog-title>Add bay</h2>

    <app-loading-overlay [active]="facade.busy()" [veil]="false" label="Adding the bay">
      <mat-dialog-content class="form">
        <mat-form-field appearance="outline">
          <mat-label>Bay code</mat-label>
          <input
            matInput
            [formField]="f.spotCode"
            placeholder="B2-14"
            autocomplete="off"
            spellcheck="false"
            cdkFocusInitial
          />
          <mat-hint>Use the code painted on the floor — it is what residents read.</mat-hint>
          <mat-error>{{ err(f.spotCode) }}</mat-error>
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Level</mat-label>
          <input matInput [formField]="f.level" placeholder="B2" autocomplete="off" />
          <mat-error>{{ err(f.level) }}</mat-error>
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Type</mat-label>
          <mat-select [formField]="f.type">
            @for (o of typeOptions; track o.value) {
              <mat-option [value]="o.value">{{ o.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Notes</mat-label>
          <input matInput [formField]="f.notes" placeholder="Optional" />
          <mat-error>{{ err(f.notes) }}</mat-error>
        </mat-form-field>

        @if (facade.error(); as e) {
          <div class="msg msg--bad" role="alert">{{ e.message }}</div>
        }
      </mat-dialog-content>
    </app-loading-overlay>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button
        matButton="filled"
        [disabled]="facade.busy()"
        [class.is-pending]="facade.busy()"
        (click)="submit()"
      >
        {{ facade.busy() ? 'Adding…' : 'Add bay' }}
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

  readonly model = signal<{ spotCode: string; level: string; type: SpotType; notes: string }>({
    spotCode: '',
    level: '',
    type: 'STANDARD',
    notes: '',
  });

  readonly f = form(this.model, (p) => {
    required(p.spotCode, { message: 'Enter the code painted on the floor.' });
    pattern(p.spotCode, NOT_BLANK, { message: 'Enter the code painted on the floor.' });
    maxLength(p.spotCode, LIMITS.spotCode, { message: `Up to ${LIMITS.spotCode} characters.` });

    required(p.level, { message: LEVEL_MESSAGE });
    pattern(p.level, NOT_BLANK, { message: LEVEL_MESSAGE });
    maxLength(p.level, LIMITS.level, { message: `Up to ${LIMITS.level} characters.` });

    maxLength(p.notes, LIMITS.notes, { message: `Up to ${LIMITS.notes} characters.` });
  });

  readonly err = fieldError;

  constructor() {
    this.facade.dismissError();
    // Nor does it outlive the dialog: left set, the page behind would print it next.
    inject(DestroyRef).onDestroy(() => this.facade.dismissError());
  }

  async submit(): Promise<void> {
    await submitForm(this.f, async () => {
      const v = this.model();
      const created = await this.facade.create({
        spotCode: v.spotCode.trim().toUpperCase(),
        level: v.level.trim(),
        type: v.type,
        notes: v.notes.trim() || null,
      });
      if (created) this.ref.close(true);
    });
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
    FormField,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    LoadingOverlay,
  ],
  template: `
    <h2 mat-dialog-title>Edit {{ bay.spotCode }}</h2>

    <app-loading-overlay [active]="facade.busy()" [veil]="false" label="Saving the bay">
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
          <input matInput [formField]="f.level" autocomplete="off" cdkFocusInitial />
          <mat-error>{{ err(f.level) }}</mat-error>
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Type</mat-label>
          <mat-select [formField]="f.type">
            @for (o of typeOptions; track o.value) {
              <mat-option [value]="o.value">{{ o.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Notes</mat-label>
          <input matInput [formField]="f.notes" placeholder="Optional" />
          <mat-error>{{ err(f.notes) }}</mat-error>
        </mat-form-field>

        @if (facade.error(); as e) {
          <div class="msg msg--bad" role="alert">{{ e.message }}</div>
        }
      </mat-dialog-content>
    </app-loading-overlay>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button
        matButton="filled"
        [disabled]="!dirty() || facade.busy()"
        [class.is-pending]="facade.busy()"
        (click)="submit()"
      >
        {{ facade.busy() ? 'Saving…' : 'Save changes' }}
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

  readonly model = signal<{ level: string; type: SpotType; notes: string }>({
    level: this.bay.level,
    type: this.bay.type,
    notes: this.bay.notes ?? '',
  });

  readonly f = form(this.model, (p) => {
    required(p.level, { message: LEVEL_MESSAGE });
    pattern(p.level, NOT_BLANK, { message: LEVEL_MESSAGE });
    maxLength(p.level, LIMITS.level, { message: `Up to ${LIMITS.level} characters.` });
    maxLength(p.notes, LIMITS.notes, { message: `Up to ${LIMITS.notes} characters.` });
  });

  readonly err = fieldError;

  constructor() {
    this.facade.dismissError();
    // Nor does it outlive the dialog: left set, the page behind would print it next.
    inject(DestroyRef).onDestroy(() => this.facade.dismissError());
  }

  /** Saving an unchanged bay would insert a no-op audit entry, so the button waits. */
  dirty(): boolean {
    const v = this.model();
    return (
      v.level.trim() !== this.bay.level ||
      v.type !== this.bay.type ||
      (v.notes.trim() || null) !== (this.bay.notes ?? null)
    );
  }

  async submit(): Promise<void> {
    await submitForm(this.f, async () => {
      const v = this.model();
      const saved = await this.facade.update(this.bay.id, {
        level: v.level.trim(),
        type: v.type,
        notes: v.notes.trim() || null,
      });
      if (saved) this.ref.close(true);
    });
  }
}
