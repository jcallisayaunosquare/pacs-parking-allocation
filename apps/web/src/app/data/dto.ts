/**
 * The wire format, exactly as `packages/contracts/openapi.yaml` describes it.
 *
 * Kept separate from the domain models on purpose: dates arrive as ISO strings and
 * numerics can arrive as strings, and the mapping is where that is dealt with — once,
 * at the boundary, instead of in every component that renders a date.
 *
 * These types are hand-written to match the contract. `pnpm --filter @pacs/contracts
 * types` generates the same shapes from the YAML; when the two disagree, the YAML wins.
 */

export interface ResidentDto {
  id: string;
  email: string;
  fullName: string;
  unitNumber: string;
  isEligible: boolean;
  ineligibleReason: string | null;
  needsAccessibleSpot: boolean;
  externalSubject: string | null;
  createdAt?: string;
  deactivatedAt?: string | null;
}

export interface ParkingSpotDto {
  id: string;
  spotCode: string;
  level: string;
  type: 'STANDARD' | 'ACCESSIBLE' | 'EV';
  isActive: boolean;
  notes: string | null;
  createdAt?: string;
}

export interface CycleDto {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  state: 'DRAFT' | 'REGISTRATION_OPEN' | 'REGISTRATION_CLOSED' | 'ACTIVE' | 'CLOSED';
  registrationOpensAt: string;
  registrationClosesAt: string;
}

export interface HistoryEntryDto {
  cycle: string;
  result: 'ASSIGNED' | 'WAITLISTED' | 'SKIPPED';
  spotCode: string | null;
  position: number | null;
  scoreAtDraw: number;
  recordedAt: string;
}

export interface DashboardDto {
  resident: { id: string; fullName: string; unit: string; isEligible: boolean };
  assignment: {
    spotCode: string;
    level: string;
    type: 'STANDARD' | 'ACCESSIBLE' | 'EV';
    validFrom: string;
    validUntil: string;
    state: 'ACTIVE' | 'RELEASED' | 'REVOKED' | 'EXPIRED';
  } | null;
  waitlist: { position: number } | null;
  fairness: {
    score: number;
    consecutiveMisses: number;
    totalWins: number;
    drawWeight: number;
    explanation: string;
  };
  nextCycle: CycleDto | null;
  recentHistory: HistoryEntryDto[];
}

export interface MeDto {
  subject: string;
  email: string | null;
  roles: ('ADMIN' | 'RESIDENT')[];
  resident: ResidentDto | null;
}

export interface RunResultDto {
  runId: string;
  cycleId?: string;
  state: 'COMPLETED' | 'COMPLETED_EMPTY' | 'RUNNING' | 'FAILED';
  algorithmVersion: string;
  randomSeed: number;
  entrants: number;
  spots: number;
  assigned: number;
  waitlisted: number;
  startedAt: string;
  finishedAt: string | null;
  errorDetail?: string | null;
}

export interface RunAssignmentDto {
  residentId: string;
  fullName: string;
  spotCode: string;
}

export interface FairnessMetricsDto {
  residents: number;
  averageScore: number;
  maxScore: number;
  neverWon: number;
  distribution: { score: number; residents: number }[];
}

export interface PageDto<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ItemsDto<T> {
  items: T[];
}
