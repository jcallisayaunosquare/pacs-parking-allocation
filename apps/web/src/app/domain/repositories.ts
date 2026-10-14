import type {
  Cycle,
  Dashboard,
  FairnessMetrics,
  HistoryEntry,
  Page,
  ParkingSpot,
  PlateMetrics,
  PlateRead,
  PlateReadStatus,
  PlateReviewDraft,
  Principal,
  Resident,
  RunAssignment,
  RunExplanation,
  RunResult,
  RunSummary,
  SpotType,
  Vehicle,
  VehicleDraft,
} from './models';
import type {
  AllocationConfigPatch,
  AllocationConfigVersion,
  AllocationConfigView,
} from './models';
import type { BayOccupancy, LotLevel } from './lot-layout';

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

/** The columns the register may be sorted by. Mirrors the server's allowlist. */
export const RESIDENT_SORT_FIELDS = ['name', 'unit', 'email', 'eligibility', 'created'] as const;
export type ResidentSortField = (typeof RESIDENT_SORT_FIELDS)[number];
export type SortDirection = 'asc' | 'desc';

export interface ResidentListQuery {
  limit: number;
  cursor?: string;
  unit?: string;
  eligible?: boolean;
  sort?: ResidentSortField;
  dir?: SortDirection;
}

export abstract class ResidentRepository {
  abstract list(input: ResidentListQuery): Promise<Page<Resident>>;
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

/**
 * The vehicle register, scoped to one resident.
 *
 * The resident id is a parameter on every call rather than state on the repository,
 * because the same contract serves both callers the server recognises: an administrator
 * working on anyone's record, and a resident on their own. The server decides which of
 * those the caller is, from the token — the client never asserts it.
 */
export abstract class VehicleRepository {
  abstract list(residentId: string): Promise<readonly Vehicle[]>;
  abstract add(residentId: string, input: VehicleDraft): Promise<Vehicle>;
  abstract update(
    residentId: string,
    vehicleId: string,
    patch: Partial<VehicleDraft>,
  ): Promise<Vehicle>;
  /** A deactivation server-side: the plate is freed, the row is kept. Hence "remove". */
  abstract remove(residentId: string, vehicleId: string): Promise<void>;
}

/**
 * The gate log and its review action (M-7).
 *
 * Administrator-only on the server, because the answer names which resident drives which
 * car and when they came in. The guard in the route map is usability; this contract has
 * no opinion about it.
 *
 * There is no `recognise` method, and there never will be: recognition is triggered by a
 * frame landing in S3, so the client's only relationship with it is reading the result and
 * correcting it.
 */
export interface PlateReadListQuery {
  limit: number;
  cursor?: string;
  status?: PlateReadStatus;
  cameraId?: string;
  plate?: string;
  /** Only the reads a human still has to look at. Returned oldest first. */
  needsReview?: boolean;
}

export abstract class PlateRepository {
  abstract list(input: PlateReadListQuery): Promise<Page<PlateRead>>;
  /**
   * The review action. The key is the caller's responsibility, as it is for the draw: a
   * retried click must replay rather than write a second decision.
   */
  abstract resolve(
    plateReadId: string,
    draft: PlateReviewDraft,
    idempotencyKey: string,
  ): Promise<PlateRead>;
  abstract metrics(): Promise<PlateMetrics>;
}

/**
 * The camera's half of M-7: hand a frame to the system and get out of the way.
 *
 * Two steps, not one, and the split is the whole design. `ticket()` asks our API for a
 * presigned PUT; `upload()` sends the bytes straight to S3 with that URL and never
 * touches the API again. So the frame - which can be a megabyte - never passes through
 * API Gateway or a Lambda, and the only thing the gate device holds is a credential that
 * expires in five minutes and can write one object under its own prefix.
 *
 * There is deliberately no `recognise()`: the frame landing in the bucket is what starts
 * recognition, and the camera never learns the verdict. A device at a barrier has no
 * business reading which resident drives which car.
 */
export interface CaptureTicket {
  readonly captureId: string;
  readonly objectKey: string;
  readonly uploadUrl: string;
  readonly expiresIn: number;
}

export abstract class CaptureRepository {
  abstract ticket(input: {
    cameraId: string;
    capturedAt: Date;
    contentType: 'image/jpeg' | 'image/png';
  }): Promise<CaptureTicket>;
  /** The presigned PUT. Our bearer token must not be attached to it. */
  abstract upload(ticket: CaptureTicket, frame: Blob): Promise<void>;
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
    /**
     * Omitted means "derive it": the server takes the end from Period length in the
     * allocation rules. The contract has always allowed that; this client used to
     * require it, which forced the dialog to compute a date the rule already owns.
     */
    endsOn?: string;
    registrationOpensAt: string;
    registrationClosesAt: string;
  }): Promise<Cycle>;
  /** The only field a period may change after creation: its dates are in the record. */
  abstract rename(id: string, label: string): Promise<Cycle>;
  /** Refused server-side once the period has drawn or assigned; surfaced as 422. */
  abstract remove(id: string): Promise<void>;
  abstract openRegistration(id: string): Promise<Cycle>;
  abstract closeRegistration(id: string): Promise<Cycle>;
  /** Who entered this period's draw - the pool the run draws from. Administrators only. */
  abstract entrants(id: string): Promise<readonly Entrant[]>;
  /** Ends the period in effect, expiring its assignments. Not closeRegistration. */
  abstract closePeriod(id: string): Promise<Cycle>;
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
  /**
   * The contestable record: every candidate in final rank order, with the clause that
   * decided each place. The result screen is built from this rather than from
   * `assignments`, because a winner list cannot answer "why them and not me".
   */
  abstract explanation(runId: string): Promise<RunExplanation>;
  /** Every committed draw, newest first. The draws report reads this. */
  abstract list(limit: number): Promise<readonly RunSummary[]>;
}

export abstract class MetricsRepository {
  abstract fairness(): Promise<FairnessMetrics>;
  /** UC-07. Returns the CSV body so the caller can hand it to a download. */
  abstract quarterlyReportCsv(cycleId: string): Promise<string>;
}

/**
 * The lot map. Two calls rather than one, because the halves have different lifetimes:
 * the layout changes when the building changes and can be cached for a day, while
 * occupancy changes every draw and is revalidated on the minute. Joining them on the
 * server would tie the cheap, stable half to the volatile one.
 */
export abstract class LotRepository {
  abstract levels(): Promise<readonly LotLevel[]>;
  abstract occupancy(levelId: string): Promise<readonly BayOccupancy[]>;
}
/**
 * Rule A's configuration. A patch inserts a new version rather than updating a row, so a
 * draw that already ran keeps the numbers it was decided with.
 */
export abstract class AllocationConfigRepository {
  abstract current(): Promise<AllocationConfigView>;
  abstract patch(patch: AllocationConfigPatch): Promise<AllocationConfigView>;
  /** Every version, newest first, with who changed it and when. */
  abstract history(limit: number): Promise<readonly AllocationConfigVersion[]>;
}
/** A resident entered in a period's draw, as the draw screen reviews them. */
export interface Entrant {
  readonly id: string;
  readonly fullName: string;
  readonly unitNumber: string;
}
