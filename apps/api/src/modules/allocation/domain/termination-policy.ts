import type { TerminationReason } from './types';

/**
 * One column decides everything the ranking query needs to know about a finished
 * assignment: counts_as_served. It is written once, when the assignment terminates, by
 * this pure policy, so the hot query filters on a boolean and never reasons about reason
 * codes - and so the rules below are testable in isolation.
 */
export interface Termination {
  /** The instant the benefit actually stopped. Materialised, never derived in a query. */
  readonly benefitEndedAt: Date;
  /** True when the resident consumed an allocation: the anchor moves and h(r) increments. */
  readonly countsAsServed: boolean;
  readonly reason: TerminationReason;
  /** The administrator's explicit choice to make a resident whole after a system error. */
  readonly makeWhole: boolean;
}

const MS_PER_HOUR = 3_600_000;

/**
 * The rules, each a deliberate decision:
 *
 *   EXPIRED   - the normal path. Served; the benefit ended when the period did.
 *   RELEASED  - served, from the moment benefit actually ended. A resident who gives a
 *               bay back on day 1 of 90 starts accruing on day 1, so parking days are
 *               traded for waiting days one for one. The brake on serial early release is
 *               h(r), which increments anyway.
 *   REVOKED   - served. The resident held and consumed the bay and lost it through their
 *               own conduct; not resetting would reward misconduct with priority.
 *   DECLINED  - inside the grace window, nothing was consumed, so the anchor is untouched.
 *               Penalising a free decline would make residents accept bays they cannot
 *               use, and an empty bay nobody may use is worse for everyone. After the
 *               window it is an early release.
 *   CANCELLED - the system's mistake (admin error, building works). Not served when the
 *               administrator marks it make-whole, so our error does not cost the
 *               resident their place in the queue.
 */
export function terminationPolicy(input: {
  reason: TerminationReason;
  at: Date;
  validFrom: Date;
  declineGraceHours: number;
  makeWhole?: boolean;
}): Termination {
  const { reason, at, validFrom, declineGraceHours } = input;
  const makeWhole = input.makeWhole ?? false;

  const withinGrace = at.getTime() - validFrom.getTime() < declineGraceHours * MS_PER_HOUR;

  const countsAsServed =
    reason === 'DECLINED' ? !withinGrace : reason === 'CANCELLED' ? !makeWhole : true;

  return { benefitEndedAt: at, countsAsServed, reason, makeWhole };
}
