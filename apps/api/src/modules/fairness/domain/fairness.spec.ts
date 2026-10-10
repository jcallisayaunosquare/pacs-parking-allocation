import { describe, expect, it } from 'vitest';
import { bayStatus } from '../../allocation/domain/types';
import {
  explainRunOutcome,
  explainStanding,
  type FairnessStanding,
  type RunCandidateRecord,
} from './fairness';

const standing = (over: Partial<FairnessStanding> = {}): FairnessStanding => ({
  residentId: 'r1',
  anchorAt: new Date('2026-01-01T09:00:00Z'),
  waitingHours: 2160,
  effectiveWaitHours: 2160,
  servedCount: 1,
  biasApplied: false,
  firstTimeParticipant: false,
  ...over,
});

const row = (over: Partial<RunCandidateRecord> = {}): RunCandidateRecord => ({
  residentId: 'r1',
  anchorAt: new Date('2026-01-01T09:00:00Z'),
  rawWaitHours: 2160,
  effectiveWaitHours: 2160,
  servedCount: 2,
  biasApplied: false,
  firstTimeParticipant: false,
  finalRank: 4,
  outcome: 'WAITLISTED',
  waitlistPosition: 1,
  ...over,
});

describe('explainStanding', () => {
  it('tells a holder their waiting time restarts when the period ends', () => {
    expect(explainStanding(standing(), true)).toMatch(/starts again/);
  });

  it('quotes the accrued waiting time and what breaks a tie', () => {
    const s = explainStanding(standing({ servedCount: 0 }), false);
    expect(s).toContain('2160 hours');
    expect(s).toContain('never held a bay');
  });

  it('says plainly why a resident is below everyone during the early-waiting window', () => {
    const s = explainStanding(standing({ waitingHours: 7, effectiveWaitHours: -17, biasApplied: true }), false);
    expect(s).toContain('7 hours ago');
    expect(s).toContain('first time');
  });
});

describe('explainRunOutcome', () => {
  it('names the raffle only when the raffle actually decided', () => {
    const withRaffle = explainRunOutcome(row(), { tiedOnWait: 3, tiedOnWaitAndHistory: 2, spots: 3 });
    expect(withRaffle).toContain('raffle token decided');
    expect(withRaffle).toContain('2 other residents');
    expect(withRaffle).toContain('number 1 on the waitlist');

    const noTie = explainRunOutcome(row(), { tiedOnWait: 1, tiedOnWaitAndHistory: 1, spots: 3 });
    expect(noTie).not.toContain('raffle');
  });

  it('explains a win', () => {
    const s = explainRunOutcome(row({ outcome: 'ASSIGNED', finalRank: 1, waitlistPosition: null }), {
      tiedOnWait: 1,
      tiedOnWaitAndHistory: 1,
      spots: 3,
    });
    expect(s).toContain('were assigned one');
  });

  it('explains the Early-Waiting Bias from the stored negative key', () => {
    const s = explainRunOutcome(
      row({ rawWaitHours: 7, effectiveWaitHours: -17, biasApplied: true, finalRank: 8 }),
      { tiedOnWait: 1, tiedOnWaitAndHistory: 1, spots: 3 },
    );
    expect(s).toContain('early-waiting window');
  });

  it('says nothing changed for a resident who was not in the draw', () => {
    expect(explainRunOutcome(row({ outcome: 'SKIPPED' }), { tiedOnWait: 1, tiedOnWaitAndHistory: 1, spots: 3 })).toMatch(
      /not in this draw/,
    );
  });
});

describe('bayStatus', () => {
  it('derives the three states and offers no fourth', () => {
    expect(bayStatus({ isActive: false, hasActiveAssignment: false })).toBe('OUT_OF_SERVICE');
    expect(bayStatus({ isActive: false, hasActiveAssignment: true })).toBe('OUT_OF_SERVICE');
    expect(bayStatus({ isActive: true, hasActiveAssignment: true })).toBe('HELD');
    expect(bayStatus({ isActive: true, hasActiveAssignment: false })).toBe('FREE');
  });
});
