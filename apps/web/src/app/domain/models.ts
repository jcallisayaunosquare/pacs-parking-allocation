/**
 * The domain ring (§10). Plain TypeScript: no HttpClient, no PrimeNG, no Angular.
 * These are the shapes the application and feature rings reason about — the wire
 * format lives in `data/dto.ts` and is mapped across the boundary.
 */

export type SpotType = 'STANDARD' | 'ACCESSIBLE' | 'EV';

export type CycleState =
  | 'DRAFT'
  | 'REGISTRATION_OPEN'
  | 'REGISTRATION_CLOSED'
  | 'ACTIVE'
  | 'CLOSED';

export type AssignmentState = 'ACTIVE' | 'RELEASED' | 'REVOKED' | 'EXPIRED';

export type DrawOutcome = 'ASSIGNED' | 'WAITLISTED' | 'SKIPPED';

export type Role = 'ADMIN' | 'RESIDENT';

export interface Resident {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly unitNumber: string;
  readonly isEligible: boolean;
  readonly ineligibleReason: string | null;
  readonly needsAccessibleSpot: boolean;
  readonly externalSubject: string | null;
}

export interface ParkingSpot {
  readonly id: string;
  readonly spotCode: string;
  readonly level: string;
  readonly type: SpotType;
  readonly isActive: boolean;
  readonly notes: string | null;
}

export interface Cycle {
  readonly id: string;
  readonly label: string;
  readonly startsOn: Date;
  readonly endsOn: Date;
  readonly state: CycleState;
  readonly registrationOpensAt: Date;
  readonly registrationClosesAt: Date;
}

export interface Assignment {
  readonly spotCode: string;
  readonly level: string;
  readonly type: SpotType;
  readonly validFrom: Date;
  readonly validUntil: Date;
  readonly state: AssignmentState;
}

export interface Fairness {
  readonly score: number;
  readonly consecutiveMisses: number;
  readonly totalWins: number;
  /** score + 1 — how many times the resident's name is in the hat. */
  readonly drawWeight: number;
  /**
   * The sentence that goes with the number. §17's rule: never show a number without
   * it. The API returns both together so the two can never drift apart.
   */
  readonly explanation: string;
}

export interface HistoryEntry {
  readonly cycle: string;
  readonly result: DrawOutcome;
  readonly spotCode: string | null;
  readonly position: number | null;
  readonly scoreAtDraw: number;
  readonly recordedAt: Date;
}

/** What `GET /me/dashboard` answers — the whole resident screen in one query (§17). */
export interface Dashboard {
  readonly resident: {
    readonly id: string;
    readonly fullName: string;
    readonly unit: string;
    readonly isEligible: boolean;
  };
  readonly assignment: Assignment | null;
  readonly waitlist: { readonly position: number } | null;
  readonly fairness: Fairness;
  readonly nextCycle: Cycle | null;
  readonly recentHistory: readonly HistoryEntry[];
}

/**
 * The five states §17 requires every screen to handle, as one discriminated union.
 * `stale` is the one people forget: during a revalidation the old value stays on
 * screen, dimmed, instead of flashing empty.
 */
export type ViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly error: ApiError }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'ready'; readonly stale: boolean };

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly details?: readonly { field: string; issue: string }[];
  /** Copyable, so support can find the request in the logs (§17, §21). */
  readonly traceId: string | null;
  readonly status: number;
}

export interface RunResult {
  readonly runId: string;
  readonly state: 'COMPLETED' | 'COMPLETED_EMPTY' | 'RUNNING' | 'FAILED';
  readonly algorithmVersion: string;
  readonly randomSeed: number;
  readonly entrants: number;
  readonly spots: number;
  readonly assigned: number;
  readonly waitlisted: number;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly errorDetail?: string | null;
}

export interface RunAssignment {
  readonly residentId: string;
  readonly fullName: string;
  readonly spotCode: string;
}

export interface FairnessMetrics {
  readonly residents: number;
  readonly averageScore: number;
  readonly maxScore: number;
  readonly neverWon: number;
  readonly distribution: readonly { score: number; residents: number }[];
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** The principal, derived from the token. Mirrors the server's view (§18). */
export interface Principal {
  readonly subject: string;
  readonly email: string | null;
  readonly roles: readonly Role[];
  readonly resident: Resident | null;
}

export const isAdmin = (p: Principal | null): boolean => p?.roles.includes('ADMIN') ?? false;
