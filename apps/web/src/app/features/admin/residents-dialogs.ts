import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChildren,
} from '@angular/core';
import { FormsModule, NgModel } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTableModule } from '@angular/material/table';
import { ResidentsFacade, VehiclesFacade } from '../../application/admin.facades';
import { ConfirmService } from '../../shared/ui/confirm';
import { ViewStateHost } from '../../shared/ui/view-state';
import type { Resident, Vehicle, VehicleDraft } from '../../domain/models';

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
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
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

/**
 * The vehicle register for one resident: the cars they may bring into the building.
 *
 * It is a dialog on the register rather than a screen of its own, because that is where
 * the question is asked - an administrator looking at a row wants to know, and change,
 * what that person drives. The facade is provided here, so the state is this resident's
 * vehicles and nothing survives the dialog closing; a root-scoped facade would show the
 * previous resident's cars for a frame, which reads as the wrong person's car.
 *
 * The plate carries the screen, so it is set in the stencil treatment and in tabular
 * figures: plates are read character by character against something a camera produced,
 * and a column of them has to line up. The canonical form is printed beneath the typed
 * one whenever the two differ - that is the string the gate actually matches, and
 * "the camera says my plate is not registered" has no other answer.
 *
 * Photos are object keys, listed as text. There is no upload here and the dialog does
 * not pretend there is: an S3 presigned PUT per photo is the intended follow-up, and a
 * file picker that silently dropped the file would be worse than its absence.
 */
@Component({
  selector: 'app-vehicles-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [VehiclesFacade],
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatTableModule,
    ViewStateHost,
  ],
  template: `
    <h2 mat-dialog-title>Vehicles &mdash; {{ resident.fullName }}</h2>

    <mat-dialog-content>
      <p class="intro">
        The plates registered to unit {{ resident.unitNumber }}. The gate matches a plate
        it reads against this list, so a car that is not here is a car that is not let in.
      </p>

      <app-view-state
        [state]="facade.state()"
        [skeletonCount]="3"
        emptyTitle="No vehicles registered"
        emptyBody="Add the plate of each car this resident brings into the building."
        (retry)="facade.refresh()"
      >
        <table mat-table [dataSource]="facade.vehicles()" class="veh">
          <ng-container matColumnDef="plate">
            <th mat-header-cell *matHeaderCellDef scope="col">Plate</th>
            <td mat-cell *matCellDef="let v" data-label="Plate">
              <span class="plate stencil">{{ v.plateDisplay }}</span>
              @if (v.plate !== v.plateDisplay) {
                <span class="plate__canon">
                  matched as <span class="mono">{{ v.plate }}</span>
                </span>
              }
            </td>
          </ng-container>

          <ng-container matColumnDef="vehicle">
            <th mat-header-cell *matHeaderCellDef scope="col">Vehicle</th>
            <td mat-cell *matCellDef="let v" data-label="Vehicle">
              @if (describe(v)) {
                {{ describe(v) }}
              } @else {
                <span class="dim">{{ dash }}</span>
              }
            </td>
          </ng-container>

          <ng-container matColumnDef="colour">
            <th mat-header-cell *matHeaderCellDef scope="col">Colour</th>
            <td mat-cell *matCellDef="let v" data-label="Colour">
              {{ v.colour || dash }}
            </td>
          </ng-container>

          <ng-container matColumnDef="photos">
            <th mat-header-cell *matHeaderCellDef scope="col">Photos</th>
            <td mat-cell *matCellDef="let v" data-label="Photos">
              @if (v.photos.length) {
                {{ v.photos.length }}
              } @else {
                <span class="dim">{{ dash }}</span>
              }
            </td>
          </ng-container>

          <ng-container matColumnDef="actions">
            <th mat-header-cell *matHeaderCellDef scope="col">
              <span class="sr-only">Actions</span>
            </th>
            <td mat-cell *matCellDef="let v" class="acts">
              <button
                matButton
                type="button"
                [attr.aria-label]="'Edit ' + v.plateDisplay"
                (click)="startEdit(v)"
              >
                Edit
              </button>
              <button
                matButton
                type="button"
                class="danger"
                [attr.aria-label]="'Remove ' + v.plateDisplay"
                (click)="remove(v)"
              >
                Remove
              </button>
            </td>
          </ng-container>

          <tr mat-header-row *matHeaderRowDef="columns"></tr>
          <tr mat-row *matRowDef="let row; columns: columns"></tr>
        </table>
      </app-view-state>

      <!--
        One form, two jobs. A separate edit dialog on top of this one would stack two
        modals and lose the list behind them; editing in place keeps the register visible
        and the whole thing reachable with Tab.
      -->
      <section class="form" [attr.aria-label]="editing() ? 'Edit vehicle' : 'Add a vehicle'">
        <h3 class="form__h">
          @if (editing(); as v) {
            Edit {{ v.plateDisplay }}
          } @else {
            Add a vehicle
          }
        </h3>

        <div class="grid">
          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="grid__plate">
            <mat-label>Plate</mat-label>
            <input
              matInput
              class="stencil"
              [(ngModel)]="form.plate"
              name="plate"
              autocomplete="off"
              maxlength="20"
              required
              aria-describedby="veh-plate-hint"
            />
            <mat-hint id="veh-plate-hint">
              Type it as it is painted. Spaces and dashes are kept for the register and
              ignored when the gate matches it.
            </mat-hint>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Make</mat-label>
            <input matInput [(ngModel)]="form.make" name="make" autocomplete="off" maxlength="80" />
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Model</mat-label>
            <input matInput [(ngModel)]="form.model" name="model" autocomplete="off" maxlength="80" />
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Year</mat-label>
            <input
              matInput
              type="number"
              inputmode="numeric"
              [(ngModel)]="form.year"
              name="year"
              min="1900"
              [max]="maxYear"
            />
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Colour</mat-label>
            <input
              matInput
              [(ngModel)]="form.colour"
              name="colour"
              autocomplete="off"
              maxlength="40"
            />
          </mat-form-field>

          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="grid__wide">
            <mat-label>Photo keys</mat-label>
            <input
              matInput
              [(ngModel)]="form.photos"
              name="photos"
              autocomplete="off"
              aria-describedby="veh-photos-hint"
            />
            <mat-hint id="veh-photos-hint">
              One storage key or URL per entry, comma separated. Uploading a file from
              here is the next piece of work; this field only records where a photo is.
            </mat-hint>
          </mat-form-field>

          <mat-form-field appearance="outline" class="grid__wide">
            <mat-label>Notes</mat-label>
            <textarea matInput rows="2" [(ngModel)]="form.notes" name="notes"></textarea>
          </mat-form-field>
        </div>

        @if (facade.error(); as e) {
          <div class="msg msg--bad" role="alert">
            {{ e.message }}
            @if (e.details?.length) {
              <ul class="msg__list">
                @for (d of e.details; track d.field) {
                  <li>{{ d.field }}: {{ d.issue }}</li>
                }
              </ul>
            }
          </div>
        }

        <div class="form__row">
          <button
            matButton="filled"
            type="button"
            [disabled]="!valid() || facade.busy()"
            (click)="submit()"
          >
            @if (editing()) {
              Save changes
            } @else {
              Add vehicle
            }
          </button>
          @if (editing()) {
            <button matButton type="button" (click)="cancelEdit()">Cancel edit</button>
          }
        </div>
      </section>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close cdkFocusInitial>Done</button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .intro {
        color: var(--steel-soft);
        font-size: var(--t-small);
        margin-bottom: var(--sp-4);
      }

      table.veh {
        width: 100%;
        --mat-table-background-color: transparent;
        --mat-table-row-item-outline-color: var(--rule-soft);
        --mat-table-header-headline-color: var(--steel-soft);
        --mat-table-row-item-label-text-color: var(--steel);
        --mat-table-header-headline-size: var(--t-fine);
        --mat-table-row-item-label-text-size: var(--t-small);
      }

      th.mat-mdc-header-cell {
        border-bottom: 2px solid var(--steel);
        font-weight: 600;
        background: transparent;
      }

      /* A plate is read character by character, so the column has to line up. */
      .plate {
        font-size: 1.05rem;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.02em;
      }
      .plate__canon {
        display: block;
        font-size: var(--t-fine);
        color: var(--steel-faint);
        margin-top: var(--sp-1);
      }
      .mono {
        font-family: ui-monospace, 'Cascadia Mono', Menlo, monospace;
        font-variant-numeric: tabular-nums;
      }
      .dim {
        color: var(--steel-faint);
      }
      .acts {
        white-space: nowrap;
        text-align: right;
      }
      .danger {
        color: var(--revoked);
      }

      /* A rule, not a panel: the direction contract has no cards and no shadows. */
      .form {
        margin-top: var(--sp-5);
        padding-top: var(--sp-4);
        border-top: 1px solid var(--rule);
        display: flex;
        flex-direction: column;
        gap: var(--sp-3);
      }
      .form__h {
        font-size: var(--t-small);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--steel-soft);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: var(--sp-2) var(--sp-3);
      }
      .grid__plate,
      .grid__wide {
        grid-column: 1 / -1;
      }
      .form__row {
        display: flex;
        gap: var(--sp-2);
        align-items: center;
      }
      .msg__list {
        margin: var(--sp-2) 0 0;
        padding-left: var(--sp-4);
        font-size: var(--t-fine);
      }

      @media (max-width: 34rem) {
        .grid {
          grid-template-columns: minmax(0, 1fr);
        }
      }
    `,
  ],
})
export class VehiclesDialog {
  readonly facade = inject(VehiclesFacade);
  private readonly confirm = inject(ConfirmService);
  readonly resident = inject<Resident>(MAT_DIALOG_DATA);

  readonly columns = ['plate', 'vehicle', 'colour', 'photos', 'actions'];

  /** Kept as an escape so the source file stays ASCII whatever opens it. */
  readonly dash = '—';

  /** Next year's models are on sale this year; the server enforces the same bound. */
  readonly maxYear = new Date().getFullYear() + 1;

  private readonly _editing = signal<Vehicle | null>(null);
  readonly editing = this._editing.asReadonly();

  /** The entry fields, so their touched state can be cleared with their values. */
  private readonly fields = viewChildren(NgModel);

  form: VehicleForm = blankVehicleForm();

  constructor() {
    this.facade.for(this.resident.id);
    this.facade.dismissError();
  }

  /** "Toyota Corolla (2019)", from whichever of the three the register actually has. */
  describe(v: Vehicle): string {
    const name = [v.make, v.model].filter(Boolean).join(' ');
    if (name && v.year) return `${name} (${v.year})`;
    if (name) return name;
    return v.year ? String(v.year) : '';
  }

  valid(): boolean {
    // Only the plate is required, and only in the sense that it has to contain
    // something a plate is made of. The canonical rule lives on the server, which is
    // also where the uniqueness check is, so the client does not duplicate it.
    return /[0-9a-z]/i.test(this.form.plate);
  }

  startEdit(v: Vehicle): void {
    this._editing.set(v);
    this.facade.dismissError();
    this.form = {
      plate: v.plateDisplay,
      make: v.make ?? '',
      model: v.model ?? '',
      year: v.year,
      colour: v.colour ?? '',
      notes: v.notes ?? '',
      photos: v.photos.join(', '),
    };
  }

  cancelEdit(): void {
    this._editing.set(null);
    this.facade.dismissError();
    this.form = blankVehicleForm();
    /*
     * The controls are emptied, so the required plate is invalid again - and it is still
     * marked touched from the entry that just succeeded, which paints the field red the
     * moment a vehicle is added. An empty form that has not been filled in yet is not an
     * error, so the touched state goes back with the values.
     */
    queueMicrotask(() => {
      for (const model of this.fields()) model.control.markAsUntouched();
    });
  }

  async submit(): Promise<void> {
    const draft = this.draft();
    const editing = this._editing();
    const done = editing
      ? await this.facade.update(editing.id, draft)
      : await this.facade.add(draft);
    // The form only clears once the server has accepted it. A rejected plate has to stay
    // on screen with the typed value intact, or the administrator retypes it blind.
    if (done) this.cancelEdit();
  }

  async remove(v: Vehicle): Promise<void> {
    const ok = await this.confirm.ask({
      title: `Remove ${v.plateDisplay}?`,
      body:
        'The car comes off this resident’s register and the gate stops recognising ' +
        'it. The record is kept, so a reading from before today still resolves to this ' +
        'car, and the plate itself is free for whoever registers it next.',
      confirmLabel: 'Remove it',
      cancelLabel: 'Keep it',
      danger: true,
    });
    if (!ok) return;
    if (this._editing()?.id === v.id) this.cancelEdit();
    await this.facade.remove(v.id);
  }

  private draft(): VehicleDraft {
    const t = (s: string): string | null => (s.trim().length > 0 ? s.trim() : null);
    return {
      plate: this.form.plate.trim(),
      make: t(this.form.make),
      model: t(this.form.model),
      // An empty number input is '' rather than null, and 0 is not a model year.
      year: this.form.year ? Number(this.form.year) : null,
      colour: t(this.form.colour),
      notes: t(this.form.notes),
      photos: this.form.photos
        .split(/[\n,]/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0),
    };
  }
}

interface VehicleForm {
  plate: string;
  make: string;
  model: string;
  year: number | null;
  colour: string;
  notes: string;
  /** Typed as one field, split on commas and newlines. See the dialog's note on uploads. */
  photos: string;
}

const blankVehicleForm = (): VehicleForm => ({
  plate: '',
  make: '',
  model: '',
  year: null,
  colour: '',
  notes: '',
  photos: '',
});
