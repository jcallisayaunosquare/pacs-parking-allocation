/**
 * When a bay may be removed from the inventory, rather than retired.
 *
 * The same line §11 draws for a period, drawn for a bay: a bay that has never held
 * anyone is still part of the plan of the building and can be taken back out of it; one
 * that has appears in the allocation record, and that record is never rewritten. The
 * schema says as much with ON DELETE RESTRICT on spot_assignment.spot_id and
 * allocation_history.spot_id - this refuses first so the caller gets a sentence rather
 * than a foreign key violation.
 *
 * Retiring remains the answer for a bay that has been used: it leaves the inventory
 * without touching what it is named in.
 */
export function spotRemovalBlocker(input: {
  readonly assignments: number;
  readonly historyRows: number;
}): string | null {
  if (input.assignments > 0) {
    return (
      `This bay has been assigned ${input.assignments} ` +
      `${input.assignments === 1 ? 'time' : 'times'}. Allocation history is never reset, so it ` +
      'cannot be removed. Retire it instead to take it out of the inventory.'
    );
  }
  /*
   * Checked separately from the assignments, and not folded into one count: history
   * outlives an assignment. A bay whose assignment rows were released still has rows in
   * allocation_history naming it, and that is reason enough on its own.
   */
  if (input.historyRows > 0) {
    return (
      'This bay appears in the allocation history, so it is part of the record and cannot ' +
      'be removed. Retire it instead to take it out of the inventory.'
    );
  }
  return null;
}
