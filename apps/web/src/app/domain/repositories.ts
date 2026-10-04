import type {
  Cycle,
  Dashboard,
  FairnessMetrics,
  HistoryEntry,
  Page,
  ParkingSpot,
  Principal,
  Resident,
  RunAssignment,
  RunResult,
  SpotType,
} from './models';

/**
 * Repository contracts as abstract classes rather than interfaces, so they can be
 * Angular DI tokens directly (§10): pages inject facades, facades depend on these, and
 * `app.config.ts` binds them to the HTTP implementations in `data/`. A fake
 * implementation backs the unit tests without touching HttpClient.
 *
 * Nothing here mentions HTTP, status codes or DTOs. That is the point — swapping the
 * transport touches only the data ring.
 */

export abstract class DashboardRepository {
  abstract load(): Promise<Dashboard>;
  abstract history(limit: number): Promise<readonly HistoryEntry[]>;
  /** UC-11. Returns the resident promoted off the waitlist, if there was one. */
  abstract releaseAssignment(): Promise<{ promotedResidentId: string | null }>;
}

export abstract class MeRepository {
  abstract principal(): Promise<Principal>;
}

export abstract class ResidentRepository {
  abstract list(input: {
    limit: number;
    cursor?: string;
    unit?: string;
    eligible?: boolean;
  }): Promise<Page<Resident>>;
  abstract get(id: string): Promise<Resident>;
  abstract create(input: {
    email: string;
    fullName: string;
    unitNumber: string;
    needsAccessibleSpot: boolean;
  }): Promise<Resident>;
  abstract update(
    id: string,
    patch: { fullName?: string; unitNumber?: string; needsAccessibleSpot?: boolean },
  ): Promise<Resident>;
  abstract setEligibility(id: string, isEligible: boolean, reason: string | null): Promise<Resident>;
  abstract deactivate(id: string): Promise<void>;
}

export abstract class SpotRepository {
  abstract list(input?: { activeOnly?: boolean; type?: SpotType }): Promise<readonly ParkingSpot[]>;
  abstract create(input: {
    spotCode: string;
    level: string;
    type: SpotType;
    notes: string | null;
  }): Promise<ParkingSpot>;
  abstract update(
    id: string,
    patch: { level?: string; type?: SpotType; notes?: string | null; isActive?: boolean },
  ): Promise<ParkingSpot>;
}

export abstract class CycleRepository {
  abstract list(): Promise<readonly Cycle[]>;
  abstract create(input: {
    label?: string;
    startsOn: string;
    endsOn: string;
    registrationOpensAt: string;
    registrationClosesAt: string;
  }): Promise<Cycle>;
  abstract openRegistration(id: string): Promise<Cycle>;
  abstract closeRegistration(id: string): Promise<Cycle>;
  /** UC-08 / withdrawal, for the resident's own registration. */
  abstract register(cycleId: string): Promise<void>;
  abstract withdraw(cycleId: string): Promise<void>;
}

export abstract class RunRepository {
  /**
   * UC-05. The idempotency key is the caller's responsibility: a retried click must
   * replay rather than draw twice (§16).
   */
  abstract execute(cycleId: string, idempotencyKey: string): Promise<RunResult>;
  abstract get(runId: string): Promise<RunResult>;
  abstract assignments(runId: string): Promise<readonly RunAssignment[]>;
}

export abstract class MetricsRepository {
  abstract fairness(): Promise<FairnessMetrics>;
  /** UC-07. Returns the CSV body so the caller can hand it to a download. */
  abstract quarterlyReportCsv(cycleId: string): Promise<string>;
}
