import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import {
  FormField,
  applyWhen,
  email,
  form,
  maxLength,
  pattern,
  required,
  submit as submitForm,
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
import { ResidentsFacade } from '../../application/admin.facades';
import type { Resident, Vehicle, VehicleDraft } from '../../domain/models';
import { LoadingOverlay } from '../../shared/ui/loading-overlay';
import { DOTTED_DOMAIN, LIMITS, NOT_BLANK, fieldError } from '../../shared/forms/limits';
import {
  VehicleFields,
  blankVehicle,
  fromVehicle,
  isBlankVehicle,
  newVehicleDraft,
  toVehicleDraft,
  vehicleRules,
  type VehicleForm,
  type VehicleFormDraft,
} from './vehicle-fields';

/**
 * The register's dialogs.
 *
 * Each one performs its own mutation and closes only once the server has accepted it,
 * which is why the facade is injected here rather than the dialog handing a value back
 * to the page. A rejected edit has to stay on screen with the typed values intact —
 * closing first and showing the error behind would throw the work away.
 */

/**
 * Adding a resident, and their car if they have one, in one form.
 *
 * Two sections, each named and marked: the resident, which is required, then the car,
 * which is not. One sitting rather than "add the resident, then find them, then open
 * their vehicle": the car is registered with the person in almost every real case, and
 * making it a second errand is how residents end up in the register with no plate and a
 * gate that turns them away. It stays optional because some residents have no car.
 *
 * One button. The car is saved when anything was typed into its section, and then it
 * must hold - a make with no plate is half a car, and the plate is what the gate reads.
 * An untouched section is simply no car.
 *
 * The two writes are separate requests - there is no endpoint that creates both - so the
 * dialog is honest about the gap between them: if the resident is created and the car is
 * refused, it says the resident exists and offers to try the car again, against the
 * resident already made, never by creating them twice.
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
    MatIconModule,
    MatInputModule,
    LoadingOverlay,
    VehicleFields,
  ],
  template: `
    <h2 mat-dialog-title>Add resident</h2>

    <app-loading-overlay [active]="facade.busy()" [veil]="false" label="Adding the resident">
      <mat-dialog-content class="form">
        @if (createdId()) {
          <!--
            The resident exists; only the car is outstanding. Said first, so nobody adds
            the same person twice to get the car in.
          -->
          <p class="msg msg--warn" role="alert">
            {{ model().fullName }} was added. The vehicle was not saved{{
              facade.error() ? ': ' + facade.error()!.message : '.'
            }}
          </p>
        } @else if (facade.error(); as e) {
          <div class="msg msg--bad" role="alert">{{ e.message }}</div>
        }

        <section class="sec" aria-labelledby="add-res-h" [attr.inert]="createdId() ? '' : null">
          <h3 class="sec__h" id="add-res-h">
            <mat-icon aria-hidden="true">person</mat-icon>
            Resident
          </h3>

          <mat-form-field appearance="outline">
            <mat-label>Full name</mat-label>
            <input matInput [formField]="f.fullName" autocomplete="off" cdkFocusInitial />
            <mat-error>{{ err(f.fullName) }}</mat-error>
          </mat-form-field>

          <div class="pair">
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
              <mat-error>{{ err(f.email) }}</mat-error>
            </mat-form-field>
          </div>

          <mat-checkbox [formField]="f.needsAccessibleSpot">Needs an accessible bay</mat-checkbox>

          <p class="note">
            The resident gets an invitation at this email. Their sign-in links itself to
            this record the first time they use it, which is when "Sign-in" turns to "Linked".
          </p>
        </section>

        <section class="sec" aria-labelledby="add-veh-h">
          <h3 class="sec__h" id="add-veh-h">
            <mat-icon aria-hidden="true">directions_car</mat-icon>
            Vehicle
            <span class="sec__opt">Optional</span>
          </h3>
          <p class="note">
            The plate is what the gate reads against. Leave this empty if the resident has
            no car; anything typed here is saved with them.
          </p>
          <app-vehicle-fields [fields]="vf" />
        </section>
      </mat-dialog-content>
    </app-loading-overlay>

    <mat-dialog-actions align="end">
      @if (createdId()) {
        <button matButton type="button" (click)="ref.close(true)">Close</button>
        <button
          matButton="filled"
          type="button"
          [disabled]="facade.busy()"
          [class.is-pending]="facade.busy()"
          (click)="saveVehicle()"
        >
          {{ facade.busy() ? 'Saving…' : 'Try the vehicle again' }}
        </button>
      } @else {
        <button matButton mat-dialog-close>Cancel</button>
        <button
          matButton="filled"
          type="button"
          [disabled]="facade.busy()"
          [class.is-pending]="facade.busy()"
          (click)="submit()"
        >
          {{ facade.busy() ? 'Adding…' : 'Add resident' }}
        </button>
      }
    </mat-dialog-actions>
  `,
  styles: [
    `
      .form {
        display: flex;
        flex-direction: column;
        gap: var(--sp-5);
      }

      /* A section is a heading and its fields; the next one is set off by a hairline. */
      .sec {
        display: flex;
        flex-direction: column;
        gap: var(--sp-2);
      }
      .sec + .sec {
        padding-top: var(--sp-5);
        border-top: 1px solid var(--rule);
      }

      /* The section's name, with the glyph of what it is about. */
      .sec__h {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        margin: 0 0 var(--sp-2);
        font-size: var(--t-small);
        font-variation-settings:
          'wdth' 112,
          'wght' 640;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--ink-2);
      }
      .sec__h mat-icon {
        width: 20px;
        height: 20px;
        font-size: 20px;
        color: var(--signal);
      }
      .sec__opt {
        margin-left: var(--sp-1);
        font-size: var(--t-fine);
        font-variation-settings: 'wght' 460;
        letter-spacing: 0.04em;
        text-transform: none;
        color: var(--ink-3);
      }

      /* Unit and email side by side: both short, and read together. */
      .pair {
        display: grid;
        grid-template-columns: 1fr 2fr;
        gap: var(--sp-3);
      }
      @media (max-width: 34rem) {
        .pair {
          grid-template-columns: 1fr;
        }
      }

      .note {
        margin: 0;
        font-size: var(--t-fine);
        color: var(--steel-faint);
      }
    `,
  ],
})
export class AddResidentDialog {
  readonly facade = inject(ResidentsFacade);
  readonly ref = inject(MatDialogRef<AddResidentDialog>);

  readonly model = signal({ fullName: '', unitNumber: '', email: '', needsAccessibleSpot: false });
  readonly vehicle = signal<VehicleForm>(blankVehicle());

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

  /** The car's rules - checked only when something was typed into its section. */
  readonly vf = form(this.vehicle, vehicleRules);

  readonly err = fieldError;

  /** Set once the resident exists, so a retry adds the car to them instead of again. */
  readonly createdId = signal<string | null>(null);

  constructor() {
    this.facade.dismissError();
    // Nor does it outlive the dialog: left set, the page behind would print it next.
    inject(DestroyRef).onDestroy(() => this.facade.dismissError());
  }

  /**
   * Save is never disabled for being invalid. A greyed-out button explains nothing; a
   * press marks every field touched, which puts each reason under its field, and only a
   * valid form reaches the server.
   *
   * Both sections are checked before anything is sent, so a half-filled car is caught
   * while the resident has not been created yet - not after, as a second error.
   */
  async submit(): Promise<void> {
    const withCar = !isBlankVehicle(this.vehicle());
    const residentOk = await submitForm(this.f, async () => undefined);
    const carOk = withCar ? await submitForm(this.vf, async () => undefined) : true;
    if (!residentOk || !carOk) return;

    const v = this.model();
    const created = await this.facade.create({
      email: v.email.trim(),
      fullName: v.fullName.trim(),
      unitNumber: v.unitNumber.trim(),
      needsAccessibleSpot: v.needsAccessibleSpot,
    });
    if (!created) return;

    if (!withCar) {
      this.ref.close(true);
      return;
    }
    this.createdId.set(created.id);
    await this.saveVehicle();
  }

  /** The car, against the resident already created. Also the retry. */
  async saveVehicle(): Promise<void> {
    const id = this.createdId();
    if (!id) return;
    const saved = await this.facade.addVehicle(id, newVehicleDraft(this.vehicle()));
    if (saved) this.ref.close(true);
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

/** What the vehicle dialogs are opened with: the resident, and their car if they have one. */
export interface VehicleDialogData {
  readonly resident: Resident;
  readonly vehicle: Vehicle | null;
}

/**
 * Adding a car to a resident, or changing the one they have.
 *
 * One dialog for both, chosen by whether a car came in: the register's ⋮ menu reads
 * "Add vehicle" or "Edit vehicle" from the same fact, so the words and the form agree.
 * Editing starts from the car on record - every field filled in - and sends only what
 * changed, because the server refuses an empty patch and an unchanged field would still
 * be logged as edited.
 */
@Component({
  selector: 'app-vehicle-form-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule, LoadingOverlay, VehicleFields],
  template: `
    <h2 mat-dialog-title>
      {{ data.vehicle ? 'Edit vehicle' : 'Add vehicle' }} &mdash; {{ data.resident.fullName }}
    </h2>

    <app-loading-overlay [active]="facade.busy()" [veil]="false" label="Saving the vehicle">
      <mat-dialog-content class="form">
        <app-vehicle-fields [fields]="vf" />

        @if (facade.error(); as e) {
          <div class="msg msg--bad" role="alert">{{ e.message }}</div>
        }
      </mat-dialog-content>
    </app-loading-overlay>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button
        matButton="filled"
        type="button"
        [disabled]="(data.vehicle !== null && !dirty()) || facade.busy()"
        [class.is-pending]="facade.busy()"
        (click)="submit()"
      >
        @if (facade.busy()) {
          Saving…
        } @else {
          {{ data.vehicle ? 'Save changes' : 'Add vehicle' }}
        }
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .form {
        display: flex;
        flex-direction: column;
        gap: var(--sp-3);
        padding-top: var(--sp-2);
      }
    `,
  ],
})
export class VehicleFormDialog {
  readonly facade = inject(ResidentsFacade);
  private readonly ref = inject(MatDialogRef<VehicleFormDialog>);
  readonly data = inject<VehicleDialogData>(MAT_DIALOG_DATA);

  /** Pre-filled from the car on record when editing, so nothing is retyped. */
  readonly vehicle = signal<VehicleForm>(
    this.data.vehicle ? fromVehicle(this.data.vehicle) : blankVehicle(),
  );
  readonly vf = form(this.vehicle, vehicleRules);

  constructor() {
    this.facade.dismissError();
    inject(DestroyRef).onDestroy(() => this.facade.dismissError());
  }

  /**
   * The fields that differ from the car on record, as a patch - only the five this form
   * edits, so notes and photos already on the car are never sent and never wiped.
   */
  private patch(): Partial<VehicleDraft> {
    const after = toVehicleDraft(this.vehicle());
    if (!this.data.vehicle) return after;
    const before = toVehicleDraft(fromVehicle(this.data.vehicle));
    const out: Partial<VehicleDraft> = {};
    for (const k of Object.keys(after) as (keyof VehicleFormDraft)[]) {
      if (after[k] !== before[k]) (out as Record<string, unknown>)[k] = after[k];
    }
    return out;
  }

  dirty(): boolean {
    return Object.keys(this.patch()).length > 0;
  }

  async submit(): Promise<void> {
    await submitForm(this.vf, async () => {
      const r = this.data.resident;
      const saved = this.data.vehicle
        ? await this.facade.updateVehicle(r.id, this.data.vehicle.id, this.patch())
        : await this.facade.addVehicle(r.id, newVehicleDraft(this.vehicle()));
      if (saved) this.ref.close(true);
    });
  }
}

/**
 * A resident's car, read-only - what the car icon in the register opens.
 *
 * The plate in the stencil treatment, because it is the string the gate matches; the
 * canonical form beneath it whenever it differs, because "the camera says my plate is
 * not registered" has no other answer. Editing is one button away, and goes through the
 * ⋮ menu's own dialog so there is one way to change a car, not two.
 */
@Component({
  selector: 'app-vehicle-detail-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>Vehicle &mdash; {{ data.resident.fullName }}</h2>

    <mat-dialog-content>
      @if (data.vehicle; as v) {
        <p class="plate stencil">{{ v.plateDisplay }}</p>
        @if (v.plate !== v.plateDisplay) {
          <p class="canon">The gate matches it as <span class="code">{{ v.plate }}</span></p>
        }
        <dl class="facts">
          <dt>Make</dt>
          <dd>{{ v.make || dash }}</dd>
          <dt>Model</dt>
          <dd>{{ v.model || dash }}</dd>
          <dt>Year</dt>
          <dd class="num">{{ v.year ?? dash }}</dd>
          <dt>Colour</dt>
          <dd>{{ v.colour || dash }}</dd>
          <dt>Unit</dt>
          <dd>{{ data.resident.unitNumber }}</dd>
        </dl>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Close</button>
      <button matButton="outlined" type="button" (click)="edit()">
        <mat-icon aria-hidden="true">edit</mat-icon>
        Edit vehicle
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .plate {
        margin: var(--sp-2) 0 0;
        font-size: var(--t-head);
        font-variant-numeric: tabular-nums;
      }
      .canon {
        margin: var(--sp-1) 0 0;
        font-size: var(--t-fine);
        color: var(--steel-faint);
      }
      .facts {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--sp-2) var(--sp-5);
        margin: var(--sp-5) 0 0;
        padding-top: var(--sp-4);
        border-top: 1px solid var(--rule-soft);
        font-size: var(--t-small);
      }
      .facts dt {
        color: var(--steel-faint);
      }
      .facts dd {
        margin: 0;
      }
      .num {
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
})
export class VehicleDetailDialog {
  private readonly ref = inject(MatDialogRef<VehicleDetailDialog>);
  readonly data = inject<VehicleDialogData>(MAT_DIALOG_DATA);
  readonly dash = '—';

  /** Closes saying "edit", and the register opens the edit dialog on this car. */
  edit(): void {
    this.ref.close('edit');
  }
}
