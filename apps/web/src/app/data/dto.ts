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
  /**
   * Separation of duties: an administrator operates the raffle, so the account is out of
   * the draw and out of the fairness figures. Optional, and absence maps to false - the
   * safe direction, since it only ever shows one row as an ordinary resident rather than
   * hiding a resident as an administrator.
   */
  isAdmin?: boolean;
  externalSubject: string | null;
  currentSpotCode?: string | null;
  /** Sent by `GET /residents/{id}` only; the register page does not ask for it. */
  vehicles?: VehicleDto[];
  createdAt?: string;
  deactivatedAt?: string | null;
}

export interface VehicleDto {
  id: string;
  residentId: string;
  /** The canonical form: uppercase, no separators, confusable glyphs folded. */
  plate: string;
  /** What the resident typed. What the register prints. */
  plateDisplay: string;
  make: string | null;
  model: string | null;
  year: number | null;
  colour: string | null;
  notes: string | null;
  /** Object keys or URLs. No upload pipeline behind it yet — S3 presigned PUT is next. */
  photos: string[];
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** The register and the edit body. Every field but the plate is optional. */
export interface VehicleInputDto {
  plate?: string;
  make?: string | null;
  model?: string | null;
  year?: number | null;
  colour?: string | null;
  notes?: string | null;
  photos?: string[];
}

// ------------------------------------------------------ plate recognition (M-7)

export interface PlateCandidateDto {
  plate: string;
  raw: string;
  confidence: number;
  score: number;
}

export interface PlateReadDto {
  id: string;
  captureId: string;
  cameraId: string;
  capturedAt: string;
  rawText: string | null;
  /** The canonical form the gate matched on. Null on an unreadable frame. */
  plate: string | null;
  registeredPlate: string | null;
  confidence: number | null;
  quality: number | null;
  /** confidence * (0.6 + 0.4 * quality). Derived server-side, never stored. */
  fused: number | null;
  status: 'MATCHED' | 'UNMATCHED' | 'REVIEW' | 'DISCARDED';
  matchKind: 'EXACT' | 'FUZZY' | 'MANUAL' | 'NONE';
  matchDistance: number | null;
  vehicleId: string | null;
  residentId: string | null;
  residentName: string | null;
  unitNumber: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
  vehicleColour: string | null;
  spotCode: string | null;
  decision: 'ALLOW' | 'DENY' | 'REVIEW' | null;
  reason: string | null;
  /** A capture reference, not a URL. Images are never served by the API. */
  imageKey: string;
  cropKey: string | null;
  engine: string;
  engineVersion: string | null;
  latencyMs: number | null;
  needsReview: boolean;
  reviewedAt: string | null;
  reviewedBy?: string | null;
  reviewNote: string | null;
  correctedPlate: string | null;
  candidates?: PlateCandidateDto[];
}

/** The review body. `discard` must go with `decision: 'DENY'`. */
export interface PlateReviewInputDto {
  plate?: string | null;
  vehicleId?: string | null;
  decision: 'ALLOW' | 'DENY';
  note?: string | null;
  discard?: boolean;
}

export interface AccessEventDto {
  id: string;
  plateReadId: string;
  captureId: string;
  plate: string;
  residentId: string | null;
  residentName: string | null;
  unitNumber: string | null;
  spotCode: string | null;
  decision: 'ALLOW' | 'DENY' | 'REVIEW';
  reason: string;
  cameraId: string;
  occurredAt: string;
  supersededBy: string | null;
}

export interface PlateMetricsDto {
  windowDays: number;
  reads: number;
  matched: number;
  unmatched: number;
  pendingReview: number;
  oldestPendingHours: number | null;
  allowed: number;
  denied: number;
  averageFused: number | null;
  corrections: number;
  byCamera?: { cameraId: string; reads: number; matched: number }[];
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
  /** The key as it stood in that run, from the stored row. Negative while cooling. */
  effectiveWaitHours: number | null;
  servedCountAtDraw: number | null;
  biasApplied: boolean | null;
  finalRank: number | null;
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
    anchorAt: string;
    waitingHours: number;
    effectiveWaitHours: number;
    servedCount: number;
    biasApplied: boolean;
    firstTimeParticipant: boolean;
    explanation: string;
  };
  nextCycle: CycleDto | null;
  /** Whether this resident is already entered for `nextCycle`. */
  registeredForNextCycle?: boolean;
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

export interface RunCandidateDto {
  residentId: string;
  unit: string;
  anchorAt: string | null;
  waitHours: number | null;
  effectiveWaitHours: number | null;
  biasApplied: boolean;
  firstTimeParticipant: boolean;
  servedCount: number | null;
  rank: number;
  outcome: 'ASSIGNED' | 'WAITLISTED' | 'SKIPPED';
  spotCode: string | null;
  decidedBy: 'WAITING_TIME' | 'ALLOCATION_HISTORY' | 'RAFFLE' | 'EARLY_WAITING_BIAS';
  explanation: string;
}

export interface RunSummaryDto {
  runId: string;
  cycleId: string;
  cycleLabel: string | null;
  state: string;
  algorithmVersion: string;
  configVersion: number | null;
  randomSeedHex: string;
  decidedAt: string | null;
  entrants: number | null;
  spots: number | null;
  assigned: number | null;
  finishedAt: string | null;
  errorDetail: string | null;
}

export interface RunExplanationDto {
  runId: string;
  configVersion: number;
  policy: {
    earlyWaitingBiasHours: number | null;
    waitQuantumMinutes: number | null;
    allocationDurationMonths: number | null;
  };
  ordering: string;
  tokenRecipe: string;
  items: RunCandidateDto[];
}

export interface FairnessMetricsDto {
  residents: number;
  averageWaitHours: number;
  maxWaitHours: number;
  neverServed: number;
  distribution: { servedCount: number; residents: number }[];
}

export interface AllocationConfigVersionDto extends AllocationConfigDto {
  changedAt: string;
  changedBy: string | null;
}

export interface AllocationConfigDto {
  version: number;
  allocationDurationMonths: number;
  earlyWaitingBiasHours: number;
  waitQuantumMinutes: number;
  declineGraceHours: number;
  absenceResetMonths: number | null;
  totalBays: number;
}

export interface AllocationConfigViewDto {
  config: AllocationConfigDto;
  warnings: string[];
}

export interface PageDto<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ItemsDto<T> {
  items: T[];
}
