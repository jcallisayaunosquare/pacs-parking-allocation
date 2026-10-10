import type {
  AccessEvent,
  AccessReason,
  AllocationConfigVersion,
  Assignment,
  Cycle,
  Dashboard,
  FairnessMetrics,
  HistoryEntry,
  Page,
  ParkingSpot,
  PlateMetrics,
  PlateRead,
  Principal,
  Resident,
  RunAssignment,
  RunExplanation,
  RunResult,
  RunSummary,
  Vehicle,
} from '../domain/models';
import type {
  AccessEventDto,
  AllocationConfigVersionDto,
  CycleDto,
  DashboardDto,
  FairnessMetricsDto,
  HistoryEntryDto,
  MeDto,
  PageDto,
  ParkingSpotDto,
  PlateMetricsDto,
  PlateReadDto,
  ResidentDto,
  RunAssignmentDto,
  RunExplanationDto,
  RunResultDto,
  RunSummaryDto,
  VehicleDto,
} from './dto';

/**
 * DTO → model. The whole job is turning strings into `Date` at the boundary so no
 * component ever has to wonder which it got, and dropping fields the UI has no use for.
 */
const date = (iso: string): Date => new Date(iso);
const maybeDate = (iso: string | null | undefined): Date | null => (iso ? new Date(iso) : null);

/**
 * Coerces a numeric that may legitimately be absent, without turning absence into 0.
 *
 * Postgres numerics arrive as strings over JSON, so every figure is coerced at this
 * boundary rather than where it is rendered. A value that will not coerce is absent too:
 * a NaN on screen helps nobody, and at display scale it reads as the product being
 * broken. The server is deployed independently of this client, so a field it does not
 * send yet has to come through as "unknown", never as a number.
 */
const num = (v: number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Parses a calendar day as local midnight.
 *
 * `startsOn` and `endsOn` are days, not instants. `new Date('2027-01-01')` is parsed as
 * UTC midnight, which in any zone west of UTC renders as 31 December — a quarter
 * beginning on 1 January showed as the day before. Building the date from its parts
 * keeps the day the server meant.
 */
const dayOnly = (value: string): Date => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return new Date(value);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};

export const toResident = (d: ResidentDto): Resident => ({
  id: d.id,
  email: d.email,
  fullName: d.fullName,
  unitNumber: d.unitNumber,
  isEligible: d.isEligible,
  ineligibleReason: d.ineligibleReason,
  needsAccessibleSpot: d.needsAccessibleSpot,
  externalSubject: d.externalSubject,
  currentSpotCode: d.currentSpotCode ?? null,
});

/**
 * A registered vehicle.
 *
 * `plateDisplay` falls back to `plate` rather than to an empty string: a row with no
 * plate at all is unreadable, and the canonical form is still the resident's plate — it
 * is only punctuated differently. `photos` is coerced to an array because a server that
 * does not send the field yet must not make the register iterate `undefined`.
 */
export const toVehicle = (d: VehicleDto): Vehicle => ({
  id: d.id,
  residentId: d.residentId,
  plate: d.plate,
  plateDisplay: d.plateDisplay || d.plate,
  make: d.make ?? null,
  model: d.model ?? null,
  year: num(d.year),
  colour: d.colour ?? null,
  notes: d.notes ?? null,
  photos: Array.isArray(d.photos) ? d.photos.filter((p) => typeof p === 'string') : [],
  // A row the server did not label is treated as current: the only rows the register
  // endpoint returns at all are the active ones.
  isActive: d.isActive ?? true,
});

/**
 * The known reason codes. An unrecognised one is carried through rather than dropped:
 * the server is deployed independently of this client, so a build of the app can meet a
 * build of the API that has learned a new reason - and a row whose reason silently became
 * null would read as "no decision was made", which is a different and worse claim.
 */
const ACCESS_REASONS = new Set<string>([
  'EXACT_MATCH',
  'FUZZY_MATCH_SINGLE',
  'FUZZY_MATCH_AMBIGUOUS',
  'PLATE_NOT_REGISTERED',
  'LOW_CONFIDENCE',
  'UNREADABLE',
  'RESIDENT_NOT_ELIGIBLE',
  'VEHICLE_INACTIVE',
  'DUPLICATE_WITHIN_COOLDOWN',
  'MANUAL_REVIEW',
]);

const toReason = (v: string | null | undefined): AccessReason | null => {
  if (!v) return null;
  return ACCESS_REASONS.has(v) ? (v as AccessReason) : (v as AccessReason);
};

/**
 * One captured frame.
 *
 * `fused` is recomputed from the two inputs when the server did not send it, rather than
 * left null: the screen sorts and filters on it, and a null there would drop the row out
 * of the view an administrator opened the page for. The three numbers are all kept
 * because they answer different questions - see the domain model.
 */
export const toPlateRead = (d: PlateReadDto): PlateRead => {
  const confidence = num(d.confidence);
  const quality = num(d.quality);
  const sent = num(d.fused);
  return {
    id: d.id,
    captureId: d.captureId,
    cameraId: d.cameraId,
    capturedAt: date(d.capturedAt),
    rawText: d.rawText ?? null,
    plate: d.plate ?? null,
    registeredPlate: d.registeredPlate ?? null,
    confidence,
    quality,
    fused:
      sent ??
      (confidence === null ? null : confidence * (0.6 + 0.4 * (quality ?? 1))),
    status: d.status ?? 'REVIEW',
    matchKind: d.matchKind ?? 'NONE',
    matchDistance: num(d.matchDistance),
    vehicleId: d.vehicleId ?? null,
    residentId: d.residentId ?? null,
    residentName: d.residentName ?? null,
    unitNumber: d.unitNumber ?? null,
    spotCode: d.spotCode ?? null,
    vehicleMake: d.vehicleMake ?? null,
    vehicleModel: d.vehicleModel ?? null,
    vehicleYear: num(d.vehicleYear),
    vehicleColour: d.vehicleColour ?? null,
    decision: d.decision ?? null,
    reason: toReason(d.reason),
    imageKey: d.imageKey,
    cropKey: d.cropKey ?? null,
    engine: d.engine,
    engineVersion: d.engineVersion ?? null,
    latencyMs: num(d.latencyMs),
    // Derived here when absent, so an older API cannot empty the review filter: a row
    // that is REVIEW and unreviewed needs a human whatever the server chose to label it.
    needsReview: d.needsReview ?? (d.status === 'REVIEW' && !d.reviewedAt),
    reviewedAt: maybeDate(d.reviewedAt),
    reviewNote: d.reviewNote ?? null,
    correctedPlate: d.correctedPlate ?? null,
    candidates: (d.candidates ?? []).map((c) => ({
      plate: c.plate,
      raw: c.raw ?? c.plate,
      confidence: num(c.confidence) ?? 0,
      score: num(c.score) ?? 0,
    })),
  };
};

export const toAccessEvent = (d: AccessEventDto): AccessEvent => ({
  id: d.id,
  plateReadId: d.plateReadId,
  captureId: d.captureId,
  plate: d.plate,
  residentId: d.residentId ?? null,
  residentName: d.residentName ?? null,
  unitNumber: d.unitNumber ?? null,
  spotCode: d.spotCode ?? null,
  decision: d.decision,
  reason: toReason(d.reason) ?? 'MANUAL_REVIEW',
  cameraId: d.cameraId,
  occurredAt: date(d.occurredAt),
  supersededBy: d.supersededBy ?? null,
});

export const toPlateMetrics = (d: PlateMetricsDto): PlateMetrics => ({
  windowDays: num(d.windowDays),
  reads: num(d.reads),
  matched: num(d.matched),
  unmatched: num(d.unmatched),
  pendingReview: num(d.pendingReview),
  oldestPendingHours: num(d.oldestPendingHours),
  allowed: num(d.allowed),
  denied: num(d.denied),
  averageFused: num(d.averageFused),
  corrections: num(d.corrections),
});

export const toSpot = (d: ParkingSpotDto): ParkingSpot => ({
  id: d.id,
  spotCode: d.spotCode,
  level: d.level,
  type: d.type,
  isActive: d.isActive,
  notes: d.notes,
});

export const toCycle = (d: CycleDto): Cycle => ({
  id: d.id,
  label: d.label,
  startsOn: dayOnly(d.startsOn),
  endsOn: dayOnly(d.endsOn),
  state: d.state,
  registrationOpensAt: date(d.registrationOpensAt),
  registrationClosesAt: date(d.registrationClosesAt),
});

export const toHistoryEntry = (d: HistoryEntryDto): HistoryEntry => ({
  cycle: d.cycle,
  result: d.result,
  spotCode: d.spotCode,
  position: d.position,
  // Null stays null: a run the resident sat out has no key, and zero would claim it did.
  effectiveWaitHours: num(d.effectiveWaitHours),
  servedCountAtDraw: num(d.servedCountAtDraw),
  biasApplied: d.biasApplied,
  finalRank: num(d.finalRank),
  recordedAt: date(d.recordedAt),
});

const toAssignment = (d: NonNullable<DashboardDto['assignment']>): Assignment => ({
  spotCode: d.spotCode,
  level: d.level,
  type: d.type,
  validFrom: date(d.validFrom),
  validUntil: date(d.validUntil),
  state: d.state,
});

export const toDashboard = (d: DashboardDto): Dashboard => ({
  resident: d.resident,
  assignment: d.assignment ? toAssignment(d.assignment) : null,
  waitlist: d.waitlist,
  fairness: {
    anchorAt: d.fairness.anchorAt ? date(d.fairness.anchorAt) : null,
    waitingHours: num(d.fairness.waitingHours),
    effectiveWaitHours: num(d.fairness.effectiveWaitHours),
    servedCount: num(d.fairness.servedCount),
    biasApplied: d.fairness.biasApplied ?? false,
    firstTimeParticipant: d.fairness.firstTimeParticipant ?? false,
    explanation: d.fairness.explanation,
  },
  nextCycle: d.nextCycle ? toCycle(d.nextCycle) : null,
  // Absent on an older server means "not entered", which is the safe reading: it offers
  // the entry rather than hiding it behind a claim the response did not make.
  registeredForNextCycle: d.registeredForNextCycle ?? false,
  recentHistory: (d.recentHistory ?? []).map(toHistoryEntry),
});

export const toPrincipal = (d: MeDto): Principal => ({
  subject: d.subject,
  email: d.email,
  roles: d.roles,
  resident: d.resident ? toResident(d.resident) : null,
});

export const toRunResult = (d: RunResultDto): RunResult => ({
  runId: d.runId,
  state: d.state,
  algorithmVersion: d.algorithmVersion,
  randomSeed: d.randomSeed,
  entrants: d.entrants,
  spots: d.spots,
  assigned: d.assigned,
  waitlisted: d.waitlisted,
  startedAt: date(d.startedAt),
  finishedAt: maybeDate(d.finishedAt),
  errorDetail: d.errorDetail ?? null,
});

export const toRunAssignment = (d: RunAssignmentDto): RunAssignment => ({ ...d });

export const toRunSummary = (d: RunSummaryDto): RunSummary => ({
  runId: d.runId,
  cycleId: d.cycleId,
  cycleLabel: d.cycleLabel ?? null,
  state: d.state,
  algorithmVersion: d.algorithmVersion,
  configVersion: num(d.configVersion),
  randomSeedHex: d.randomSeedHex,
  decidedAt: d.decidedAt ? date(d.decidedAt) : null,
  entrants: num(d.entrants),
  spots: num(d.spots),
  assigned: num(d.assigned),
  finishedAt: maybeDate(d.finishedAt),
  errorDetail: d.errorDetail ?? null,
});

export const toRunExplanation = (d: RunExplanationDto): RunExplanation => ({
  runId: d.runId,
  configVersion: d.configVersion,
  policy: {
    earlyWaitingBiasHours: num(d.policy?.earlyWaitingBiasHours),
    waitQuantumMinutes: num(d.policy?.waitQuantumMinutes),
    allocationDurationMonths: num(d.policy?.allocationDurationMonths),
  },
  ordering: d.ordering,
  tokenRecipe: d.tokenRecipe,
  items: (d.items ?? []).map((r) => ({
    residentId: r.residentId,
    unit: r.unit,
    anchorAt: r.anchorAt ? date(r.anchorAt) : null,
    waitHours: num(r.waitHours),
    effectiveWaitHours: num(r.effectiveWaitHours),
    biasApplied: r.biasApplied ?? false,
    firstTimeParticipant: r.firstTimeParticipant ?? false,
    servedCount: num(r.servedCount),
    rank: Number(r.rank),
    outcome: r.outcome,
    spotCode: r.spotCode,
    decidedBy: r.decidedBy,
    explanation: r.explanation,
  })),
});

export const toFairnessMetrics = (d: FairnessMetricsDto): FairnessMetrics => ({
  residents: num(d.residents),
  averageWaitHours: num(d.averageWaitHours),
  maxWaitHours: num(d.maxWaitHours),
  neverServed: num(d.neverServed),
  distribution: (d.distribution ?? []).map((x) => ({
    servedCount: num(x.servedCount),
    residents: num(x.residents),
  })),
});

/** A stored config version. The audit columns are the reason this view exists. */
export const toConfigVersion = (d: AllocationConfigVersionDto): AllocationConfigVersion => ({
  version: d.version,
  allocationDurationMonths: Number(d.allocationDurationMonths),
  earlyWaitingBiasHours: Number(d.earlyWaitingBiasHours),
  waitQuantumMinutes: Number(d.waitQuantumMinutes),
  declineGraceHours: Number(d.declineGraceHours),
  absenceResetMonths: num(d.absenceResetMonths),
  totalBays: Number(d.totalBays),
  changedAt: date(d.changedAt),
  changedBy: d.changedBy,
});

export const toPage = <D, M>(d: PageDto<D>, map: (x: D) => M): Page<M> => ({
  items: (d.items ?? []).map(map),
  nextCursor: d.nextCursor,
});
