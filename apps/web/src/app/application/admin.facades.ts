import { Injectable, Injector, computed, inject, resource, signal } from '@angular/core';
import type { ApiError, ParkingSpot, SpotType, Vehicle, VehicleDraft } from '../domain/models';
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
import { peek, reloaded, viewState } from './async-state';

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
  private readonly injector = inject(Injector);

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

  private readonly vehicleRepo = inject(VehicleRepository);

  /**
   * The cars of the residents on the page, for the register's Vehicles column.
   *
   * One request per resident shown - at most a page, fifteen, in parallel - because
   * GET /residents deliberately carries no vehicles (routes.ts: the list does not want
   * them). The right shape is the list returning each resident's plates in the same
   * query; that is a server change and a deploy, and this is the version that needs
   * neither. Keyed on the ids, so paging, sorting and filtering refetch exactly the rows
   * now on screen. A resident whose request fails shows no plates rather than failing
   * the column for everyone.
   */
  private readonly fleet = resource({
    params: () => ({ ids: this.residents().map((r) => r.id) }),
    loader: async ({ params }) => {
      const entries = await Promise.all(
        params.ids.map(async (id) => {
          try {
            return [id, await this.vehicleRepo.list(id)] as const;
          } catch {
            return [id, [] as readonly Vehicle[]] as const;
          }
        }),
      );
      return new Map(entries);
    },
  });

  /** Plates per resident on the page; undefined while the first load is in flight. */
  readonly vehiclesByResident = computed(() => peek(this.fleet));

  /** After the vehicle register has been edited, the column catches up. */
  refreshVehicles(): void {
    this.fleet.reload();
  }

  /**
   * A resident's car, added or changed from the register.
   *
   * On this facade rather than a separate one, because the register is where it is
   * shown: the Vehicles column has to show the new plate before the dialog closes, so
   * the write is over only once the fleet has been refetched - the same rule as every
   * other mutation here.
   */
  addVehicle(residentId: string, draft: VehicleDraft): Promise<Vehicle | null> {
    return this.mutateFleet(() => this.vehicleRepo.add(residentId, draft));
  }

  updateVehicle(
    residentId: string,
    vehicleId: string,
    patch: Partial<VehicleDraft>,
  ): Promise<Vehicle | null> {
    return this.mutateFleet(() => this.vehicleRepo.update(residentId, vehicleId, patch));
  }

  private async mutateFleet<T>(fn: () => Promise<T>): Promise<T | null> {
    this._error.set(null);
    this._busy.set(true);
    try {
      const r = await fn();
      await reloaded(this.injector, this.fleet);
      return r;
    } catch (e) {
      this._error.set(toApiError(e));
      return null;
    } finally {
      this._busy.set(false);
    }
  }

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
      // The write is done when the table shows it, not when the server accepts it.
      await reloaded(this.injector, this.page);
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

@Injectable({ providedIn: 'root' })
export class SpotsFacade {
  private readonly repo = inject(SpotRepository);
  private readonly injector = inject(Injector);

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
      await reloaded(this.injector, this.list);
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
  private readonly injector = inject(Injector);

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
      await reloaded(this.injector, this.list);
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

  /** Ends the period in effect. The draw of the next period is refused until this runs. */
  closePeriod(id: string) {
    return this.mutate(() => this.cycles.closePeriod(id));
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
