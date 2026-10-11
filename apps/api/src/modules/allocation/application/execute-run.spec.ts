import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ExecuteRun } from './execute-run';
import { fixedClock, fixedSeedSource } from '../../../shared/clock';
import { RunLockHeldError } from '../../../shared/errors';
import { InMemoryCache } from '../../../shared/cache/dynamodb-cache';
import {
  DEFAULT_ALLOCATION_CONFIG,
  type AllocationConfig,
  type AllocationConfigVersion,
} from '../domain/allocation-config';
import type { CycleState } from '../domain/types';
import type { Candidate } from '../domain/priority-key';
import type {
  AllocationConfigProvider,
  AllocationRepository,
  CycleRecord,
  RunRecord,
  RunSnapshot,
} from './ports';

const CYCLE_ID = '11111111-1111-1111-1111-111111111111';
const RUN_ID = '22222222-2222-2222-2222-222222222222';
const SEED = 'a'.repeat(64);
const DECIDED_AT = new Date('2026-04-01T09:00:00Z');

const config: AllocationConfig = { ...DEFAULT_ALLOCATION_CONFIG, version: 1 };

const cycle = (state: CycleState): CycleRecord => ({
  id: CYCLE_ID,
  label: '2026-01+3M',
  startsOn: new Date('2026-04-01T00:00:00Z'),
  endsOn: new Date('2026-06-30T23:59:59Z'),
  state,
  registrationOpensAt: new Date('2026-03-01T00:00:00Z'),
  registrationClosesAt: new Date('2026-03-25T00:00:00Z'),
});

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: RUN_ID,
  cycleId: CYCLE_ID,
  state: 'RUNNING',
  randomSeedHex: SEED,
  seedCommitmentHex: createHash('sha256').update(SEED).digest('hex'),
  decidedAt: DECIDED_AT,
  configVersion: 1,
  inputHashHex: null,
  resultHashHex: null,
  algorithmVersion: 'waiting-time-fairness-v1',
  idempotencyKey: 'key-1',
  entrantsCount: 0,
  spotsCount: 0,
  assignedCount: 0,
  startedAt: new Date('2026-04-01T09:00:00Z'),
  finishedAt: null,
  errorDetail: null,
  ...over,
});

/**
 * A fake repository rather than a mock: the use-case tests assert on the state the
 * transaction would have written, which is what the section 27 unit layer is for. The real SQL
 * constraints are covered by the integration layer against a live database.
 */
class FakeRepo implements AllocationRepository {
  cycleState: CycleState = 'REGISTRATION_CLOSED';
  activeSpots = 10;
  snapshot: RunSnapshot = { candidates: [], spots: [], skipped: [] };
  replay: RunRecord | null = null;
  lockHeld = false;
  commitThrows = false;

  committed: Parameters<AllocationRepository['commitRun']>[0] | null = null;
  failedWith: string | null = null;
  emptyRunId: string | null = null;
  openCalls = 0;
  openedWith: Parameters<AllocationRepository['openRun']>[0] | null = null;

  async findCycle(): Promise<CycleRecord | null> {
    return cycle(this.cycleState);
  }
  async findRunByIdempotencyKey(): Promise<RunRecord | null> {
    return this.replay;
  }
  async findRun(): Promise<RunRecord | null> {
    return run();
  }
  async listRuns(): Promise<readonly RunRecord[]> {
    return [run()];
  }
  async openRun(input: Parameters<AllocationRepository['openRun']>[0]): Promise<RunRecord> {
    this.openCalls++;
    this.openedWith = input;
    if (this.lockHeld) throw new RunLockHeldError();
    return run({ seedCommitmentHex: input.seedCommitmentHex, configVersion: input.configVersion });
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
  /** The period in effect, when a test wants one. Null is the ordinary case. */
  periodInEffect: { id: string; label: string } | null = null;
  async findPeriodInEffect(): Promise<{ id: string; label: string } | null> {
    return this.periodInEffect;
  }
  async failStaleRuns(): Promise<number> {
    return 0;
  }
}

class FakeConfig implements AllocationConfigProvider {
  constructor(public value: AllocationConfig = config) {}
  async current(): Promise<AllocationConfig> {
    return this.value;
  }
  async atVersion(version: number): Promise<AllocationConfig | null> {
    return version === this.value.version ? this.value : null;
  }
  async insert(values: Omit<AllocationConfig, 'version'>): Promise<AllocationConfig> {
    this.value = { ...values, version: this.value.version + 1 };
    return this.value;
  }
  async history(): Promise<readonly AllocationConfigVersion[]> {
    return [{ ...this.value, changedAt: new Date('2026-01-01T00:00:00Z'), changedBy: null }];
  }
}

const build = (repo: FakeRepo, cfg: AllocationConfigProvider = new FakeConfig()) =>
  new ExecuteRun(repo, cfg, fixedClock('2026-04-01T09:00:01Z'), fixedSeedSource(SEED), new InMemoryCache());

const HOUR = 3_600_000;

/** Candidates waiting `100 - i` hours, so the order is unambiguous and easy to assert. */
const candidates = (n: number): Candidate[] =>
  Array.from({ length: n }, (_, i) => ({
    residentId: `3333${String(i).padStart(4, '0')}-3333-3333-3333-333333333333`,
    participationStartedAt: new Date(DECIDED_AT.getTime() - (100 - i) * HOUR),
    lastBenefitEndAt: null,
    lastForfeitAt: null,
    absenceResetAt: null,
    servedCount: 0,
    priorParticipations: 1,
    needsAccessibleSpot: false,
    hasElectricVehicle: false,
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
    repo.snapshot = { candidates: candidates(20), spots: spots(6), skipped: [] };
  });

  it('completes a run and writes one transaction', async () => {
    const r = await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.state).toBe('COMPLETED');
    expect(r.value.assigned).toBe(6);
    expect(r.value.waitlisted).toBe(14);
    expect(r.value.randomSeedHex).toBe(SEED);
    expect(repo.committed).not.toBeNull();
    expect(repo.committed!.assignments).toHaveLength(6);
    expect(repo.committed!.waitlist).toHaveLength(14);
    // One history row per participant, assigned or not.
    expect(repo.committed!.history).toHaveLength(20);
  });

  it('persists one priority key per candidate, ranked, so a run can be contested', async () => {
    await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });

    const rows = repo.committed!.candidates;
    expect(rows).toHaveLength(20);
    expect(rows.map((c) => c.finalRank)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // Longest wait first, and the first six rows are the ones that got a bay.
    expect(rows.slice(0, 6).every((c) => c.outcome === 'ASSIGNED')).toBe(true);
    expect(rows[0]!.effectiveWaitQuanta).toBe(100);
    expect(rows[0]!.rawWaitQuanta).toBe(100);
    expect(rows[0]!.biasApplied).toBe(false);
    // The token is a 128-bit decimal string, not a number: nothing may round here.
    expect(rows[0]!.raffleToken).toMatch(/^\d+$/);
  });

  it('stamps the config version in force and the input and result hashes', async () => {
    const r = await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.configVersion).toBe(1);
    expect(repo.openedWith!.configVersion).toBe(1);
    expect(repo.committed!.inputHashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(repo.committed!.resultHashHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('publishes a commitment to the seed before the candidate list is read', async () => {
    const r = await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(repo.openedWith!.seedCommitmentHex).toBe(
      createHash('sha256').update(SEED).digest('hex'),
    );
    expect(r.value.seedCommitmentHex).toBe(repo.openedWith!.seedCommitmentHex);
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

  /*
   * Two allocations at once is two statements about who may park in the same bays. The
   * refusal has to happen before anything is locked or written, for the same reason the
   * empty-inventory one does: a run row that exists strips first-time-participant status
   * from everyone in it (E-4).
   */
  it('refuses while another period is in effect, and writes nothing', async () => {
    repo.periodInEffect = { id: 'other', label: '2026-Q4' };
    const r = await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'k-in-effect' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INVALID_CYCLE_STATE');
      // Names the period the administrator has to close, because it is not the one they
      // are looking at.
      expect(r.error.message).toContain('2026-Q4');
    }
    expect(repo.openCalls).toBe(0);
    expect(repo.committed).toBeNull();
  });

  it('runs when nothing else is in effect', async () => {
    repo.periodInEffect = null;
    const r = await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'k-clear' });
    expect(r.ok).toBe(true);
  });

  it('refuses when the inventory is empty, so no run row is created at all', async () => {
    repo.activeSpots = 0;
    const r = await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NO_SPOTS_AVAILABLE');
    expect(repo.openCalls).toBe(0);
    expect(repo.committed).toBeNull();
  });

  it('ends COMPLETED_EMPTY when nobody registered', async () => {
    repo.snapshot = { candidates: [], spots: spots(5), skipped: [] };
    const r = await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe('COMPLETED_EMPTY');
    expect(repo.emptyRunId).not.toBeNull();
    expect(repo.committed).toBeNull();
  });

  it('records excluded registrants as SKIPPED with no key row of their own', async () => {
    const skipped = '5555ffff-5555-5555-5555-555555555555';
    repo.snapshot = {
      candidates: candidates(4),
      spots: spots(2),
      skipped: [{ residentId: skipped, reason: 'ADMIN_ACCOUNT' }],
    };

    const r = await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });
    expect(r.ok).toBe(true);

    const rows = repo.committed!.history.filter((h) => h.result === 'SKIPPED');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.residentId).toBe(skipped);
    // A skipped resident has no priority key: their anchor was not even consulted.
    expect(repo.committed!.candidates.some((c) => c.residentId === skipped)).toBe(false);
  });

  it('marks the run FAILED and reports an opaque error when the transaction blows up', async () => {
    repo.commitThrows = true;
    const r = await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INTERNAL_ERROR');
    expect(repo.failedWith).toContain('unique constraint');
    // The caller never sees the database text (section 16).
    expect(r.error.message).not.toContain('unique constraint');
  });

  it('caps the bays offered at the configured totalBays', async () => {
    repo.snapshot = { candidates: candidates(10), spots: spots(6), skipped: [] };
    const cfg = new FakeConfig({ ...config, totalBays: 2 });

    const r = await build(repo, cfg).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.assigned).toBe(2);
    expect(repo.committed!.assignments.map((a) => a.spotId)).toEqual([
      spots(6)[0]!.spotId,
      spots(6)[1]!.spotId,
    ]);
  });

  it('emits one AllocationCompleted event plus one per outcome', async () => {
    repo.snapshot = { candidates: candidates(5), spots: spots(2), skipped: [] };
    await build(repo).execute({ cycleId: CYCLE_ID, idempotencyKey: 'key-1' });

    const events = repo.committed!.events;
    expect(events.filter((e) => e.eventType === 'AllocationCompleted')).toHaveLength(1);
    expect(events.filter((e) => e.eventType === 'SpotAssigned')).toHaveLength(2);
    expect(events.filter((e) => e.eventType === 'ResidentWaitlisted')).toHaveLength(3);
  });

  it('is reproducible: the same seed and inputs produce the same winners and the same hash', async () => {
    const a = new FakeRepo();
    a.snapshot = { candidates: candidates(30), spots: spots(7), skipped: [] };
    const b = new FakeRepo();
    // The same candidates, in the opposite order: a replay must not depend on the order
    // the snapshot query happened to return.
    b.snapshot = { candidates: [...candidates(30)].reverse(), spots: spots(7), skipped: [] };

    await build(a).execute({ cycleId: CYCLE_ID, idempotencyKey: 'k' });
    await build(b).execute({ cycleId: CYCLE_ID, idempotencyKey: 'k' });

    expect(a.committed!.assignments).toEqual(b.committed!.assignments);
    expect(a.committed!.inputHashHex).toEqual(b.committed!.inputHashHex);
    expect(a.committed!.resultHashHex).toEqual(b.committed!.resultHashHex);
  });
});
