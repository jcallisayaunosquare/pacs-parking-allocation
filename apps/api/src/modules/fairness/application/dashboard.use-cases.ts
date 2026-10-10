import { ok, type Result } from '../../../shared/result';
import { fail } from '../../../shared/errors';
import { toDateOnly, type Clock } from '../../../shared/clock';
import type {
  AllocationConfigProvider,
  AssignmentRepository,
  CachePort,
  CycleRepository,
  RegistrationRepository,
} from '../../allocation/application/ports';
import { computePriorityKey, quantaToHours, type Candidate } from '../../allocation/domain/priority-key';
import type { ResidentRepository } from '../../residents/application/resident.use-cases';
import { explainRunOutcome, explainStanding, type FairnessStanding } from '../domain/fairness';

export interface HistoryEntry {
  readonly cycle: string;
  readonly result: 'ASSIGNED' | 'WAITLISTED' | 'SKIPPED';
  readonly spotCode: string | null;
  readonly position: number | null;
  /** The key as it stood in that run, from the stored row - not recomputed from today. */
  readonly effectiveWaitHours: number | null;
  readonly servedCountAtDraw: number | null;
  readonly biasApplied: boolean | null;
  readonly finalRank: number | null;
  readonly recordedAt: string;
}

/** The facts a priority key is computed from. The read model never computes the key. */
export interface FairnessFacts {
  readonly participationStartedAt: Date;
  readonly lastBenefitEndAt: Date | null;
  readonly servedCount: number;
  readonly priorParticipations: number;
}

export interface RunCandidateRowRaw {
  readonly residentId: string;
  readonly unitNumber: string;
  readonly anchorAt: Date;
  readonly rawWaitQuanta: number;
  readonly effectiveWaitQuanta: number;
  readonly biasApplied: boolean;
  readonly firstTime: boolean;
  readonly servedCount: number;
  readonly raffleToken: string;
  readonly finalRank: number;
  readonly pool: string | null;
  readonly outcome: 'ASSIGNED' | 'WAITLISTED' | 'SKIPPED';
  readonly spotCode: string | null;
}

export interface FairnessReadModel {
  getFacts(residentId: string): Promise<FairnessFacts | null>;
  getHistory(residentId: string, limit: number): Promise<readonly HistoryEntry[]>;
  getWaitlistPosition(residentId: string): Promise<{ cycleId: string; position: number } | null>;
  /** FR-22 - admin fairness dashboard. */
  getMetrics(now: Date): Promise<{
    residents: number;
    averageWaitHours: number;
    maxWaitHours: number;
    neverServed: number;
    distribution: readonly { servedCount: number; residents: number }[];
  }>;
  getRunAssignments(runId: string): Promise<readonly { residentId: string; fullName: string; spotCode: string }[]>;
  getPeriodReport(cycleId: string): Promise<readonly {
    residentId: string;
    fullName: string;
    unitNumber: string;
    result: string;
    spotCode: string | null;
    position: number | null;
    effectiveWaitHours: number | null;
    servedCountAtDraw: number | null;
  }[]>;
  /** The contestable record for one run, in final rank order. */
  getRunCandidates(runId: string): Promise<readonly RunCandidateRowRaw[]>;
}

const DASHBOARD_TTL = 300; // section 16: cached 5 min
const METRICS_TTL = 600; // section 16: cached 10 min

export class DashboardUseCases {
  constructor(
    private readonly residents: ResidentRepository,
    private readonly assignments: AssignmentRepository,
    private readonly cycles: CycleRepository,
    private readonly read: FairnessReadModel,
    private readonly config: AllocationConfigProvider,
    private readonly cache: CachePort,
    private readonly clock: Clock,
    /**
     * Whether this resident is already in the coming draw.
     *
     * The screen cannot derive it: an entry is a row, not a consequence of anything
     * else on the payload. Without it the front end kept the fact client-side, so
     * entering the draw and then reloading showed the entry gone — and a resident who
     * believes they are entered when they are not loses a period.
     */
    private readonly registrations: RegistrationRepository,
  ) {}

  /**
   * UC-09 - the most frequent query in the system, so it is read-through cached.
   *
   * The payload carries `anchorAt`, which is the durable fact; the hour counts are a
   * rendering of it at the instant the payload was built. That is deliberate: a cached
   * waiting-time *number* is a stored counter wearing a disguise, and rule C forbids one.
   * At a 60-minute quantum a 5-minute-old rendering is almost always the same number, and
   * a cache outage degrades latency rather than fairness.
   */
  async dashboard(residentId: string): Promise<Result<unknown>> {
    const key = `dashboard:${residentId}`;
    const cached = await this.cache.get<unknown>(key).catch(() => null);
    if (cached) return ok(cached);

    const resident = await this.residents.findById(residentId);
    if (!resident) return fail('NOT_FOUND', 'Resident not found.');

    const [assignment, facts, history, waitlist, nextCycle, config] = await Promise.all([
      this.assignments.findActiveForResident(residentId),
      this.read.getFacts(residentId),
      this.read.getHistory(residentId, 5),
      this.read.getWaitlistPosition(residentId),
      this.cycles.findUpcoming(this.clock.now()),
      this.config.current(),
    ]);

    // Second round trip, because it needs the cycle the first one found.
    const registeredForNextCycle = nextCycle
      ? await this.registrations.isRegistered(nextCycle.id, residentId)
      : false;

    const standing = this.standing(residentId, facts, resident.participationStartedAt, config);

    const payload = {
      resident: {
        id: resident.id,
        fullName: resident.fullName,
        unit: resident.unitNumber,
        isEligible: resident.isEligible,
        isAdmin: resident.isAdmin,
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
        anchorAt: standing.anchorAt.toISOString(),
        waitingHours: standing.waitingHours,
        effectiveWaitHours: standing.effectiveWaitHours,
        servedCount: standing.servedCount,
        biasApplied: standing.biasApplied,
        firstTimeParticipant: standing.firstTimeParticipant,
        explanation: explainStanding(standing, assignment !== null),
      },
      policy: {
        allocationDurationMonths: config.allocationDurationMonths,
        earlyWaitingBiasHours: config.earlyWaitingBiasHours,
        waitQuantumMinutes: config.waitQuantumMinutes,
        configVersion: config.version,
      },
      // The whole Cycle, not a subset. The contract types this field as Cycle (section 16),
      // and startsOn/endsOn were missing - so the client built `new Date(undefined)`,
      // and the dashboard timeline died on an Invalid Date rather than on anything that
      // pointed back here.
      nextCycle: nextCycle
        ? {
            id: nextCycle.id,
            label: nextCycle.label,
            state: nextCycle.state,
            startsOn: toDateOnly(nextCycle.startsOn),
            endsOn: toDateOnly(nextCycle.endsOn),
            registrationOpensAt: nextCycle.registrationOpensAt.toISOString(),
            registrationClosesAt: nextCycle.registrationClosesAt.toISOString(),
          }
        : null,
      registeredForNextCycle,
      recentHistory: history,
    };

    await this.cache.set(key, payload, DASHBOARD_TTL).catch(() => undefined);
    return ok(payload);
  }

  /** UC-10 - own history, newest first. */
  async history(residentId: string, limit: number): Promise<Result<readonly HistoryEntry[]>> {
    return ok(await this.read.getHistory(residentId, limit));
  }

  async metrics(): Promise<Result<unknown>> {
    const key = 'fairness:metrics';
    const cached = await this.cache.get<unknown>(key).catch(() => null);
    if (cached) return ok(cached);
    const m = await this.read.getMetrics(this.clock.now());
    await this.cache.set(key, m, METRICS_TTL).catch(() => undefined);
    return ok(m);
  }

  async runAssignments(runId: string) {
    return ok(await this.read.getRunAssignments(runId));
  }

  async periodReport(cycleId: string) {
    return ok(await this.read.getPeriodReport(cycleId));
  }

  /**
   * The run explanation: every candidate, their key, their rank and their outcome, plus a
   * plain-English verdict per row generated from the stored numbers. The tie counts are
   * taken from the same run's rows, so the whole page is reproducible from the audit
   * record and nothing is recomputed against data that has since moved.
   */
  async runExplanation(
    runId: string,
    configVersion: number,
    /** Bays actually filled by the run: the cut line every rank is read against. */
    spots: number,
  ): Promise<Result<unknown>> {
    const rows = await this.read.getRunCandidates(runId);
    if (rows.length === 0) return fail('NOT_FOUND', 'No candidate record for that run.');

    const config = (await this.config.atVersion(configVersion)) ?? (await this.config.current());
    const toHours = (q: number): number => quantaToHours(q, config);

    const items = rows.map((r) => {
      const tiedOnWait = rows.filter((o) => o.effectiveWaitQuanta === r.effectiveWaitQuanta).length;
      const tiedOnWaitAndHistory = rows.filter(
        (o) => o.effectiveWaitQuanta === r.effectiveWaitQuanta && o.servedCount === r.servedCount,
      ).length;

      return {
        residentId: r.residentId,
        unit: r.unitNumber,
        anchorAt: r.anchorAt.toISOString(),
        waitHours: toHours(r.rawWaitQuanta),
        effectiveWaitHours: toHours(r.effectiveWaitQuanta),
        biasApplied: r.biasApplied,
        firstTimeParticipant: r.firstTime,
        servedCount: r.servedCount,
        raffleToken: r.raffleToken,
        rank: r.finalRank,
        pool: r.pool,
        outcome: r.outcome,
        spotCode: r.spotCode,
        decidedBy: r.biasApplied
          ? 'EARLY_WAITING_BIAS'
          : tiedOnWaitAndHistory > 1
            ? 'RAFFLE'
            : tiedOnWait > 1
              ? 'ALLOCATION_HISTORY'
              : 'WAITING_TIME',
        explanation: explainRunOutcome(
          {
            residentId: r.residentId,
            anchorAt: r.anchorAt,
            rawWaitHours: toHours(r.rawWaitQuanta),
            effectiveWaitHours: toHours(r.effectiveWaitQuanta),
            servedCount: r.servedCount,
            biasApplied: r.biasApplied,
            firstTimeParticipant: r.firstTime,
            finalRank: r.finalRank,
            outcome: r.outcome,
            waitlistPosition: r.outcome === 'WAITLISTED' ? r.finalRank - spots : null,
          },
          { tiedOnWait, tiedOnWaitAndHistory, spots },
        ),
      };
    });

    return ok({
      runId,
      configVersion: config.version,
      policy: {
        earlyWaitingBiasHours: config.earlyWaitingBiasHours,
        waitQuantumMinutes: config.waitQuantumMinutes,
        allocationDurationMonths: config.allocationDurationMonths,
      },
      ordering: 'effectiveWait DESC, servedCount ASC, raffleToken ASC, residentId ASC',
      tokenRecipe: 'sha256("<seed>:<runId>:<residentId>"), first 16 bytes, big-endian',
      items,
    });
  }

  /**
   * Where a resident stands, right now, through the same pure function the run uses. The
   * seed and run id are empty because the token is irrelevant outside a run - and showing
   * a token before the run would leak the tie-break.
   */
  private standing(
    residentId: string,
    facts: FairnessFacts | null,
    participationStartedAt: Date,
    config: Parameters<typeof computePriorityKey>[1],
  ): FairnessStanding {
    const candidate: Candidate = {
      residentId,
      participationStartedAt: facts?.participationStartedAt ?? participationStartedAt,
      lastBenefitEndAt: facts?.lastBenefitEndAt ?? null,
      servedCount: facts?.servedCount ?? 0,
      priorParticipations: facts?.priorParticipations ?? 0,
      needsAccessibleSpot: false,
      hasElectricVehicle: false,
    };
    const key = computePriorityKey(candidate, config, this.clock.now(), '', '');
    return {
      residentId,
      anchorAt: key.anchorAt,
      waitingHours: quantaToHours(key.rawWaitQuanta, config),
      effectiveWaitHours: quantaToHours(key.effectiveWaitQuanta, config),
      servedCount: key.servedCount,
      biasApplied: key.biasApplied,
      firstTimeParticipant: key.firstTimeParticipant,
    };
  }
}
