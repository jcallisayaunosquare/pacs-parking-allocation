import type { AssignmentState, CycleState } from './types';

/** Figure 11.2 - the only legal cycle transitions. Anything else is 422. */
const CYCLE_TRANSITIONS: Readonly<Record<CycleState, readonly CycleState[]>> = {
  DRAFT: ['REGISTRATION_OPEN'],
  REGISTRATION_OPEN: ['REGISTRATION_CLOSED'],
  // REGISTRATION_CLOSED -> itself is a failed run: a retry is allowed (section 12).
  REGISTRATION_CLOSED: ['ACTIVE', 'REGISTRATION_CLOSED'],
  ACTIVE: ['CLOSED'],
  CLOSED: [],
};

export const canTransitionCycle = (from: CycleState, to: CycleState): boolean =>
  (CYCLE_TRANSITIONS[from] ?? []).includes(to);

/** The only state a run may start from (section 11, note on Figure 11.2). */
export const isRunnable = (state: CycleState): boolean => state === 'REGISTRATION_CLOSED';

export const isRegistrationOpen = (state: CycleState): boolean => state === 'REGISTRATION_OPEN';

/**
 * Whether a period may be removed, and if not, why not - in the words an administrator
 * is shown.
 *
 * The rule follows rule D rather than convenience: allocation history is never reset,
 * because a past draw has to stay explainable to the resident who lost it. So the line
 * is drawn at the moment a period produced consequences. Before a draw has run it is a
 * plan, and a plan can be abandoned. Once it has handed out a bay it is part of the
 * record, and the way to end it is to let it close, not to erase it.
 *
 * A reason string rather than a boolean, because "no" without "why" sends an operator
 * to support.
 */
export function cycleRemovalBlocker(input: {
  readonly state: CycleState;
  readonly hasRun: boolean;
  readonly assignments: number;
}): string | null {
  if (input.assignments > 0) {
    return (
      `This period has handed out ${input.assignments} ` +
      `${input.assignments === 1 ? 'bay' : 'bays'}. Allocation history is never reset, so it ` +
      'cannot be removed. Close it instead when it ends.'
    );
  }
  if (input.hasRun) {
    return 'A draw has already run for this period, so its record is kept. It cannot be removed.';
  }
  if (input.state === 'ACTIVE' || input.state === 'CLOSED') {
    return 'This period is in effect or already finished, so it is part of the record.';
  }
  return null;
}

/** Figure 11.3 - assignment lifecycle. The three terminal states stay distinct on purpose. */
const ASSIGNMENT_TRANSITIONS: Readonly<Record<AssignmentState, readonly AssignmentState[]>> = {
  ACTIVE: ['RELEASED', 'REVOKED', 'EXPIRED'],
  RELEASED: [],
  REVOKED: [],
  EXPIRED: [],
};

export const canTransitionAssignment = (from: AssignmentState, to: AssignmentState): boolean =>
  (ASSIGNMENT_TRANSITIONS[from] ?? []).includes(to);

/**
 * Calendar-month addition with end-of-month clamping, in UTC: 2026-01-31 plus 3 months is
 * 2026-04-30, not 2026-05-01. setUTCMonth() alone overflows into the next month, which
 * would silently move a period boundary. Leap days are handled by the same clamping.
 */
export function addMonths(from: Date, months: number): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + months;
  const d = from.getUTCDate();
  const lastDayOfTarget = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      y,
      m,
      Math.min(d, lastDayOfTarget),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

/**
 * The end of an allocation period of `durationMonths`, exclusive-adjusted to the last
 * instant covered. Computed once at cycle creation and persisted: a later change to
 * allocationDuration must not move the boundary of a cycle that already exists.
 */
export const periodEnd = (startsOn: Date, durationMonths: number): Date =>
  new Date(addMonths(startsOn, durationMonths).getTime() - 1000);

/**
 * Label for a period of `durationMonths` starting on `startsOn`, e.g. 2026-02-14 with a
 * 3-month duration becomes "2026-02+3M". Deliberately not a quarter label: quarters bake
 * "3 months" into the domain and into every cycle's identity, which rule A forbids. A
 * duration that divides the year evenly still reads naturally, and one that does not no
 * longer produces a label that lies.
 */
export function periodLabel(startsOn: Date, durationMonths: number): string {
  const y = startsOn.getUTCFullYear();
  const m = String(startsOn.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}+${durationMonths}M`;
}

/**
 * Which period a resident's dashboard shows as theirs, and whether they are in it.
 *
 * A period whose registration has closed comes first, but only when the resident entered
 * it: they are waiting on its draw and should be told so. Someone who did not enter has
 * nothing left to do in it, so it is not shown to them and the next period taking (or
 * about to take) entries is. Ties between several closed periods go to the first given.
 */
export function nextPeriodFor<C>(
  closed: readonly { readonly cycle: C; readonly registered: boolean }[],
  upcoming: { readonly cycle: C; readonly registered: boolean } | null,
): { cycle: C | null; registered: boolean } {
  const entered = closed.find((c) => c.registered);
  if (entered) return { cycle: entered.cycle, registered: true };
  return upcoming ?? { cycle: null, registered: false };
}
