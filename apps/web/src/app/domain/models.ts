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

/**
 * CAMERA is a machine role, not a person: one Cognito user per gate, whose only
 * permission is `POST /captures`. It is in the same union because `GET /me` returns it
 * the same way, and the gate client signs in through the same form - but nothing else in
 * the product is offered to it, which is the point of giving a barrier its own account
 * instead of letting it hold an administrator's.
 */
export type Role = 'ADMIN' | 'RESIDENT' | 'CAMERA';

export interface Resident {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly unitNumber: string;
  readonly isEligible: boolean;
  readonly ineligibleReason: string | null;
  readonly needsAccessibleSpot: boolean;
  /**
   * The account operates the raffle, so it never enters it. The server keeps this as a
   * second, independent record of the ADMIN group on the token, and it is what excludes
   * the row from the candidate pool and from the fairness snapshot.
   */
  readonly isAdmin: boolean;
  readonly externalSubject: string | null;
  /**
   * The bay this resident holds right now, or null when they hold none.
   *
   * Undefined is not a third state here: a server that does not send the field yet maps
   * to null, which reads as "holds no bay" - the safe direction, because it only ever
   * costs a warning that would have been shown, never a removal that should have been
   * refused. The server refuses that removal either way.
   */
  readonly currentSpotCode: string | null;
}

/**
 * A car a resident has registered.
 *
 * The plate arrives twice and both forms are kept, because they answer different
 * questions. `plateDisplay` is what the resident typed and is what the register prints -
 * a resident who cannot find their own plate in the list stops trusting the list.
 * `plate` is the canonical form the gate matches against: uppercase, no separators, and
 * the glyphs that are indistinguishable in a plate face folded onto their digit. It is
 * shown beside the typed form rather than hidden, because "the camera says my plate is
 * not registered" is a question only the canonical form can answer.
 */
export interface Vehicle {
  readonly id: string;
  readonly residentId: string;
  readonly plate: string;
  readonly plateDisplay: string;
  readonly make: string | null;
  readonly model: string | null;
  readonly year: number | null;
  readonly colour: string | null;
  readonly notes: string | null;
  /**
   * Object keys or URLs. There is no upload pipeline behind this: an S3 presigned PUT
   * per photo is the intended follow-up, so the register lists the keys it was given and
   * does not pretend to show images it cannot fetch.
   */
  readonly photos: readonly string[];
  readonly isActive: boolean;
}

/** What a register or an edit sends. Absent on a patch means "leave as it is". */
export interface VehicleDraft {
  readonly plate: string;
  readonly make: string | null;
  readonly model: string | null;
  readonly year: number | null;
  readonly colour: string | null;
  readonly notes: string | null;
  readonly photos: readonly string[];
}

// ------------------------------------------------------ plate recognition (M-7)

export type PlateReadStatus = 'MATCHED' | 'UNMATCHED' | 'REVIEW' | 'DISCARDED';
export type PlateMatchKind = 'EXACT' | 'FUZZY' | 'MANUAL' | 'NONE';
export type AccessDecision = 'ALLOW' | 'DENY' | 'REVIEW';

/**
 * A stable code from the server, not prose. The screen translates it, which is also what
 * keeps the reason translatable for the Spanish half of the product - the one thing the
 * fairness explanation got wrong by arriving as a finished sentence.
 */
export type AccessReason =
  | 'EXACT_MATCH'
  | 'FUZZY_MATCH_SINGLE'
  | 'FUZZY_MATCH_AMBIGUOUS'
  | 'PLATE_NOT_REGISTERED'
  | 'LOW_CONFIDENCE'
  | 'UNREADABLE'
  | 'RESIDENT_NOT_ELIGIBLE'
  | 'VEHICLE_INACTIVE'
  | 'DUPLICATE_WITHIN_COOLDOWN'
  | 'MANUAL_REVIEW';

/** One re-spelling of an OCR line, with the score that made it a candidate. */
export interface PlateCandidate {
  readonly plate: string;
  readonly raw: string;
  readonly confidence: number;
  readonly score: number;
}

/**
 * One captured frame, as the gate log shows it.
 *
 * The three confidence numbers are all kept, and that is the point rather than detail:
 * `fused` is what the threshold compared against, but a reviewer who sees only the
 * product cannot tell a blurred frame the engine was sure about from a sharp frame it was
 * not - and those are opposite faults with opposite fixes.
 *
 * Every figure the server may not know yet is nullable for the same reason the fairness
 * model's are: this client is deployed independently of the API, and a screen that
 * printed NaN would read as the product being broken.
 */
export interface PlateRead {
  readonly id: string;
  readonly captureId: string;
  readonly cameraId: string;
  readonly capturedAt: Date;
  /** What the OCR returned, untouched. Null when it read nothing at all. */
  readonly rawText: string | null;
  /** The canonical form the match was made on. Null on an unreadable frame. */
  readonly plate: string | null;
  /** The matched vehicle's own stored plate, when the read matched one. */
  readonly registeredPlate: string | null;
  readonly confidence: number | null;
  readonly quality: number | null;
  readonly fused: number | null;
  readonly status: PlateReadStatus;
  readonly matchKind: PlateMatchKind;
  readonly matchDistance: number | null;
  readonly vehicleId: string | null;
  readonly residentId: string | null;
  readonly residentName: string | null;
  readonly unitNumber: string | null;
  readonly spotCode: string | null;
  /**
   * The car as the register describes it, all null when the read matched nothing.
   *
   * On the arrivals board these are not decoration: the person on duty is comparing the
   * register against what is actually in the lane, and a plate with the wrong car behind
   * it is the one case the recognition cannot catch by itself.
   */
  readonly vehicleMake: string | null;
  readonly vehicleModel: string | null;
  readonly vehicleYear: number | null;
  readonly vehicleColour: string | null;
  /** Null means no access event was written: an unreadable frame is not a refused entry. */
  readonly decision: AccessDecision | null;
  readonly reason: AccessReason | null;
  /** The capture reference. Not a URL: the API never serves an image. */
  readonly imageKey: string;
  readonly cropKey: string | null;
  readonly engine: string;
  readonly engineVersion: string | null;
  readonly latencyMs: number | null;
  readonly needsReview: boolean;
  readonly reviewedAt: Date | null;
  readonly reviewNote: string | null;
  /** What an administrator asserted. Every one of these is an evaluation label. */
  readonly correctedPlate: string | null;
  readonly candidates: readonly PlateCandidate[];
}

/** What an administrator submits from the review action. */
export interface PlateReviewDraft {
  readonly plate: string | null;
  readonly vehicleId: string | null;
  readonly decision: 'ALLOW' | 'DENY';
  readonly note: string | null;
  /** Marks the frame discarded and writes no access event. */
  readonly discard: boolean;
}

export interface AccessEvent {
  readonly id: string;
  readonly plateReadId: string;
  readonly captureId: string;
  readonly plate: string;
  readonly residentId: string | null;
  readonly residentName: string | null;
  readonly unitNumber: string | null;
  readonly spotCode: string | null;
  readonly decision: AccessDecision;
  readonly reason: AccessReason;
  readonly cameraId: string;
  readonly occurredAt: Date;
  /** Non-null means an administrator overturned it. The row itself never changed. */
  readonly supersededBy: string | null;
}

export interface PlateMetrics {
  readonly windowDays: number | null;
  readonly reads: number | null;
  readonly matched: number | null;
  readonly unmatched: number | null;
  readonly pendingReview: number | null;
  readonly oldestPendingHours: number | null;
  readonly allowed: number | null;
  readonly denied: number | null;
  readonly averageFused: number | null;
  /** How many reads carry a correction: the size of the evaluation set. */
  readonly corrections: number | null;
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

/**
 * Where a resident stands, right now.
 *
 * There is no score and no draw weight. The allocation is a deterministic order -
 * longest wait first, fewest past allocations breaks the tie, a seeded raffle settles
 * what is still exactly level - so the quantities a resident can be shown are the ones
 * that order actually reads: how long they have waited and how often they have held a
 * bay. Waiting time is computed from stored timestamps at read time and is never a
 * counter, which is why it arrives with the instant it is measured from.
 */
export interface Fairness {
  /**
   * Every figure here is nullable, and that is not defensive padding. The server is
   * deployed independently of this client, so a build of the app can meet a build of the
   * API that does not send a field yet. The screen says it does not know, which is true;
   * what it must never do is print NaN, or a zero that reads as a real measurement.
   */
  /** The instant waiting restarted: joining the register, or a bay ending. */
  readonly anchorAt: Date | null;
  readonly waitingHours: number | null;
  /** The wait after the early-waiting bias. Negative exactly while it applies. */
  readonly effectiveWaitHours: number | null;
  /** How many times this resident has held a bay. Fewer breaks a tie in their favour. */
  readonly servedCount: number | null;
  readonly biasApplied: boolean;
  readonly firstTimeParticipant: boolean;
  /** True when waiting restarted because the resident sat periods out. */
  readonly absenceResetApplied: boolean;
  /**
   * The sentence that goes with the numbers. §17's rule: never show a number without
   * it. The API returns both together so the two can never drift apart.
   */
  readonly explanation: string;
}

export interface HistoryEntry {
  readonly cycle: string;
  readonly result: DrawOutcome;
  readonly spotCode: string | null;
  readonly position: number | null;
  /**
   * The key as it stood in that run, read from the stored row and never recomputed
   * against today's data - which has moved. Null for a run the resident sat out.
   */
  readonly effectiveWaitHours: number | null;
  readonly servedCountAtDraw: number | null;
  readonly biasApplied: boolean | null;
  readonly finalRank: number | null;
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
  /**
   * Whether this resident is already entered for `nextCycle`.
   *
   * The screen used to keep this client-side only, so entering the draw and then
   * reloading showed the entry gone. It is the server's fact.
   */
  readonly registeredForNextCycle: boolean;
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

/** Which clause of the rule actually separated this candidate from the next one. */
export type DecidedBy =
  | 'WAITING_TIME'
  | 'ALLOCATION_HISTORY'
  | 'RAFFLE'
  | 'EARLY_WAITING_BIAS';

/**
 * One row of the contestable record, as the run stored it.
 *
 * This is the shape the result screen is built from rather than the bare assignment
 * list, and the reason is `rank` and `decidedBy`: a list of winners says who got a bay,
 * while a ranked list that states which clause decided each place says why - which is
 * the only thing an administrator can repeat to a resident who is contesting a result.
 */
export interface RunCandidate {
  readonly residentId: string;
  readonly unit: string;
  readonly anchorAt: Date | null;
  readonly waitHours: number | null;
  readonly effectiveWaitHours: number | null;
  readonly biasApplied: boolean;
  readonly firstTimeParticipant: boolean;
  readonly servedCount: number | null;
  /** 1-based, over the whole field: rank <= bays offered is a win. */
  readonly rank: number;
  readonly outcome: DrawOutcome;
  readonly spotCode: string | null;
  readonly decidedBy: DecidedBy;
  /** Generated by the server from the stored row; never composed in the client. */
  readonly explanation: string;
}

/** One committed draw, as the draws report lists it. */
export interface RunSummary {
  readonly runId: string;
  readonly cycleId: string;
  /** The period's name. Null when the period it drew has since been removed. */
  readonly cycleLabel: string | null;
  readonly state: string;
  readonly algorithmVersion: string;
  readonly configVersion: number | null;
  /** Exposed on purpose: it is what makes a past result checkable. */
  readonly randomSeedHex: string;
  readonly decidedAt: Date | null;
  readonly entrants: number | null;
  readonly spots: number | null;
  readonly assigned: number | null;
  readonly finishedAt: Date | null;
  readonly errorDetail: string | null;
}

export interface RunExplanation {
  readonly runId: string;
  readonly configVersion: number;
  /** The policy values in force when the run committed, not today's. */
  readonly policy: {
    readonly earlyWaitingBiasHours: number | null;
    readonly waitQuantumMinutes: number | null;
    readonly allocationDurationMonths: number | null;
  };
  readonly ordering: string;
  readonly tokenRecipe: string;
  readonly items: readonly RunCandidate[];
}

/**
 * Nullable for the same reason `Fairness` is: a client build can meet a server build
 * that does not send a figure yet, and a dashboard that prints NaN at display scale is
 * worse than one that says it does not know.
 */
export interface FairnessMetrics {
  readonly residents: number | null;
  readonly averageWaitHours: number | null;
  readonly maxWaitHours: number | null;
  /** Residents with no allocation that counted as served. */
  readonly neverServed: number | null;
  readonly distribution: readonly { servedCount: number | null; residents: number | null }[];
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

/**
 * Rule A. The policy numbers an administrator owns, versioned and append-only on the
 * server: a run stamps the version it used, so changing a value never rewrites the
 * reasoning behind a draw that already happened.
 */
export interface AllocationConfig {
  readonly version: number;
  /** How long an assignment lasts. The brief says three months; nothing says hardcode it. */
  readonly allocationDurationMonths: number;
  /** Rule F, in hours. How long a resident who just finished is held back. */
  readonly earlyWaitingBiasHours: number;
  /** The granularity at which two waiting times count as equal, so ties really occur. */
  readonly waitQuantumMinutes: number;
  /**
   * Consecutive periods a resident may sit out before their waiting time restarts.
   * 1 means missing a single period costs the clock; null disables the reset.
   */
  readonly absenceResetPeriods: number | null;
  /** Bays the scheme allocates. 0 means the whole active inventory. */
  readonly totalBays: number;
}

/**
 * A stored version with its audit columns. Separate from `AllocationConfig` because the
 * policy value and the record of who set it are different things: the form edits the
 * first, the history reads the second.
 */
export interface AllocationConfigVersion extends AllocationConfig {
  readonly changedAt: Date;
  readonly changedBy: string | null;
}

export interface AllocationConfigView {
  readonly config: AllocationConfig;
  /** Server-side advice, e.g. a bias wider than a whole period freezes the normal order. */
  readonly warnings: readonly string[];
}

export type AllocationConfigPatch = Partial<Omit<AllocationConfig, 'version'>>;