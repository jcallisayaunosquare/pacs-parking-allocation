import type { DrawOutcome } from '../../allocation/domain/types';

/**
 * The fairness model of §12, as a pure function.
 *
 *   assigned   → score 0, misses 0, wins + 1
 *   waitlisted → score + 1, misses + 1
 *   skipped    → unchanged (FR-21): an ineligible or unregistered resident is neither
 *                rewarded nor punished for a cycle they were not part of.
 */
export interface FairnessState {
  readonly residentId: string;
  readonly score: number;
  readonly consecutiveMisses: number;
  readonly totalRegistrations: number;
  readonly totalWins: number;
  readonly lastWonCycleId: string | null;
}

export const initialFairnessState = (residentId: string): FairnessState => ({
  residentId,
  score: 0,
  consecutiveMisses: 0,
  totalRegistrations: 0,
  totalWins: 0,
  lastWonCycleId: null,
});

export function applyOutcome(
  state: FairnessState,
  outcome: DrawOutcome,
  cycleId: string,
): FairnessState {
  switch (outcome) {
    case 'ASSIGNED':
      return {
        ...state,
        score: 0,
        consecutiveMisses: 0,
        totalRegistrations: state.totalRegistrations + 1,
        totalWins: state.totalWins + 1,
        lastWonCycleId: cycleId,
      };
    case 'WAITLISTED':
      return {
        ...state,
        score: state.score + 1,
        consecutiveMisses: state.consecutiveMisses + 1,
        totalRegistrations: state.totalRegistrations + 1,
      };
    case 'SKIPPED':
      return state;
  }
}

/** Draw weight. Exposed so the API can explain the odds without duplicating the rule. */
export const drawWeight = (score: number): number => score + 1;

/**
 * One sentence a resident can read on the dashboard (§16 `fairness.explanation`).
 * The policy is deliberately explainable: "every quarter you miss, your name goes in
 * the hat one more time."
 */
export function explain(state: FairnessState, holdsSpot: boolean): string {
  if (holdsSpot) return 'You hold a spot this quarter, so your score reset to 0.';
  if (state.consecutiveMisses === 0) {
    return 'You have not missed a cycle, so your name goes in the hat once.';
  }
  const weight = drawWeight(state.score);
  const cycles = state.consecutiveMisses === 1 ? 'cycle' : 'cycles';
  return `You have missed ${state.consecutiveMisses} ${cycles}, so your name goes in the hat ${weight} times — ${weight}× the odds of someone who just won.`;
}
