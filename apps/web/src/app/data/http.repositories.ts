import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import type {
  Cycle,
  Dashboard,
  FairnessMetrics,
  HistoryEntry,
  Page,
  ParkingSpot,
  PlateMetrics,
  PlateRead,
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
  AllocationConfigPatch,
  AllocationConfigVersion,
  AllocationConfigView,
} from '../domain/models';
import type { CaptureTicket, PlateReadListQuery, ResidentListQuery } from '../domain/repositories';
import {
  CaptureRepository,
  CycleRepository,
  DashboardRepository,
  MeRepository,
  MetricsRepository,
  PlateRepository,
  ResidentRepository,
  RunRepository,
  SpotRepository,
  VehicleRepository,
  AllocationConfigRepository,
} from '../domain/repositories';
import type {
  CycleDto,
  DashboardDto,
  FairnessMetricsDto,
  HistoryEntryDto,
  ItemsDto,
  MeDto,
  PageDto,
  ParkingSpotDto,
  PlateMetricsDto,
  PlateReadDto,
  PlateReviewInputDto,
  ResidentDto,
  RunAssignmentDto,
  RunExplanationDto,
  RunResultDto,
  RunSummaryDto,
  VehicleDto,
  VehicleInputDto,
  AllocationConfigVersionDto,
  AllocationConfigViewDto,
} from './dto';
import {
  toConfigVersion,
  toCycle,
  toDashboard,
  toFairnessMetrics,
  toHistoryEntry,
  toPage,
  toPlateMetrics,
  toPlateRead,
  toPrincipal,
  toResident,
  toRunAssignment,
  toRunExplanation,
  toRunResult,
  toRunSummary,
  toSpot,
  toVehicle,
} from './mappers';

/**
 * The data ring (§10): the only place that knows HttpClient exists. Each class
 * implements the matching abstract contract from `domain/repositories.ts`, so the
 * application ring above it is testable with a fake and the transport can change
 * without touching a facade or a page.
 */
const API = environment.apiBaseUrl;

@Injectable()
export class HttpMeRepository extends MeRepository {
  private readonly http = inject(HttpClient);

  async principal(): Promise<Principal> {
    return toPrincipal(await firstValueFrom(this.http.get<MeDto>(`${API}/me`)));
  }
}

@Injectable()
export class HttpDashboardRepository extends DashboardRepository {
  private readonly http = inject(HttpClient);

  async load(): Promise<Dashboard> {
    return toDashboard(await firstValueFrom(this.http.get<DashboardDto>(`${API}/me/dashboard`)));
  }

  async history(limit: number): Promise<readonly HistoryEntry[]> {
    const res = await firstValueFrom(
      this.http.get<PageDto<HistoryEntryDto>>(`${API}/me/history`, {
        params: new HttpParams().set('limit', limit),
      }),
    );
    return (res.items ?? []).map(toHistoryEntry);
  }

  async releaseAssignment(): Promise<{ promotedResidentId: string | null }> {
    return firstValueFrom(
      this.http.post<{ promotedResidentId: string | null }>(
        `${API}/me/assignment/release`,
        {},
      ),
    );
  }
}

@Injectable()
export class HttpResidentRepository extends ResidentRepository {
  private readonly http = inject(HttpClient);

  async list(input: ResidentListQuery): Promise<Page<Resident>> {
    let params = new HttpParams().set('limit', input.limit);
    if (input.cursor) params = params.set('cursor', input.cursor);
    if (input.unit) params = params.set('unit', input.unit);
    if (input.eligible !== undefined) params = params.set('eligible', input.eligible);
    if (input.sort) params = params.set('sort', input.sort);
    if (input.dir) params = params.set('dir', input.dir);

    const res = await firstValueFrom(
      this.http.get<PageDto<ResidentDto>>(`${API}/residents`, { params }),
    );
    return toPage(res, toResident);
  }

  async get(id: string): Promise<Resident> {
    return toResident(await firstValueFrom(this.http.get<ResidentDto>(`${API}/residents/${id}`)));
  }

  async create(input: {
    email: string;
    fullName: string;
    unitNumber: string;
    needsAccessibleSpot: boolean;
  }): Promise<Resident> {
    return toResident(
      await firstValueFrom(this.http.post<ResidentDto>(`${API}/residents`, input)),
    );
  }

  async update(
    id: string,
    patch: { fullName?: string; unitNumber?: string; needsAccessibleSpot?: boolean },
  ): Promise<Resident> {
    return toResident(
      await firstValueFrom(this.http.patch<ResidentDto>(`${API}/residents/${id}`, patch)),
    );
  }

  async setEligibility(id: string, isEligible: boolean, reason: string | null): Promise<Resident> {
    return toResident(
      await firstValueFrom(
        this.http.patch<ResidentDto>(`${API}/residents/${id}/eligibility`, {
          isEligible,
          reason,
        }),
      ),
    );
  }

  async deactivate(id: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${API}/residents/${id}`));
  }
}

/**
 * The vehicle register. The same four calls serve an administrator and a resident: the
 * server decides from the token whether the resident id in the path is theirs to touch,
 * and answers 404 rather than 403 when it is not — so there is nothing for the client to
 * assert here beyond the id it was given.
 */
@Injectable()
export class HttpVehicleRepository extends VehicleRepository {
  private readonly http = inject(HttpClient);

  async list(residentId: string): Promise<readonly Vehicle[]> {
    const res = await firstValueFrom(
      this.http.get<ItemsDto<VehicleDto>>(`${API}/residents/${residentId}/vehicles`),
    );
    return (res.items ?? []).map(toVehicle);
  }

  async add(residentId: string, input: VehicleDraft): Promise<Vehicle> {
    return toVehicle(
      await firstValueFrom(
        this.http.post<VehicleDto>(`${API}/residents/${residentId}/vehicles`, body(input)),
      ),
    );
  }

  async update(
    residentId: string,
    vehicleId: string,
    patch: Partial<VehicleDraft>,
  ): Promise<Vehicle> {
    return toVehicle(
      await firstValueFrom(
        this.http.patch<VehicleDto>(
          `${API}/residents/${residentId}/vehicles/${vehicleId}`,
          body(patch),
        ),
      ),
    );
  }

  async remove(residentId: string, vehicleId: string): Promise<void> {
    await firstValueFrom(
      this.http.delete<void>(`${API}/residents/${residentId}/vehicles/${vehicleId}`),
    );
  }
}

/**
 * Model → wire. Only the keys the caller actually set are sent: the server rejects an
 * empty patch, and a field sent back unchanged still counts as an edit.
 */
const body = (v: Partial<VehicleDraft>): VehicleInputDto => ({
  ...(v.plate === undefined ? {} : { plate: v.plate }),
  ...(v.make === undefined ? {} : { make: v.make }),
  ...(v.model === undefined ? {} : { model: v.model }),
  ...(v.year === undefined ? {} : { year: v.year }),
  ...(v.colour === undefined ? {} : { colour: v.colour }),
  ...(v.notes === undefined ? {} : { notes: v.notes }),
  ...(v.photos === undefined ? {} : { photos: [...v.photos] }),
});

/**
 * The gate log (M-7). Administrator-only server-side; a resident token gets 403.
 *
 * There is no recognition call here and there cannot be one: recognition is triggered by
 * a frame landing in S3, so this client's whole relationship with it is reading the result
 * and correcting it.
 */
@Injectable()
export class HttpPlateRepository extends PlateRepository {
  private readonly http = inject(HttpClient);

  async list(input: PlateReadListQuery): Promise<Page<PlateRead>> {
    let params = new HttpParams().set('limit', input.limit);
    if (input.cursor) params = params.set('cursor', input.cursor);
    if (input.status) params = params.set('status', input.status);
    if (input.cameraId) params = params.set('cameraId', input.cameraId);
    if (input.plate) params = params.set('plate', input.plate);
    if (input.needsReview) params = params.set('needsReview', true);

    /*
     * Two endpoints behind one method.
     *
     * `/plate-reads/review` is not just `/plate-reads?needsReview=true` with extra steps:
     * it is ordered oldest first, because a doubtful read loses its value once the car has
     * gone. Choosing here rather than exposing both keeps that ordering a property of the
     * filter, which is what a caller actually means by "show me what needs review".
     */
    const path = input.needsReview ? '/plate-reads/review' : '/plate-reads';
    const res = await firstValueFrom(
      this.http.get<PageDto<PlateReadDto>>(`${API}${path}`, { params }),
    );
    return toPage(res, toPlateRead);
  }

  /** The key travels as a header, so a retried click replays instead of deciding twice. */
  async resolve(
    plateReadId: string,
    draft: PlateReviewDraft,
    idempotencyKey: string,
  ): Promise<PlateRead> {
    const body: PlateReviewInputDto = {
      decision: draft.decision,
      ...(draft.plate === null ? {} : { plate: draft.plate }),
      ...(draft.vehicleId === null ? {} : { vehicleId: draft.vehicleId }),
      ...(draft.note === null ? {} : { note: draft.note }),
      ...(draft.discard ? { discard: true } : {}),
    };
    return toPlateRead(
      await firstValueFrom(
        this.http.post<PlateReadDto>(`${API}/plate-reads/${plateReadId}/resolve`, body, {
          headers: { 'Idempotency-Key': idempotencyKey },
        }),
      ),
    );
  }

  async metrics(): Promise<PlateMetrics> {
    return toPlateMetrics(
      await firstValueFrom(this.http.get<PlateMetricsDto>(`${API}/metrics/plates`)),
    );
  }
}

@Injectable()
export class HttpCaptureRepository extends CaptureRepository {
  private readonly http = inject(HttpClient);

  async ticket(input: {
    cameraId: string;
    capturedAt: Date;
    contentType: 'image/jpeg' | 'image/png';
  }): Promise<CaptureTicket> {
    return firstValueFrom(
      this.http.post<CaptureTicket>(`${API}/captures`, {
        cameraId: input.cameraId,
        capturedAt: input.capturedAt.toISOString(),
        contentType: input.contentType,
      }),
    );
  }

  /**
   * The bytes go to S3, not to us.
   *
   * `Content-Type` must be exactly what was signed, or S3 answers 403 and the failure
   * reads like a bad credential rather than a mismatched header. The bearer token is not
   * attached here because `authInterceptor` only signs requests to our own API - sending
   * it to another origin would be a credential leak, and S3 would reject the request for
   * carrying two forms of authorisation anyway.
   */
  async upload(ticket: CaptureTicket, frame: Blob): Promise<void> {
    await firstValueFrom(
      this.http.put(ticket.uploadUrl, frame, {
        headers: { 'Content-Type': frame.type },
        responseType: 'text',
      }),
    );
  }
}

@Injectable()
export class HttpSpotRepository extends SpotRepository {
  private readonly http = inject(HttpClient);

  async list(input: { activeOnly?: boolean; type?: SpotType } = {}): Promise<readonly ParkingSpot[]> {
    let params = new HttpParams();
    if (input.activeOnly) params = params.set('activeOnly', true);
    if (input.type) params = params.set('type', input.type);

    const res = await firstValueFrom(
      this.http.get<ItemsDto<ParkingSpotDto>>(`${API}/spots`, { params }),
    );
    return (res.items ?? []).map(toSpot);
  }

  async create(input: {
    spotCode: string;
    level: string;
    type: SpotType;
    notes: string | null;
  }): Promise<ParkingSpot> {
    return toSpot(await firstValueFrom(this.http.post<ParkingSpotDto>(`${API}/spots`, input)));
  }

  async update(
    id: string,
    patch: { level?: string; type?: SpotType; notes?: string | null; isActive?: boolean },
  ): Promise<ParkingSpot> {
    return toSpot(
      await firstValueFrom(this.http.patch<ParkingSpotDto>(`${API}/spots/${id}`, patch)),
    );
  }
}

@Injectable()
export class HttpCycleRepository extends CycleRepository {
  private readonly http = inject(HttpClient);

  async list(): Promise<readonly Cycle[]> {
    const res = await firstValueFrom(this.http.get<ItemsDto<CycleDto>>(`${API}/cycles`));
    return (res.items ?? []).map(toCycle);
  }

  async create(input: {
    label?: string;
    startsOn: string;
    endsOn?: string;
    registrationOpensAt: string;
    registrationClosesAt: string;
  }): Promise<Cycle> {
    return toCycle(await firstValueFrom(this.http.post<CycleDto>(`${API}/cycles`, input)));
  }

  async rename(id: string, label: string): Promise<Cycle> {
    return toCycle(
      await firstValueFrom(this.http.patch<CycleDto>(`${API}/cycles/${id}`, { label })),
    );
  }

  async remove(id: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${API}/cycles/${id}`));
  }

  async openRegistration(id: string): Promise<Cycle> {
    return toCycle(
      await firstValueFrom(this.http.post<CycleDto>(`${API}/cycles/${id}/open-registration`, {})),
    );
  }

  async closeRegistration(id: string): Promise<Cycle> {
    return toCycle(
      await firstValueFrom(this.http.post<CycleDto>(`${API}/cycles/${id}/close-registration`, {})),
    );
  }

  /**
   * Ends the period that is in effect, expiring the assignments it handed out.
   *
   * Not the same as closing registration, which shuts the door on entrants before a
   * draw. This ends the arrangement the draw produced, and it is what lets the next draw
   * run - one is refused while an allocation is in force.
   */
  async closePeriod(id: string): Promise<Cycle> {
    return toCycle(
      await firstValueFrom(this.http.post<CycleDto>(`${API}/cycles/${id}/close`, {})),
    );
  }

  async register(cycleId: string): Promise<void> {
    await firstValueFrom(this.http.post<void>(`${API}/cycles/${cycleId}/registrations`, {}));
  }

  async withdraw(cycleId: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${API}/cycles/${cycleId}/registrations/me`));
  }
}

@Injectable()
export class HttpRunRepository extends RunRepository {
  private readonly http = inject(HttpClient);

  /** The key travels as a header, so a retried click replays instead of re-drawing. */
  async execute(cycleId: string, idempotencyKey: string): Promise<RunResult> {
    return toRunResult(
      await firstValueFrom(
        this.http.post<RunResultDto>(
          `${API}/cycles/${cycleId}/runs`,
          {},
          { headers: { 'Idempotency-Key': idempotencyKey } },
        ),
      ),
    );
  }

  async get(runId: string): Promise<RunResult> {
    return toRunResult(await firstValueFrom(this.http.get<RunResultDto>(`${API}/runs/${runId}`)));
  }

  async list(limit: number): Promise<readonly RunSummary[]> {
    const res = await firstValueFrom(
      this.http.get<ItemsDto<RunSummaryDto>>(`${API}/runs`, { params: { limit } }),
    );
    return (res.items ?? []).map(toRunSummary);
  }

  async explanation(runId: string): Promise<RunExplanation> {
    return toRunExplanation(
      await firstValueFrom(this.http.get<RunExplanationDto>(`${API}/runs/${runId}/explanation`)),
    );
  }

  async assignments(runId: string): Promise<readonly RunAssignment[]> {
    const res = await firstValueFrom(
      this.http.get<ItemsDto<RunAssignmentDto>>(`${API}/runs/${runId}/assignments`),
    );
    return (res.items ?? []).map(toRunAssignment);
  }
}

@Injectable()
export class HttpMetricsRepository extends MetricsRepository {
  private readonly http = inject(HttpClient);

  async fairness(): Promise<FairnessMetrics> {
    return toFairnessMetrics(
      await firstValueFrom(this.http.get<FairnessMetricsDto>(`${API}/metrics/fairness`)),
    );
  }

  async quarterlyReportCsv(cycleId: string): Promise<string> {
    return firstValueFrom(
      this.http.get(`${API}/reports/quarterly/${cycleId}`, {
        params: new HttpParams().set('format', 'csv'),
        responseType: 'text',
      }),
    );
  }
}

/** Rule A's configuration. Admin only; the server rejects a resident token with 403. */
@Injectable()
export class HttpAllocationConfigRepository extends AllocationConfigRepository {
  private readonly http = inject(HttpClient);

  async current(): Promise<AllocationConfigView> {
    return firstValueFrom(
      this.http.get<AllocationConfigViewDto>(`${API}/config/allocation`),
    );
  }

  async patch(patch: AllocationConfigPatch): Promise<AllocationConfigView> {
    return firstValueFrom(
      this.http.patch<AllocationConfigViewDto>(`${API}/config/allocation`, patch),
    );
  }

  async history(limit: number): Promise<readonly AllocationConfigVersion[]> {
    const res = await firstValueFrom(
      this.http.get<{ items: AllocationConfigVersionDto[] }>(
        `${API}/config/allocation/history`,
        { params: { limit } },
      ),
    );
    return (res.items ?? []).map(toConfigVersion);
  }
}