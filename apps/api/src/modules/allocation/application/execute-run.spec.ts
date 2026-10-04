import { beforeEach, describe, expect, it } from 'vitest';
import { ExecuteRun } from './execute-run';
import { WeightedLotteryDraw } from '../domain/weighted-lottery-draw';
import { fixedClock, fixedSeedSource } from '../../../shared/clock';
import { RunLockHeldError } from '../../../shared/errors';
import { InMemoryCache } from '../../../shared/cache/dynamodb-cache';
import type { CycleState } from '../domain/types';
import type { AllocationRepository, CycleRecord, RunRecord, RunSnapshot } from './ports';

const CYCLE_ID = '11111111-1111-1111-1111-111111111111';

const cycle = (state: CycleState): CycleRecord => ({
  id: CYCLE_ID,
  label: '2026-Q1',
  startsOn: new Date('2026-01-01T00:00:00Z'),
  endsOn: new Date('2026-03-31T23:59:59Z'),
  state,
  registrationOpensAt: new Date('2025-12-01T00:00:00Z'),
  registrationClosesAt: new Date('2025-12-25T00:00:00Z'),
});

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: '22222222-2222-2222-2222-222222222222',
  cycleId: CYCLE_ID,
  state: 'RUNNING',
  randomSeed: 42n,
  algorithmVersion: 'weighted-lottery-v1',
  idempotencyKey: 'key-1',
  entrantsCount: 0,
  spotsCount: 0,
  assignedCount: 0,
  startedAt: new Date('2026-01-01T06:00:00Z'),
  finishedAt: null,
  errorDetail: null,
  ...over,
});

/**
 * A fake repository rather than a mock: the use-case tests assert on the state the
 * transaction would have written, which is what the §27 unit layer is for. The real
 * SQL constraints are covered by the integration layer against a live database.
 */
class FakeRepo implements AllocationRepository {
  cycleState: CycleState = 'REGISTRATION_CLOSED';
  activeSpots = 10;
  snapshot: RunSnapshot = { entrants: [], spots: [], skippedResidentIds: [] };
  replay: RunRecord | null = null;
  lockHeld = false;
  commitThrows = false;

  committed: Parameters<AllocationRepository['commitRun']>[0] | null = null;
  failedWith: string | null = null;
  emptyRunId: string | null = null;
  openCalls = 0;

  async findCycle(): Promise<CycleRecord | null> {
    return cycle(this.cycleState);
  }
  async findRunByIdempotencyKey(): Promise<RunRecord | null> {
    return this.replay;
  }
  async findRun(): Promise<RunRecord | null> {
    return run();
  }
  async openRun(): Promise<RunRecord> {
    this.openCalls++;
    if (this.lockHeld) throw new RunLockHeldError();
    return run();
  }
  async snapshotInputs(): Promise<RunSnapshot> {
    return this.snapshot;
  }
  async commitRun(input: Parameters<AllocationRepository['commitRun']>[0]): Promise<void> {
    if (this.commitThrows) throw new Error('duplicate key value violates unique constraint');
    this.committed = input;
  }
  async markRunFailed(_runId: string, detail: string): Promise<void> {
    this.failedWith = detail;
  }
  async markRunCompletedEmpty(runId: string): Promise<void> {
    this.emptyRunId = runId;
  }
  async countActiveSpots(): Promise<number> {
    return this.activeSpots;
  }
  async failStaleRuns(): Promise<number> {
    return 0;
  }
}

const build = (repo: FakeRepo) =>
  new ExecuteRun(
    repo,
    new WeightedLotteryDraw(),
    fixedClock('2026-01-01T06:00:01Z'),
    fixedSeedSource(42n),
    new InMemoryCache(),
  );

const entrants = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    residentId: `3333${String(i).padStart(4, '0')}-3333-3333-3333-333333333333`,
    fairnessScore: i % 4,
    needsAccessibleSpot: false,
  }));

const spots = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    spotId: `4444${String(i).padStart(4, '0')}-4444-4444-4444-444444444444`,
    spotCode: `B1-${String(i).padStart(2, '0')}`,
    type: 'STANDARD' as const,
  }));

describe('ExecuteRun', () => {
  let repo: FakeRepo;

  beforeEach(() => {
    repo = new FakeRepo();
    repo.snapshot = { entrants: entrants(20), spots: spots(6), skippedResidentIds: [] };
  });

  it('completes a run and writes one transaction', async () => {
    const r = await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.state).toBe('COMPLETED');
    expect(r.value.assigned).toBe(6);
    expect(r.value.waitlisted).toBe(14);
    expect(r.value.randomSeed).toBe(42);
    expect(repo.committed).not.toBeNull();
    expect(repo.committed!.assignments).toHaveLength(6);
    expect(repo.committed!.waitlist).toHaveLength(14);
    // One history row per participant, assigned or not.
    expect(repo.committed!.history).toHaveLength(20);
  });

  it('replays a previous result for the same idempotency key without re-drawing', async () => {
    repo.replay = run({ state: 'COMPLETED', entrantsCount: 20, assignedCount: 6 });
    const r = await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });

    expect(r.ok).toBe(true);
    expect(repo.openCalls).toBe(0);
    expect(repo.committed).toBeNull();
  });

  it('returns 409 RAFFLE_IN_PROGRESS when the lock is held', async () => {
    repo.lockHeld = true;
    const r = await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('RAFFLE_IN_PROGRESS');
  });

  it('refuses a cycle that is not REGISTRATION_CLOSED', async () => {
    for (const state of ['DRAFT', 'REGISTRATION_OPEN', 'ACTIVE', 'CLOSED'] as CycleState[]) {
      repo.cycleState = state;
      const r = await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: `k-${state}` });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.code).toBe('INVALID_CYCLE_STATE');
    }
    // Nothing was locked or written.
    expect(repo.openCalls).toBe(0);
    expect(repo.committed).toBeNull();
  });

  it('refuses when the inventory is empty, so scores are not penalised', async () => {
    repo.activeSpots = 0;
    const r = await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NO_SPOTS_AVAILABLE');
    expect(repo.committed).toBeNull();
  });

  it('ends COMPLETED_EMPTY with no fairness change when nobody registered', async () => {
    repo.snapshot = { entrants: [], spots: spots(5), skippedResidentIds: [] };
    const r = await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe('COMPLETED_EMPTY');
    expect(repo.emptyRunId).not.toBeNull();
    expect(repo.committed).toBeNull();
  });

  it('records ineligible registrants as SKIPPED and leaves their score alone', async () => {
    const skipped = '5555ffff-5555-5555-5555-555555555555';
    repo.snapshot = { entrants: entrants(4), spots: spots(2), skippedResidentIds: [skipped] };

    const r = await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });
    expect(r.ok).toBe(true);

    const rows = repo.committed!.history.filter((h) => h.result === 'SKIPPED');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.residentId).toBe(skipped);
    // Skipped residents get no fairness row, so nothing is written for them.
    expect(repo.committed!.fairness.some((f) => f.residentId === skipped)).toBe(false);
  });

  it('marks the run FAILED and reports an opaque error when the transaction blows up', async () => {
    repo.commitThrows = true;
    const r = await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INTERNAL_ERROR');
    expect(repo.failedWith).toContain('unique constraint');
    // The caller never sees the database text (§16).
    expect(r.error.message).not.toContain('unique constraint');
  });

  it('resets the score of a winner and increments a loser (§12)', async () => {
    repo.snapshot = { entrants: entrants(4), spots: spots(1), skippedResidentIds: [] };
    await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });

    const winners = repo.committed!.fairness.filter((f) => f.totalWins === 1);
    const losers = repo.committed!.fairness.filter((f) => f.totalWins === 0);

    expect(winners).toHaveLength(1);
    expect(winners[0]!.score).toBe(0);
    expect(winners[0]!.consecutiveMisses).toBe(0);
    expect(losers).toHaveLength(3);
    for (const l of losers) expect(l.consecutiveMisses).toBe(1);
  });

  it('emits one AllocationCompleted event plus one per outcome', async () => {
    repo.snapshot = { entrants: entrants(5), spots: spots(2), skippedResidentIds: [] };
    await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });

    const events = repo.committed!.events;
    expect(events.filter((e) => e.eventType === 'AllocationCompleted')).toHaveLength(1);
    expect(events.filter((e) => e.eventType === 'SpotAssigned')).toHaveLength(2);
    expect(events.filter((e) => e.eventType === 'ResidentWaitlisted')).toHaveLength(3);
  });

  it('is reproducible: the same seed produces the same winners', async () => {
    const a = new FakeRepo();
    a.snapshot = { entrants: entrants(30), spots: spots(7), skippedResidentIds: [] };
    const b = new FakeRepo();
    b.snapshot = { entrants: entrants(30), spots: spots(7), skippedResidentIds: [] };

    await build(a).execute({ cycleId: CYCLE_ID, idempotencyKey: 'k' });
    await build(b).execute({ cycleId: CYCLE_ID, idempotencyKey: 'k' });

    expect(a.committed!.assignments).toEqual(b.committed!.assignments);
  });
});
