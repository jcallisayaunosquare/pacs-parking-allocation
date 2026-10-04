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
  Principal,
  Resident,
  RunAssignment,
  RunResult,
  SpotType,
} from '../domain/models';
import {
  CycleRepository,
  DashboardRepository,
  MeRepository,
  MetricsRepository,
  ResidentRepository,
  RunRepository,
  SpotRepository,
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
  ResidentDto,
  RunAssignmentDto,
  RunResultDto,
} from './dto';
import {
  toCycle,
  toDashboard,
  toFairnessMetrics,
  toHistoryEntry,
  toPage,
  toPrincipal,
  toResident,
  toRunAssignment,
  toRunResult,
  toSpot,
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

  async list(input: {
    limit: number;
    cursor?: string;
    unit?: string;
    eligible?: boolean;
  }): Promise<Page<Resident>> {
    let params = new HttpParams().set('limit', input.limit);
    if (input.cursor) params = params.set('cursor', input.cursor);
    if (input.unit) params = params.set('unit', input.unit);
    if (input.eligible !== undefined) params = params.set('eligible', input.eligible);

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
    endsOn: string;
    registrationOpensAt: string;
    registrationClosesAt: string;
  }): Promise<Cycle> {
    return toCycle(await firstValueFrom(this.http.post<CycleDto>(`${API}/cycles`, input)));
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
