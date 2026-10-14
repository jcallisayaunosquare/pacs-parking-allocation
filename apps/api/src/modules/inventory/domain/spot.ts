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

/* ------------------------------------------------------------ lot occupancy */

export type BayStatus = 'FREE' | 'HELD' | 'OUT_OF_SERVICE';

/** One bay as the occupancy query reads it: the inventory row and its live assignment. */
export interface BayRow {
  readonly spotId: string;
  readonly spotCode: string;
  readonly type: string;
  readonly isActive: boolean;
  readonly assignment: {
    readonly residentId: string;
    readonly fullName: string;
    readonly unitNumber: string;
    readonly validUntil: Date;
  } | null;
}

export interface BayOccupancy {
  readonly spotId: string;
  readonly spotCode: string;
  readonly type: string;
  readonly status: BayStatus;
  /** Who holds it - an administrator's fact only. Always null for anyone else. */
  readonly occupant: { readonly displayName: string; readonly unit: string } | null;
  readonly validUntil: Date | null;
  /** Whether the viewer is the one holding it. The only identity a resident is told. */
  readonly isMine: boolean;
}

/**
 * What a viewer may know about each bay on a level.
 *
 * Status is the inventory and the live assignment, nothing invented: a retired bay is
 * out of service, an active assignment makes a bay held, anything else is free. Who
 * holds a bay is the building's parking register - and, bay by bay, who is away and who
 * is home - so it leaves the server only for an administrator. A resident learns one
 * identity, their own, as `isMine`.
 */
export function lotOccupancy(
  rows: readonly BayRow[],
  viewer: { readonly residentId: string | null; readonly isAdmin: boolean },
): readonly BayOccupancy[] {
  return rows.map((r) => {
    const held = r.isActive && r.assignment !== null;
    const status: BayStatus = !r.isActive ? 'OUT_OF_SERVICE' : held ? 'HELD' : 'FREE';
    return {
      spotId: r.spotId,
      spotCode: r.spotCode,
      type: r.type,
      status,
      occupant:
        held && viewer.isAdmin
          ? { displayName: r.assignment!.fullName, unit: r.assignment!.unitNumber }
          : null,
      validUntil: held ? r.assignment!.validUntil : null,
      isMine: held && viewer.residentId !== null && r.assignment!.residentId === viewer.residentId,
    };
  });
}
