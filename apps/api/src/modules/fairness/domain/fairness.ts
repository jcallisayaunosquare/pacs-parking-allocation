/**
 * The fairness model, as a pure function of stored timestamps.
 *
 * There is no score, no counter and no nightly job: waiting time is decidedAt minus the
 * anchor, computed at read time, correct even if the system was down for a month. This
 * file holds only the human-readable side of that - the sentence a resident reads and the
 * paragraph that explains a run they lost. The arithmetic itself lives in
 * allocation/domain/priority-key.ts, and is never duplicated here.
 */

/** What the dashboard knows about where a resident stands, right now. */
export interface FairnessStanding {
  readonly residentId: string;
  /** max(participationStartedAt, lastBenefitEndAt) - the instant waiting restarted. */
  readonly anchorAt: Date;
  readonly waitingHours: number;
  /** Negative exactly while the Early-Waiting Bias applies. */
  readonly effectiveWaitHours: number;
  readonly servedCount: number;
  readonly biasApplied: boolean;
  readonly firstTimeParticipant: boolean;
}

/** One candidate's stored row from a committed run - the contestable record. */
export interface RunCandidateRecord {
  readonly residentId: string;
  readonly anchorAt: Date;
  readonly rawWaitHours: number;
  readonly effectiveWaitHours: number;
  readonly servedCount: number;
  readonly biasApplied: boolean;
  readonly firstTimeParticipant: boolean;
  readonly finalRank: number;
  readonly outcome: 'ASSIGNED' | 'WAITLISTED' | 'SKIPPED';
  readonly waitlistPosition: number | null;
}

const hours = (n: number): string => `${n} ${Math.abs(n) === 1 ? 'hour' : 'hours'}`;

/**
 * One sentence a resident can read on the dashboard. The policy is deliberately
 * explainable: whoever has waited longest goes first, history breaks a tie, and the
 * raffle only decides when nothing else can.
 */
export function explainStanding(s: FairnessStanding, holdsSpot: boolean): string {
  if (holdsSpot) {
    return 'You hold a bay for this period. Your waiting time starts again when it ends.';
  }
  if (s.biasApplied) {
    return (
      `Your bay ended ${hours(s.waitingHours)} ago, so for now you rank below everyone whose ` +
      'wait is still running, including residents taking part for the first time. That ends ' +
      'as soon as the early-waiting window closes.'
    );
  }
  const served =
    s.servedCount === 0
      ? 'You have never held a bay, which breaks a tie in your favour.'
      : `You have held a bay ${s.servedCount} ${s.servedCount === 1 ? 'time' : 'times'}, which breaks a tie against you.`;
  return `You have been waiting ${hours(s.waitingHours)}. Longest wait goes first. ${served}`;
}

/**
 * Why a resident lost, generated from the stored row rather than from today's data -
 * today's data has moved. `tiedOnWait` and `tiedOnWaitAndHistory` are counted from the
 * same run's rows, so the whole paragraph is reproducible from the audit record.
 */
export function explainRunOutcome(
  row: RunCandidateRecord,
  context: { tiedOnWait: number; tiedOnWaitAndHistory: number; spots: number },
): string {
  if (row.outcome === 'SKIPPED') {
    return 'You were not in this draw, so nothing about your waiting time changed.';
  }

  const lead =
    row.effectiveWaitHours < 0
      ? `Your bay had ended ${hours(row.rawWaitHours)} before the draw, so the early-waiting ` +
        'window placed you below every resident whose wait was still running.'
      : `You had waited ${hours(row.rawWaitHours)}.`;

  const tie =
    context.tiedOnWait > 1
      ? ` ${context.tiedOnWait - 1} other ${context.tiedOnWait - 1 === 1 ? 'resident' : 'residents'} ` +
        `had waited exactly as long. Of those, you had held a bay ${row.servedCount} ` +
        `${row.servedCount === 1 ? 'time' : 'times'}.`
      : '';

  const raffle =
    context.tiedOnWaitAndHistory > 1
      ? ` ${context.tiedOnWaitAndHistory} residents were tied on waiting time and history, so the ` +
        'raffle token decided between you.'
      : '';

  const verdict =
    row.outcome === 'ASSIGNED'
      ? ` You were ranked ${row.finalRank} of the ${context.spots} ${context.spots === 1 ? 'bay' : 'bays'} available and were assigned one.`
      : ` You were ranked ${row.finalRank}, past the ${context.spots} ${context.spots === 1 ? 'bay' : 'bays'} available` +
        (row.waitlistPosition === null ? '.' : `, so you are number ${row.waitlistPosition} on the waitlist.`);

  return `${lead}${tie}${raffle}${verdict}`;
}
