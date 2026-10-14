import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import {
  FormField,
  applyWhen,
  email,
  form,
  max,
  maxLength,
  min,
  pattern,
  required,
  submit as submitForm,
  validate,
} from '@angular/forms/signals';
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
import { MatMenuModule } from '@angular/material/menu';
import { MatTableModule } from '@angular/material/table';
import { ResidentsFacade, VehiclesFacade } from '../../application/admin.facades';
import { ConfirmService } from '../../shared/ui/confirm';
import { ViewStateHost } from '../../shared/ui/view-state';
import type { Resident, Vehicle, VehicleDraft } from '../../domain/models';
import { LoadingOverlay } from '../../shared/ui/loading-overlay';
import {
  DOTTED_DOMAIN,
  LIMITS,
  NOT_BLANK,
  PLATE_CHARACTER,
  fieldError,
} from '../../shared/forms/limits';

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
    FormField,
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    LoadingOverlay,
  ],
  template: `
    <h2 mat-dialog-title>Add resident</h2>

    <app-loading-overlay [active]="facade.busy()" [veil]="false" label="Adding the resident">
      <mat-dialog-content class="form">
        <mat-form-field appearance="outline">
          <mat-label>Full name</mat-label>
          <input matInput [formField]="f.fullName" autocomplete="off" cdkFocusInitial />
          <mat-error>{{ err(f.fullName) }}</mat-error>
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Unit</mat-label>
          <input matInput [formField]="f.unitNumber" autocomplete="off" />
          <mat-error>{{ err(f.unitNumber) }}</mat-error>
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Email</mat-label>
          <input
            matInput
            type="email"
            inputmode="email"
            [formField]="f.email"
            autocomplete="off"
            spellcheck="false"
          />
          <mat-hint>The invitation goes to this address.</mat-hint>
          <mat-error>{{ err(f.email) }}</mat-error>
        </mat-form-field>

        <mat-checkbox [formField]="f.needsAccessibleSpot">Needs an accessible bay</mat-checkbox>

        <p class="note">
          The resident gets an invitation by email. Their sign-in links itself to this
          record the first time they use it, which is when "Sign-in" turns to "Linked".
        </p>

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
        {{ facade.busy() ? 'Adding…' : 'Add resident' }}
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

  readonly model = signal({ fullName: '', unitNumber: '', email: '', needsAccessibleSpot: false });

  /**
   * The rules, in one place, with the API contract's numbers (see LIMITS).
   *
   * The email takes two checks. Angular's own `email` accepts `ana@building`, which is a
   * valid address on a private network and not one an invitation can reach; the server
   * validates with zod's `.email()`, which wants a dotted domain, so the second check
   * makes the client refuse what the server will refuse rather than relaying a 400.
   */
  readonly f = form(this.model, (p) => {
    required(p.fullName, { message: "Enter the resident's full name." });
    pattern(p.fullName, NOT_BLANK, { message: "Enter the resident's full name." });
    maxLength(p.fullName, LIMITS.fullName, { message: `Up to ${LIMITS.fullName} characters.` });

    required(p.unitNumber, { message: 'Enter the unit, as it is written on the door.' });
    pattern(p.unitNumber, NOT_BLANK, { message: 'Enter the unit, as it is written on the door.' });
    maxLength(p.unitNumber, LIMITS.unitNumber, {
      message: `Up to ${LIMITS.unitNumber} characters.`,
    });

    required(p.email, { message: 'Enter the email the invitation should go to.' });
    email(p.email, { message: 'Enter an address like name@example.com.' });
    pattern(p.email, DOTTED_DOMAIN, { message: 'Enter an address like name@example.com.' });
    maxLength(p.email, LIMITS.email, { message: `Up to ${LIMITS.email} characters.` });
  });

  readonly err = fieldError;

  constructor() {
    this.facade.dismissError();
    // Nor does it outlive the dialog: left set, the page behind would print it next.
    inject(DestroyRef).onDestroy(() => this.facade.dismissError());
  }

  /**
   * Save is never disabled for being invalid. A greyed-out button explains nothing; a
   * press marks every field touched, which puts each reason under its field, and only a
   * valid form reaches the server.
   */
  async submit(): Promise<void> {
    await submitForm(this.f, async () => {
      const v = this.model();
      const created = await this.facade.create({
        email: v.email.trim(),
        fullName: v.fullName.trim(),
        unitNumber: v.unitNumber.trim(),
        needsAccessibleSpot: v.needsAccessibleSpot,
      });
      if (created) this.ref.close(true);
    });
  }
}

@Component({
  selector: 'app-edit-resident-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormField,
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    LoadingOverlay,
  ],
  template: `
    <h2 mat-dialog-title>Edit — {{ resident.fullName }}</h2>

    <app-loading-overlay [active]="facade.busy()" [veil]="false" label="Saving the resident">
      <mat-dialog-content class="form">
        <mat-form-field appearance="outline">
          <mat-label>Full name</mat-label>
          <input
            matInput
            id="er-name"
            [formField]="f.fullName"
            autocomplete="off"
            cdkFocusInitial
          />
          <mat-error>{{ err(f.fullName) }}</mat-error>
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Unit</mat-label>
          <input matInput id="er-unit" [formField]="f.unitNumber" autocomplete="off" />
          <mat-error>{{ err(f.unitNumber) }}</mat-error>
        </mat-form-field>

        <mat-checkbox [formField]="f.needsAccessibleSpot">Needs an accessible bay</mat-checkbox>

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
    </app-loading-overlay>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button
        matButton="filled"
        [disabled]="!changed() || facade.busy()"
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

  readonly model = signal({
    fullName: this.resident.fullName,
    unitNumber: this.resident.unitNumber,
    needsAccessibleSpot: this.resident.needsAccessibleSpot,
  });

  readonly f = form(this.model, (p) => {
    required(p.fullName, { message: "Enter the resident's full name." });
    pattern(p.fullName, NOT_BLANK, { message: "Enter the resident's full name." });
    maxLength(p.fullName, LIMITS.fullName, { message: `Up to ${LIMITS.fullName} characters.` });

    required(p.unitNumber, { message: 'Enter the unit, as it is written on the door.' });
    pattern(p.unitNumber, NOT_BLANK, { message: 'Enter the unit, as it is written on the door.' });
    maxLength(p.unitNumber, LIMITS.unitNumber, {
      message: `Up to ${LIMITS.unitNumber} characters.`,
    });
  });

  readonly err = fieldError;

  constructor() {
    this.facade.dismissError();
    // Nor does it outlive the dialog: left set, the page behind would print it next.
    inject(DestroyRef).onDestroy(() => this.facade.dismissError());
  }

  /**
   * Only what actually changed is sent, and Save stays disabled until something does.
   * The server rejects an empty patch, and sending a field back unchanged would still
   * write an audit entry claiming it was edited.
   *
   * Clearing a field is a change, not a no-op: it used to be dropped from the patch
   * silently, so emptying the name and pressing Save "worked" and kept the old name. It
   * now counts as changed and the validation says why it cannot be saved.
   */
  private patch(): { fullName?: string; unitNumber?: string; needsAccessibleSpot?: boolean } {
    const r = this.resident;
    const v = this.model();
    const name = v.fullName.trim();
    const unit = v.unitNumber.trim();
    return {
      ...(name !== r.fullName ? { fullName: name } : {}),
      ...(unit !== r.unitNumber ? { unitNumber: unit } : {}),
      ...(v.needsAccessibleSpot !== r.needsAccessibleSpot
        ? { needsAccessibleSpot: v.needsAccessibleSpot }
        : {}),
    };
  }

  changed(): boolean {
    return Object.keys(this.patch()).length > 0;
  }

  async submit(): Promise<void> {
    await submitForm(this.f, async () => {
      const patch = this.patch();
      if (Object.keys(patch).length === 0) return;
      const done = await this.facade.update(this.resident.id, patch);
      if (done) this.ref.close(true);
    });
  }
}

@Component({
  selector: 'app-eligibility-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormField,
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    LoadingOverlay,
  ],
  template: `
    <h2 mat-dialog-title>Eligibility — {{ resident.fullName }}</h2>

    <app-loading-overlay [active]="facade.busy()" [veil]="false" label="Saving eligibility">
      <mat-dialog-content class="form">
        <mat-checkbox [formField]="f.eligible" cdkFocusInitial>May enter the draw</mat-checkbox>

        @if (!model().eligible) {
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>Reason</mat-label>
            <textarea
              matInput
              rows="3"
              [formField]="f.reason"
              placeholder="For example: unpaid dues"
            ></textarea>
            <mat-hint>
              Recorded in the audit log and shown to the resident, so write it as you would
              say it to them.
            </mat-hint>
            <mat-error>{{ err(f.reason) }}</mat-error>
          </mat-form-field>
        }

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
        {{ facade.busy() ? 'Saving…' : 'Save' }}
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

  readonly model = signal({
    eligible: this.resident.isEligible,
    reason: this.resident.ineligibleReason ?? '',
  });

  /** FR-15: the reason is required only when the answer is no, and is audit-logged. */
  readonly f = form(this.model, (p) => {
    applyWhen(
      p.reason,
      ({ valueOf }) => !valueOf(p.eligible),
      (reason) => {
        required(reason, { message: 'Say why, as you would to the resident. It is shown to them.' });
        pattern(reason, NOT_BLANK, {
          message: 'Say why, as you would to the resident. It is shown to them.',
        });
      },
    );
    maxLength(p.reason, LIMITS.ineligibleReason, {
      message: `Up to ${LIMITS.ineligibleReason} characters.`,
    });
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
      const done = await this.facade.setEligibility(
        this.resident.id,
        v.eligible,
        v.eligible ? null : v.reason.trim(),
      );
      if (done) this.ref.close(true);
    });
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
    FormField,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatMenuModule,
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
        [busy]="facade.busy()"
        loadingLabel="Loading vehicles"
        busyLabel="Saving the vehicle"
        emptyTitle="No vehicles registered"
        emptyBody="Add the plate of each car this resident brings into the building."
        (retry)="facade.refresh()"
      >
        <table mat-table [dataSource]="facade.vehicles()">
          <ng-container matColumnDef="plate">
            <th mat-header-cell *matHeaderCellDef scope="col">Plate</th>
            <td mat-cell *matCellDef="let v" data-label="Plate">
              <span class="code stencil">{{ v.plateDisplay }}</span>
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
                matIconButton
                type="button"
                [disabled]="facade.busy()"
                [matMenuTriggerFor]="vehicleMenu"
                [attr.aria-label]="'Actions for ' + v.plateDisplay"
              >
                <mat-icon>more_vert</mat-icon>
              </button>
              <mat-menu #vehicleMenu="matMenu">
                <button mat-menu-item type="button" (click)="startEdit(v)">Edit</button>
                <button mat-menu-item type="button" class="danger" (click)="remove(v)">
                  Remove
                </button>
              </mat-menu>
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
              [formField]="f.plate"
              autocomplete="off"
              spellcheck="false"
              aria-describedby="veh-plate-hint"
            />
            <mat-hint id="veh-plate-hint">
              Type it as it is painted. Spaces and dashes are kept for the register and
              ignored when the gate matches it.
            </mat-hint>
            <mat-error>{{ err(f.plate) }}</mat-error>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Make</mat-label>
            <input matInput [formField]="f.make" autocomplete="off" />
            <mat-error>{{ err(f.make) }}</mat-error>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Model</mat-label>
            <input matInput [formField]="f.model" autocomplete="off" />
            <mat-error>{{ err(f.model) }}</mat-error>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Year</mat-label>
            <input matInput type="number" inputmode="numeric" [formField]="f.year" />
            <mat-error>{{ err(f.year) }}</mat-error>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Colour</mat-label>
            <input matInput [formField]="f.colour" autocomplete="off" />
            <mat-error>{{ err(f.colour) }}</mat-error>
          </mat-form-field>

          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="grid__wide">
            <mat-label>Photo keys</mat-label>
            <input
              matInput
              [formField]="f.photos"
              autocomplete="off"
              spellcheck="false"
              aria-describedby="veh-photos-hint"
            />
            <mat-hint id="veh-photos-hint">
              One storage key or URL per entry, comma separated. Uploading a file from
              here is the next piece of work; this field only records where a photo is.
            </mat-hint>
            <mat-error>{{ err(f.photos) }}</mat-error>
          </mat-form-field>

          <mat-form-field appearance="outline" class="grid__wide">
            <mat-label>Notes</mat-label>
            <textarea matInput rows="2" [formField]="f.notes"></textarea>
            <mat-error>{{ err(f.notes) }}</mat-error>
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
            [disabled]="facade.busy()"
            [class.is-pending]="facade.busy()"
            (click)="submit()"
          >
            @if (facade.busy()) {
              Saving…
            } @else if (editing()) {
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

      /* The table and its shared cells are styles.scss's; the canonical line is this
         list's own. */
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

  readonly model = signal<VehicleForm>(blankVehicleForm());

  /**
   * The contract's limits, field by field. The plate is the only required field, and
   * only in the sense of containing something a plate is made of: the canonical rule and
   * the uniqueness check live on the server, which is the one place that can know both.
   */
  readonly f = form(this.model, (p) => {
    required(p.plate, { message: 'Enter the plate, as it is painted.' });
    pattern(p.plate, PLATE_CHARACTER, { message: 'A plate needs at least one letter or digit.' });
    maxLength(p.plate, LIMITS.plate, { message: `Up to ${LIMITS.plate} characters.` });
    maxLength(p.make, LIMITS.make, { message: `Up to ${LIMITS.make} characters.` });
    maxLength(p.model, LIMITS.model, { message: `Up to ${LIMITS.model} characters.` });
    min(p.year, LIMITS.minYear, { message: `A model year from ${LIMITS.minYear}.` });
    max(p.year, this.maxYear, { message: `A model year up to ${this.maxYear}.` });
    maxLength(p.colour, LIMITS.colour, { message: `Up to ${LIMITS.colour} characters.` });
    maxLength(p.notes, LIMITS.notes, { message: `Up to ${LIMITS.notes} characters.` });
    validate(p.photos, ({ value }) =>
      splitPhotos(value()).some((k) => k.length > LIMITS.photoKey)
        ? { kind: 'maxLength', message: `Each key up to ${LIMITS.photoKey} characters.` }
        : null,
    );
  });

  readonly err = fieldError;

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

  startEdit(v: Vehicle): void {
    this._editing.set(v);
    this.facade.dismissError();
    this.f().reset({
      plate: v.plateDisplay,
      make: v.make ?? '',
      model: v.model ?? '',
      year: v.year,
      colour: v.colour ?? '',
      notes: v.notes ?? '',
      photos: v.photos.join(', '),
    });
  }

  cancelEdit(): void {
    this._editing.set(null);
    this.facade.dismissError();
    /*
     * Values and touched state go back together. Emptied, the required plate is invalid
     * again, and left touched from the entry that just succeeded it would paint the field
     * red the moment a vehicle was added - an empty form nobody has filled in yet is not
     * an error.
     */
    this.f().reset(blankVehicleForm());
  }

  async submit(): Promise<void> {
    await submitForm(this.f, async () => {
      const draft = this.draft();
      const editing = this._editing();
      const done = editing
        ? await this.facade.update(editing.id, draft)
        : await this.facade.add(draft);
      // The form only clears once the server has accepted it. A rejected plate has to
      // stay on screen with the typed value intact, or the administrator retypes it blind.
      if (done) this.cancelEdit();
    });
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
    const v = this.model();
    return {
      plate: v.plate.trim(),
      make: t(v.make),
      model: t(v.model),
      // 0 is not a model year, and an emptied number input must not become one.
      year: v.year ? Number(v.year) : null,
      colour: t(v.colour),
      notes: t(v.notes),
      photos: splitPhotos(v.photos),
    };
  }
}

/** The photo keys field, as the list the API takes: comma or newline separated. */
const splitPhotos = (raw: string): string[] =>
  raw
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

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
