import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { SpotsFacade } from '../../application/admin.facades';
import type { SpotType } from '../../domain/models';

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

  readonly typeOptions: { label: string; value: SpotType }[] = [
    { label: 'Standard', value: 'STANDARD' },
    { label: 'Accessible', value: 'ACCESSIBLE' },
    { label: 'EV', value: 'EV' },
  ];

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
