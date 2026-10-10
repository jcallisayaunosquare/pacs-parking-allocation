import type { CycleState } from './types';

/**
 * Whether a draw may run at all, given what the rest of the building is doing.
 *
 * `isRunnable` already answers the question about this period: a run starts from
 * REGISTRATION_CLOSED and nowhere else. This answers the one about the others, and it is
 * a different question - a period can be perfectly ready while an allocation from the
 * last one is still in force.
 *
 * Why it has to be refused: an allocation is a statement about who may park, and two of
 * them at once is two statements. The bays are the same bays. Dev had exactly this - two
 * periods ACTIVE together, and bay B1-08 assigned in both, to two different residents,
 * with nothing in the system treating that as wrong. Rule C makes it worse than
 * cosmetic: holding a bay moves a resident's waiting anchor, so a second draw would
 * reset the anchors of people whose benefit from the first has not ended.
 *
 * The administrator's way forward is to close the period in effect, which ends its
 * assignments and is what ending a period means. That is an action, not a wait: the
 * sweeper closes a period once `ends_on` has passed, and an administrator who wants to
 * hand out the next allocation early says so.
 */
export function drawBlocker(input: {
  readonly state: CycleState;
  /** The period in effect, when one is - never this period, which is not ACTIVE. */
  readonly periodInEffect: { readonly label: string } | null;
}): string | null {
  if (input.periodInEffect) {
    return (
      `${input.periodInEffect.label} is in effect, and its residents hold the bays this ` +
      'draw would hand out. Close it first - that ends its assignments - and then run ' +
      'this draw.'
    );
  }
  return null;
}
