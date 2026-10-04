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
  startsOn: date(d.startsOn),
  endsOn: date(d.endsOn),
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
