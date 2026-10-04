import type {
  Assignment,
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
} from '../domain/models';
import type {
  CycleDto,
  DashboardDto,
  FairnessMetricsDto,
  HistoryEntryDto,
  MeDto,
  PageDto,
  ParkingSpotDto,
  ResidentDto,
  RunAssignmentDto,
  RunResultDto,
} from './dto';

/**
 * DTO → model. The whole job is turning strings into `Date` at the boundary so no
 * component ever has to wonder which it got, and dropping fields the UI has no use for.
 */
const date = (iso: string): Date => new Date(iso);
const maybeDate = (iso: string | null | undefined): Date | null => (iso ? new Date(iso) : null);

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
  scoreAtDraw: Number(d.scoreAtDraw),
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
    score: Number(d.fairness.score),
    consecutiveMisses: d.fairness.consecutiveMisses,
    totalWins: d.fairness.totalWins,
    drawWeight: Number(d.fairness.drawWeight),
    explanation: d.fairness.explanation,
  },
  nextCycle: d.nextCycle ? toCycle(d.nextCycle) : null,
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

export const toFairnessMetrics = (d: FairnessMetricsDto): FairnessMetrics => ({
  residents: d.residents,
  averageScore: Number(d.averageScore),
  maxScore: Number(d.maxScore),
  neverWon: d.neverWon,
  distribution: (d.distribution ?? []).map((x) => ({
    score: Number(x.score),
    residents: Number(x.residents),
  })),
});

export const toPage = <D, M>(d: PageDto<D>, map: (x: D) => M): Page<M> => ({
  items: (d.items ?? []).map(map),
  nextCursor: d.nextCursor,
});
