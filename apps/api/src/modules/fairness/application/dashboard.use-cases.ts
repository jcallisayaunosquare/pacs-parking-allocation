import { ok, type Result } from '../../../shared/result';
import { fail } from '../../../shared/errors';
import type { Clock } from '../../../shared/clock';
import type { AssignmentRepository, CachePort, CycleRepository } from '../../allocation/application/ports';
import type { ResidentRepository } from '../../residents/application/resident.use-cases';
import { drawWeight, explain, type FairnessState } from '../domain/fairness';

export interface HistoryEntry {
  readonly cycle: string;
  readonly result: 'ASSIGNED' | 'WAITLISTED' | 'SKIPPED';
  readonly spotCode: string | null;
  readonly position: number | null;
  readonly scoreAtDraw: number;
  readonly recordedAt: string;
}

export interface FairnessReadModel {
  getState(residentId: string): Promise<FairnessState | null>;
  getHistory(residentId: string, limit: number): Promise<readonly HistoryEntry[]>;
  getWaitlistPosition(residentId: string): Promise<{ cycleId: string; position: number } | null>;
  /** FR-22 — admin fairness dashboard. */
  getMetrics(): Promise<{
    residents: number;
    averageScore: number;
    maxScore: number;
    neverWon: number;
    distribution: readonly { score: number; residents: number }[];
  }>;
  getRunAssignments(runId: string): Promise<readonly { residentId: string; fullName: string; spotCode: string }[]>;
  getQuarterlyReport(cycleId: string): Promise<readonly {
    residentId: string;
    fullName: string;
    unitNumber: string;
    result: string;
    spotCode: string | null;
    position: number | null;
    scoreAtDraw: number;
  }[]>;
}

const DASHBOARD_TTL = 300; // §16: cached 5 min
const METRICS_TTL = 600; // §16: cached 10 min

export class DashboardUseCases {
  constructor(
    private readonly residents: ResidentRepository,
    private readonly assignments: AssignmentRepository,
    private readonly cycles: CycleRepository,
    private readonly read: FairnessReadModel,
    private readonly cache: CachePort,
    private readonly clock: Clock,
  ) {}

  /** UC-09 — the most frequent query in the system, so it is read-through cached. */
  async dashboard(residentId: string): Promise<Result<unknown>> {
    const key = `dashboard:${residentId}`;
    const cached = await this.cache.get<unknown>(key).catch(() => null);
    if (cached) return ok(cached);

    const resident = await this.residents.findById(residentId);
    if (!resident) return fail('NOT_FOUND', 'Resident not found.');

    const [assignment, fairness, history, waitlist, nextCycle] = await Promise.all([
      this.assignments.findActiveForResident(residentId),
      this.read.getState(residentId),
      this.read.getHistory(residentId, 5),
      this.read.getWaitlistPosition(residentId),
      this.cycles.findUpcoming(this.clock.now()),
    ]);

    const state: FairnessState = fairness ?? {
      residentId,
      score: 0,
      consecutiveMisses: 0,
      totalRegistrations: 0,
      totalWins: 0,
      lastWonCycleId: null,
    };

    const payload = {
      resident: {
        id: resident.id,
        fullName: resident.fullName,
        unit: resident.unitNumber,
        isEligible: resident.isEligible,
      },
      assignment: assignment
        ? {
            spotCode: assignment.spotCode,
            level: assignment.level,
            type: assignment.type,
            validFrom: assignment.validFrom.toISOString(),
            validUntil: assignment.validUntil.toISOString(),
            state: assignment.state,
          }
        : null,
      waitlist: waitlist ? { position: waitlist.position } : null,
      fairness: {
        score: state.score,
        consecutiveMisses: state.consecutiveMisses,
        totalWins: state.totalWins,
        drawWeight: drawWeight(state.score),
        explanation: explain(state, assignment !== null),
      },
      nextCycle: nextCycle
        ? {
            id: nextCycle.id,
            label: nextCycle.label,
            state: nextCycle.state,
            registrationOpensAt: nextCycle.registrationOpensAt.toISOString(),
            registrationClosesAt: nextCycle.registrationClosesAt.toISOString(),
          }
        : null,
      recentHistory: history,
    };

    await this.cache.set(key, payload, DASHBOARD_TTL).catch(() => undefined);
    return ok(payload);
  }

  /** UC-10 — own history, newest first. */
  async history(residentId: string, limit: number): Promise<Result<readonly HistoryEntry[]>> {
    return ok(await this.read.getHistory(residentId, limit));
  }

  async metrics(): Promise<Result<unknown>> {
    const key = 'fairness:metrics';
    const cached = await this.cache.get<unknown>(key).catch(() => null);
    if (cached) return ok(cached);
    const m = await this.read.getMetrics();
    await this.cache.set(key, m, METRICS_TTL).catch(() => undefined);
    return ok(m);
  }

  async runAssignments(runId: string) {
    return ok(await this.read.getRunAssignments(runId));
  }

  async quarterlyReport(cycleId: string) {
    return ok(await this.read.getQuarterlyReport(cycleId));
  }
}
