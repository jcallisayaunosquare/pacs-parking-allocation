import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import {
  FormField,
  maxLength,
  pattern,
  required,
  type FieldTree,
  type SchemaPathTree,
} from '@angular/forms/signals';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { Vehicle, VehicleDraft } from '../../domain/models';
import { LIMITS, PLATE_CHARACTER, fieldError } from '../../shared/forms/limits';

/**
 * A vehicle as the form holds it: every field a string.
 *
 * The year is text, not a number input, on purpose. The vehicle form this replaces bound
 * `<input type="number">` to a `number | null` through Signal Forms' native number
 * parsing, and in the browser it never sent a single request - the API logs show GETs of
 * the register and no POST at all - while every test that filled the model directly
 * passed. A four-digit text field validated by pattern has no parser in the way, and is
 * what a person types a model year into anyway.
 */
export interface VehicleForm {
  plate: string;
  make: string;
  model: string;
  year: string;
  colour: string;
}

export const blankVehicle = (): VehicleForm => ({
  plate: '',
  make: '',
  model: '',
  year: '',
  colour: '',
});

export const fromVehicle = (v: Vehicle): VehicleForm => ({
  plate: v.plateDisplay,
  make: v.make ?? '',
  model: v.model ?? '',
  year: v.year === null ? '' : String(v.year),
  colour: v.colour ?? '',
});

/** True when nothing has been typed: the optional step was skipped. */
export const isBlankVehicle = (f: VehicleForm): boolean =>
  Object.values(f).every((v) => v.trim().length === 0);

const orNull = (s: string): string | null => (s.trim().length > 0 ? s.trim() : null);

/** The fields this form edits - the rest of a VehicleDraft it never touches. */
export type VehicleFormDraft = Pick<VehicleDraft, 'plate' | 'make' | 'model' | 'year' | 'colour'>;

/** Form to wire. Empty optional fields go as null, so an edit can clear them. */
export const toVehicleDraft = (f: VehicleForm): VehicleFormDraft => ({
  plate: f.plate.trim(),
  make: orNull(f.make),
  model: orNull(f.model),
  year: f.year.trim() ? Number(f.year.trim()) : null,
  colour: orNull(f.colour),
});

/**
 * A new car's full draft. Notes and photos start empty here; an edit never sends them,
 * so the ones already on a car - entered elsewhere - are not wiped by this form.
 */
export const newVehicleDraft = (f: VehicleForm): VehicleDraft => ({
  ...toVehicleDraft(f),
  notes: null,
  photos: [],
});

/** Next year's models are on sale this year; the server enforces the same bound. */
export const maxModelYear = (): number => new Date().getFullYear() + 1;

/**
 * A model year from 1900 to `top`, as a pattern - so the range is checked by the same
 * built-in validator as every other field, with no hand-written one in the way. Built
 * for a `top` in 2000-2099, which covers this product's life: 19xx, then the full
 * decades of 20xx before top's, then top's decade up to its last digit.
 */
export const yearPattern = (top: number): RegExp => {
  const tens = Math.floor((top % 100) / 10);
  const units = top % 10;
  const fullDecades = tens > 0 ? `|20[0-${tens - 1}]\\d` : '';
  return new RegExp(`^(19\\d\\d${fullDecades}|20${tens}[0-${units}])$`);
};

/**
 * The rules, from the contract's limits. Applied by whichever form owns the fields - the
 * add-resident stepper only when its optional step was filled in, the vehicle dialog
 * always.
 */
export function vehicleRules(p: SchemaPathTree<VehicleForm>): void {
  const top = maxModelYear();
  required(p.plate, { message: 'Enter the plate, as it is painted.' });
  pattern(p.plate, PLATE_CHARACTER, { message: 'A plate needs at least one letter or digit.' });
  maxLength(p.plate, LIMITS.plate, { message: `Up to ${LIMITS.plate} characters.` });
  maxLength(p.make, LIMITS.make, { message: `Up to ${LIMITS.make} characters.` });
  maxLength(p.model, LIMITS.model, { message: `Up to ${LIMITS.model} characters.` });
  pattern(p.year, yearPattern(top), { message: `A year from ${LIMITS.minYear} to ${top}.` });
  maxLength(p.colour, LIMITS.colour, { message: `Up to ${LIMITS.colour} characters.` });
}

/**
 * The fields themselves, for any form that holds a VehicleForm. One template, so the
 * stepper's optional step and the edit dialog cannot drift apart.
 */
@Component({
  selector: 'app-vehicle-fields',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormField, MatFormFieldModule, MatInputModule],
  template: `
    <div class="grid">
      <mat-form-field appearance="outline" class="grid__wide">
        <mat-label>Plate</mat-label>
        <input
          matInput
          class="stencil"
          [formField]="fields().plate"
          autocomplete="off"
          spellcheck="false"
        />
        <mat-hint>
          As it is painted. Spaces and dashes are kept here and ignored when the gate
          matches it.
        </mat-hint>
        <mat-error>{{ err(fields().plate) }}</mat-error>
      </mat-form-field>

      <mat-form-field appearance="outline">
        <mat-label>Make</mat-label>
        <input matInput [formField]="fields().make" autocomplete="off" />
        <mat-error>{{ err(fields().make) }}</mat-error>
      </mat-form-field>

      <mat-form-field appearance="outline">
        <mat-label>Model</mat-label>
        <input matInput [formField]="fields().model" autocomplete="off" />
        <mat-error>{{ err(fields().model) }}</mat-error>
      </mat-form-field>

      <mat-form-field appearance="outline">
        <mat-label>Year</mat-label>
        <input
          matInput
          inputmode="numeric"
          [formField]="fields().year"
          autocomplete="off"
        />
        <mat-error>{{ err(fields().year) }}</mat-error>
      </mat-form-field>

      <mat-form-field appearance="outline">
        <mat-label>Colour</mat-label>
        <input matInput [formField]="fields().colour" autocomplete="off" />
        <mat-error>{{ err(fields().colour) }}</mat-error>
      </mat-form-field>
    </div>
  `,
  styles: [
    `
      .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--sp-2) var(--sp-3);
      }
      .grid__wide {
        grid-column: 1 / -1;
      }
      @media (max-width: 34rem) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class VehicleFields {
  readonly fields = input.required<FieldTree<VehicleForm>>();
  readonly err = fieldError;
}
