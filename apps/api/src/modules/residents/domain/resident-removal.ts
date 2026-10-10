/**
 * What a resident leaves behind, and therefore whether removing them deletes the row or
 * only hides it.
 *
 * The register is a list of people, and taking someone off it is the normal operation:
 * they moved out. What must not happen is losing the explanation of a draw they were in,
 * so §11 puts ON DELETE RESTRICT on allocation_history.resident_id and the soft delete
 * exists to respect it.
 *
 * But a resident who never registered, never held a bay and appears in no record is not
 * part of the history of anything - they are a row somebody typed, and typically typed
 * by mistake or by a test. Keeping that row for ever, hidden, serves nobody. This is the
 * same line already drawn for a period that never drew and for a bay never assigned.
 *
 * `changedConfig` and `reviewedPlateReads` are in the list for a reason that is not
 * about the draw: allocation_config.changed_by references resident with no ON DELETE
 * clause, so the database would refuse the delete outright, and a person who changed the
 * building's rules is part of its record anyway.
 */
export function residentRemovalBlocker(input: {
  readonly registrations: number;
  readonly assignments: number;
  readonly historyRows: number;
  readonly changedConfig: number;
  readonly reviewedPlateReads: number;
}): string | null {
  if (input.historyRows > 0) {
    return 'This resident appears in the allocation history, which is never reset.';
  }
  if (input.assignments > 0) {
    return 'This resident has been given a bay, so the allocation record names them.';
  }
  if (input.registrations > 0) {
    return 'This resident has entered a draw, so the record of it names them.';
  }
  if (input.changedConfig > 0) {
    return "This resident has changed the building's allocation rules, which is recorded.";
  }
  if (input.reviewedPlateReads > 0) {
    return 'This resident has reviewed a plate read, and that decision is recorded.';
  }
  return null;
}
