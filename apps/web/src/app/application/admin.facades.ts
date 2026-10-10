import { Injectable, computed, inject, resource, signal } from '@angular/core';
import type { ApiError, ParkingSpot, SpotType, VehicleDraft } from '../domain/models';
import type { ResidentSortField, SortDirection } from '../domain/repositories';
import {
  CycleRepository,
  MetricsRepository,
  ResidentRepository,
  RunRepository,
  SpotRepository,
  VehicleRepository,
} from '../domain/repositories';
import { toApiError } from '../core/http/api-error';
import { peek, viewState } from './async-state';

/**
 * Admin facades. Same shape throughout: a `resource` per list, signals for UI-visible
 * state, and mutations that reload rather than hand-patch the cache — invalidation
 * mirroring the server's rules (§17, §20) is cheaper to get right than a client-side
 * cache that can disagree with the database.
 *
 * Filters live in signals that the resource reads, so changing one refetches and the
 * previous page stays on screen while it does.
 */

@Injectable({ providedIn: 'root' })
export class ResidentsFacade {
  private readonly repo = inject(ResidentRepository);

  /** URL-linkable filters: an admin list should survive a reload (§17). */
  private readonly _unit = signal<string | undefined>(undefined);
  private readonly _eligible = signal<boolean | undefined>(undefined);
  readonly unit = this._unit.asReadonly();
  readonly eligible = this._eligible.asReadonly();
  readonly limit = signal(15);
  readonly sort = signal<ResidentSortField>('name');
  readonly dir = signal<SortDirection>('asc');

  private readonly cursor = signal<string | undefined>(undefined);
  /**
   * The cursors of the pages already visited, so "previous" is possible at all.
   *
   * Keyset paging only knows how to go forwards — a cursor says "after this row", not
   * "before it". Remembering where each page started is what turns that into a pager
   * someone can actually use, and it costs one string per page.
   */
  private readonly trail = signal<(string | undefined)[]>([]);

  private readonly page = resource({
    params: () => ({
      limit: this.limit(),
      cursor: this.cursor(),
      unit: this.unit(),
      eligible: this.eligible(),
      sort: this.sort(),
      dir: this.dir(),
    }),
    loader: ({ params }) =>
      this.repo.list({
        limit: params.limit,
        sort: params.sort,
        dir: params.dir,
        ...(params.cursor ? { cursor: params.cursor } : {}),
        ...(params.unit ? { unit: params.unit } : {}),
        ...(params.eligible === undefined ? {} : { eligible: params.eligible }),
      }),
  });

  private readonly _busy = signal(false);
  private readonly _error = signal<ApiError | null>(null);

  readonly state = viewState(this.page, (p) => p.items.length === 0);
  readonly residents = computed(() => peek(this.page)?.items ?? []);
  readonly nextCursor = computed(() => peek(this.page)?.nextCursor ?? null);
  readonly busy = this._busy.asReadonly();
  readonly error = this._error.asReadonly();

  readonly pageNumber = computed(() => this.trail().length + 1);
  /**
   * How many rows came before this page, so the row numbers in the table keep counting
   * across pages rather than restarting at 1 on every one.
   *
   * The trail already records one entry per page left behind, and every page but the last
   * is full, so this is exact for the pages a reader can be on. It is a position in the
   * list, not an identifier - sorting or filtering renumbers the rows, which is what a
   * reader of a sorted list expects.
   */
  readonly rowOffset = computed(() => this.trail().length * this.limit());
  readonly hasPrevious = computed(() => this.trail().length > 0);
  readonly hasNext = computed(() => this.nextCursor() !== null);

  nextPage(): void {
    const c = this.nextCursor();
    if (!c) return;
    this.trail.update((t) => [...t, this.cursor()]);
    this.cursor.set(c);
  }

  previousPage(): void {
    const t = this.trail();
    if (t.length === 0) return;
    this.cursor.set(t[t.length - 1]);
    this.trail.set(t.slice(0, -1));
  }

  /**
   * Sorting by a column starts the list again. The cursor describes a position in one
   * particular ordering, so carrying it into another would land on an unrelated row.
   */
  sortBy(field: ResidentSortField): void {
    if (this.sort() === field) {
      this.dir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sort.set(field);
      this.dir.set('asc');
    }
    this.firstPage();
  }

  /** The same restart, for a caller that already knows both halves — MatSort does. */
  setSort(field: ResidentSortField, dir: SortDirection): void {
    this.sort.set(field);
    this.dir.set(dir);
    this.firstPage();
  }

  firstPage(): void {
    this.cursor.set(undefined);
    this.trail.set([]);
  }

  /**
   * Changing a filter restarts the list, for the same reason sorting does: the cursor
   * describes a position in the ordering the previous query produced. Keeping it asks
   * the server for rows after a row the new filter has removed, and the answer is an
   * empty page — the list reads "No residents match" while matching residents exist.
   */
  setUnit(v: string | undefined): void {
    this._unit.set(v);
    this.firstPage();
  }

  setEligible(v: boolean | undefined): void {
    this._eligible.set(v);
    this.firstPage();
  }

  resetFilters(): void {
    this._unit.set(undefined);
    this._eligible.set(undefined);
    this.firstPage();
  }

  refresh(): void {
    this.page.reload();
  }

  private async mutate<T>(fn: () => Promise<T>): Promise<T | null> {
    this._error.set(null);
    this._busy.set(true);
    try {
      const r = await fn();
      this.page.reload();
      return r;
    } catch (e) {
      this._error.set(toApiError(e));
      return null;
    } finally {
      this._busy.set(false);
    }
  }

  create(input: {
    email: string;
    fullName: string;
    unitNumber: string;
    needsAccessibleSpot: boolean;
  }) {
    return this.mutate(() => this.repo.create(input));
  }

  update(id: string, patch: { fullName?: string; unitNumber?: string; needsAccessibleSpot?: boolean }) {
    return this.mutate(() => this.repo.update(id, patch));
  }

  /** FR-15: a reason is mandatory when marking someone ineligible, and is audit-logged. */
  setEligibility(id: string, isEligible: boolean, reason: string | null) {
    return this.mutate(() => this.repo.setEligibility(id, isEligible, reason));
  }

  deactivate(id: string) {
    return this.mutate(() => this.repo.deactivate(id));
  }

  dismissError(): void {
    this._error.set(null);
  }
}

/**
 * One resident's vehicles.
 *
 * Not `providedIn: 'root'`: the state is "the vehicles of the resident currently being
 * worked on", so it is provided by the dialog that does the working and dies with it.
 * A root-scoped version would keep the previous resident's cars in memory and show them
 * for a frame the next time the dialog opens, which reads as the wrong person's car.
 *
 * `residentId` is a signal the resource reads, so setting it loads — the same
 * stale-while-revalidate shape as every other facade here.
 */
@Injectable()
export class VehiclesFacade {
  private readonly repo = inject(VehicleRepository);

  private readonly _residentId = signal<string | null>(null);
  readonly residentId = this._residentId.asReadonly();

  private readonly list = resource({
    params: () => ({ residentId: this._residentId() }),
    loader: ({ params }) =>
      params.residentId ? this.repo.list(params.residentId) : Promise.resolve([]),
  });

  private readonly _busy = signal(false);
  private readonly _error = signal<ApiError | null>(null);

  readonly state = viewState(this.list, (v) => v.length === 0);
  readonly vehicles = computed(() => peek(this.list) ?? []);
  readonly busy = this._busy.asReadonly();
  readonly error = this._error.asReadonly();

  for(residentId: string): void {
    this._residentId.set(residentId);
  }

  refresh(): void {
    this.list.reload();
  }

  private async mutate<T>(fn: (residentId: string) => Promise<T>): Promise<T | null> {
    const id = this._residentId();
    if (!id) return null;
    this._error.set(null);
    this._busy.set(true);
    try {
      const r = await fn(id);
      this.list.reload();
      return r;
    } catch (e) {
      this._error.set(toApiError(e));
      return null;
    } finally {
      this._busy.set(false);
    }
  }

  add(input: VehicleDraft) {
    return this.mutate((id) => this.repo.add(id, input));
  }

  update(vehicleId: string, patch: Partial<VehicleDraft>) {
    return this.mutate((id) => this.repo.update(id, vehicleId, patch));
  }

  /**
   * Removal is a deactivation server-side: the row stays so a past gate reading still
   * resolves to a car, and the plate is freed for whoever owns the car next.
   */
  remove(vehicleId: string) {
    return this.mutate((id) => this.repo.remove(id, vehicleId));
  }

  dismissError(): void {
    this._error.set(null);
  }
}

@Injectable({ providedIn: 'root' })
export class SpotsFacade {
  private readonly repo = inject(SpotRepository);

  readonly activeOnly = signal(false);
  readonly type = signal<SpotType | undefined>(undefined);

  private readonly list = resource({
    params: () => ({ activeOnly: this.activeOnly(), type: this.type() }),
    loader: ({ params }) =>
      this.repo.list({
        activeOnly: params.activeOnly,
        ...(params.type ? { type: params.type } : {}),
      }),
  });

  private readonly _busy = signal(false);
  private readonly _error = signal<ApiError | null>(null);

  readonly state = viewState(this.list, (s) => s.length === 0);
  readonly spots = computed(() => peek(this.list) ?? []);
  readonly busy = this._busy.asReadonly();
  readonly error = this._error.asReadonly();

  readonly counts = computed(() => {
    const all = this.spots();
    return {
      total: all.length,
      active: all.filter((s) => s.isActive).length,
      accessible: all.filter((s) => s.type === 'ACCESSIBLE').length,
      ev: all.filter((s) => s.type === 'EV').length,
    };
  });

  refresh(): void {
    this.list.reload();
  }

  private async mutate<T>(fn: () => Promise<T>): Promise<T | null> {
    this._error.set(null);
    this._busy.set(true);
    try {
      const r = await fn();
      this.list.reload();
      return r;
    } catch (e) {
      this._error.set(toApiError(e));
      return null;
    } finally {
      this._busy.set(false);
    }
  }

  create(input: { spotCode: string; level: string; type: SpotType; notes: string | null }) {
    return this.mutate(() => this.repo.create(input));
  }

  /** Deactivation is refused server-side while the spot is assigned — surfaced as 409. */
  setActive(spot: ParkingSpot, isActive: boolean) {
    return this.mutate(() => this.repo.update(spot.id, { isActive }));
  }

  update(
    id: string,
    patch: { level?: string; type?: SpotType; notes?: string | null; isActive?: boolean },
  ) {
    return this.mutate(() => this.repo.update(id, patch));
  }

  dismissError(): void {
    this._error.set(null);
  }
}

@Injectable({ providedIn: 'root' })
export class CyclesFacade {
  private readonly cycles = inject(CycleRepository);
  private readonly runs = inject(RunRepository);

  private readonly list = resource({ loader: () => this.cycles.list() });

  private readonly _busy = signal(false);
  private readonly _error = signal<ApiError | null>(null);
  private readonly _lastRun = signal<import('../domain/models').RunResult | null>(null);

  readonly state = viewState(this.list, (c) => c.length === 0);
  readonly allCycles = computed(() => peek(this.list) ?? []);
  readonly busy = this._busy.asReadonly();
  readonly error = this._error.asReadonly();
  readonly lastRun = this._lastRun.asReadonly();

  /** The one cycle a run may start from (§11). */
  readonly runnable = computed(() =>
    this.allCycles().find((c) => c.state === 'REGISTRATION_CLOSED') ?? null,
  );
  readonly active = computed(() => this.allCycles().find((c) => c.state === 'ACTIVE') ?? null);

  refresh(): void {
    this.list.reload();
  }

  private async mutate<T>(fn: () => Promise<T>): Promise<T | null> {
    this._error.set(null);
    this._busy.set(true);
    try {
      const r = await fn();
      this.list.reload();
      return r;
    } catch (e) {
      this._error.set(toApiError(e));
      return null;
    } finally {
      this._busy.set(false);
    }
  }

  create(input: {
    label?: string;
    startsOn: string;
    /** Omitted means the server derives it from Period length in the allocation rules. */
    endsOn?: string;
    registrationOpensAt: string;
    registrationClosesAt: string;
  }) {
    return this.mutate(() => this.cycles.create(input));
  }

  rename(id: string, label: string) {
    return this.mutate(() => this.cycles.rename(id, label));
  }

  remove(id: string) {
    return this.mutate(() => this.cycles.remove(id));
  }

  openRegistration(id: string) {
    return this.mutate(() => this.cycles.openRegistration(id));
  }

  closeRegistration(id: string) {
    return this.mutate(() => this.cycles.closeRegistration(id));
  }

  /**
   * UC-05. The idempotency key is generated once per cycle and attempt window, so a
   * double click or a retried request replays the original run instead of drawing again
   * (§12, §16).
   */
  async executeRun(cycleId: string): Promise<boolean> {
    const key = `ui-${cycleId}-${crypto.randomUUID()}`;
    const run = await this.mutate(() => this.runs.execute(cycleId, key));
    if (run) this._lastRun.set(run);
    return run !== null;
  }

  async loadRun(runId: string): Promise<void> {
    try {
      this._lastRun.set(await this.runs.get(runId));
    } catch (e) {
      this._error.set(toApiError(e));
    }
  }

  assignmentsOf(runId: string) {
    return this.runs.assignments(runId);
  }

  dismissError(): void {
    this._error.set(null);
  }
}

@Injectable({ providedIn: 'root' })
export class MetricsFacade {
  private readonly repo = inject(MetricsRepository);

  private readonly metrics = resource({ loader: () => this.repo.fairness() });

  readonly state = viewState(this.metrics, (m) => m.residents === 0);
  readonly value = computed(() => peek(this.metrics) ?? null);

  /** Bars for the distribution chart, normalised so the tallest is 100%. */
  readonly distribution = computed(() => {
    // A row the server did not fill is dropped rather than drawn as a zero-length bar:
    // a chart has to be read at a glance, and an absent row read as "nobody" is a lie.
    const d = peek(this.metrics)?.distribution ?? [];
    const rows = d.filter(
      (x): x is { servedCount: number; residents: number } =>
        x.servedCount !== null && x.residents !== null,
    );
    const max = Math.max(1, ...rows.map((x) => x.residents));
    return rows.map((x) => ({ ...x, percent: Math.round((x.residents / max) * 100) }));
  });

  refresh(): void {
    this.metrics.reload();
  }

  async downloadQuarterlyCsv(cycleId: string, label: string): Promise<void> {
    const csv = await this.repo.quarterlyReportCsv(cycleId);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `pacs-${label}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
