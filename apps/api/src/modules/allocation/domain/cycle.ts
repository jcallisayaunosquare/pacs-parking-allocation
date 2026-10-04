import type { AssignmentState, CycleState } from './types';

/** Figure 11.2 — the only legal cycle transitions. Anything else is 422. */
const CYCLE_TRANSITIONS: Readonly<Record<CycleState, readonly CycleState[]>> = {
  DRAFT: ['REGISTRATION_OPEN'],
  REGISTRATION_OPEN: ['REGISTRATION_CLOSED'],
  // REGISTRATION_CLOSED → itself is a failed run: a retry is allowed (§12).
  REGISTRATION_CLOSED: ['ACTIVE', 'REGISTRATION_CLOSED'],
  ACTIVE: ['CLOSED'],
  CLOSED: [],
};

export const canTransitionCycle = (from: CycleState, to: CycleState): boolean =>
  (CYCLE_TRANSITIONS[from] ?? []).includes(to);

/** The only state a run may start from (§11, note on Figure 11.2). */
export const isRunnable = (state: CycleState): boolean => state === 'REGISTRATION_CLOSED';

export const isRegistrationOpen = (state: CycleState): boolean => state === 'REGISTRATION_OPEN';

/** Figure 11.3 — assignment lifecycle. The three terminal states stay distinct on purpose. */
const ASSIGNMENT_TRANSITIONS: Readonly<Record<AssignmentState, readonly AssignmentState[]>> = {
  ACTIVE: ['RELEASED', 'REVOKED', 'EXPIRED'],
  RELEASED: [],
  REVOKED: [],
  EXPIRED: [],
};

export const canTransitionAssignment = (from: AssignmentState, to: AssignmentState): boolean =>
  (ASSIGNMENT_TRANSITIONS[from] ?? []).includes(to);

/** Quarter label for a start date, e.g. 2026-02-14 → "2026-Q1". */
export function quarterLabel(startsOn: Date): string {
  const q = Math.floor(startsOn.getUTCMonth() / 3) + 1;
  return `${startsOn.getUTCFullYear()}-Q${q}`;
}
