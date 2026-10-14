import type { FieldTree } from '@angular/forms/signals';

/**
 * Field limits, copied from the API contract rather than chosen here.
 *
 * The server is the authority: it validates every one of these with the same numbers
 * (packages/contracts/openapi.yaml, line given beside each). The client repeats them only
 * so a person learns about a too-long name while typing it, instead of from a 400 after
 * pressing Save. If a limit changes, it changes in the contract first and here second -
 * a client limit tighter than the server's refuses valid input, and a looser one is the
 * 400 again.
 */
export const LIMITS = {
  /** openapi.yaml:220 - and RFC 5321's own ceiling for an address. */
  email: 254,
  /** openapi.yaml:221, 273 */
  fullName: 200,
  /** openapi.yaml:222, 274 */
  unitNumber: 40,
  /** openapi.yaml:315 */
  ineligibleReason: 500,
  /** openapi.yaml:806 */
  spotCode: 40,
  /** openapi.yaml:807, 831 */
  level: 20,
  /** openapi.yaml:809, 833, 1574, 1740 */
  notes: 2000,
  /** openapi.yaml:872, 917 */
  cycleLabel: 20,
  /** openapi.yaml:1558, 1726 */
  plate: 40,
  /** openapi.yaml:1730, 1731 */
  make: 80,
  model: 80,
  /** openapi.yaml:1738 */
  colour: 40,
  /** openapi.yaml:1734 */
  minYear: 1900,
  /** openapi.yaml:1743 - each photo key. */
  photoKey: 512,
} as const;

/**
 * Something other than spaces. `required` alone accepts "   ", which the server trims to
 * an empty string and refuses.
 */
export const NOT_BLANK = /\S/;

/** Something a plate is made of. Spaces and dashes alone are not a plate. */
export const PLATE_CHARACTER = /[0-9a-z]/i;

/**
 * An address whose domain has a dot in it, as the server's zod `.email()` requires.
 * Angular's `email` validator alone accepts `ana@building`.
 */
export const DOTTED_DOMAIN = /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/;

/**
 * The message a field should show, or null.
 *
 * Only once the field has been touched: an error on a field the person has not reached
 * yet is an accusation about something they have not done. Submitting marks every field
 * touched, so nothing invalid can be sent without its reason on screen.
 */
export function fieldError(field: FieldTree<unknown>): string | null {
  const state = field();
  if (!state.touched() || state.valid()) return null;
  const first = state.errors()[0];
  if (!first) return null;
  return first.message ?? FALLBACK[first.kind] ?? 'Check this field.';
}

/**
 * Messages for errors a rule did not word itself - the ones that come from a control
 * rather than from a schema, like a datepicker that could not read what was typed.
 */
const FALLBACK: Record<string, string> = {
  matDatepickerParse: 'Enter a date the calendar can read, or pick one.',
  required: 'This field is required.',
};
