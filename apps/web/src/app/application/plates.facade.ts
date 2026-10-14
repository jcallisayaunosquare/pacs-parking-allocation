import { Injectable, Injector, computed, effect, inject, resource, signal } from '@angular/core';
import type { ApiError, PlateRead, PlateReviewDraft } from '../domain/models';
import { PlateRepository } from '../domain/repositories';
import { toApiError } from '../core/http/api-error';
import { peek, reloaded, viewState } from './async-state';

/**
 * The gate log (M-7). Same shape as the other admin facades: a `resource` per list,
 * filters in signals the resource reads, and a mutation that reloads rather than
 * hand-patching the cache.
 *
 * Reloading after a review is not laziness here, it is correctness. Resolving a read can
 * change the row's status, its plate, its matched resident, its bay and its decision, and
 * it can also change whether the row still belongs in the current filter - a reviewed
 * read drops straight out of the review queue. Patching that locally would be
 * reimplementing the server's rule in the client, which is the thing this layer exists to
 * avoid.
 */
@Injectable({ providedIn: 'root' })
export class PlatesFacade {
  private readonly repo = inject(PlateRepository);
  private readonly injector = inject(Injector);

  /**
   * The one filter the screen actually needs. "Needs review" is not the same query as
   * "status = REVIEW": the server returns it oldest first, because a doubtful read loses
   * its value once the car has gone.
   */
  readonly onlyReview = signal(false);
  readonly cameraId = signal<string | undefined>(undefined);
  readonly plate = signal<string | undefined>(undefined);
  readonly limit = signal(25);

  private readonly cursor = signal<string | undefined>(undefined);
  /** The cursors already visited, which is what makes "previous" possible at all. */
  private readonly trail = signal<(string | undefined)[]>([]);

  private readonly page = resource({
    params: () => ({
      limit: this.limit(),
      cursor: this.cursor(),
      needsReview: this.onlyReview(),
      cameraId: this.cameraId(),
      plate: this.plate(),
    }),
    loader: ({ params }) =>
      this.repo.list({
        limit: params.limit,
        ...(params.cursor ? { cursor: params.cursor } : {}),
        ...(params.needsReview ? { needsReview: true } : {}),
        ...(params.cameraId ? { cameraId: params.cameraId } : {}),
        ...(params.plate ? { plate: params.plate } : {}),
      }),
  });

  private readonly metricsRes = resource({ loader: () => this.repo.metrics() });

  private readonly _busy = signal(false);
  private readonly _error = signal<ApiError | null>(null);

  readonly state = viewState(this.page, (p) => p.items.length === 0);
  readonly reads = computed(() => peek(this.page)?.items ?? []);
  readonly nextCursor = computed(() => peek(this.page)?.nextCursor ?? null);
  readonly metrics = computed(() => peek(this.metricsRes) ?? null);
  readonly busy = this._busy.asReadonly();
  readonly error = this._error.asReadonly();

  /**
   * A reload in flight, as distinct from a first load.
   *
   * `resource` keeps the previous value while it reloads, so the table does not blink and
   * `state()` stays `ready`. That is the behaviour this screen wants - but it also means
   * nothing on screen says the fetch is happening, and a refresh control that gives no
   * answer gets pressed four times. This is what the control reads from.
   */
  readonly refreshing = computed(
    () => this.page.status() === 'reloading' || this.metricsRes.status() === 'reloading',
  );

  private readonly _refreshedAt = signal<Date | null>(null);
  /** When the rows on screen were last fetched, so the control can say how old they are. */
  readonly refreshedAt = this._refreshedAt.asReadonly();

  constructor() {
    /*
     * Stamped on every resolution rather than at the moment the button is pressed: the
     * figure has to describe the rows being displayed, and between the press and the
     * response the rows are still the old ones.
     */
    effect(() => {
      if (this.page.status() === 'resolved') this._refreshedAt.set(new Date());
    });
  }

  readonly pageNumber = computed(() => this.trail().length + 1);
  /**
   * Rows before this page, so the row number keeps counting across pages instead of
   * restarting at 1 - the same rule the register uses. A position in the list, not an
   * identifier: a new read arriving at the top renumbers everything below it.
   */
  readonly rowOffset = computed(() => this.trail().length * this.limit());
  readonly hasPrevious = computed(() => this.trail().length > 0);
  readonly hasNext = computed(() => this.nextCursor() !== null);

  /**
   * How many of the rows on screen still need somebody to look at them.
   *
   * Counted from the page rather than read from the metrics, deliberately: the metric
   * covers thirty days and this number has to agree with what the administrator can see,
   * or the filter chip claims a count the table does not show.
   */
  readonly pendingOnPage = computed(() => this.reads().filter((r) => r.needsReview).length);

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

  firstPage(): void {
    this.cursor.set(undefined);
    this.trail.set([]);
  }

  /**
   * Changing a filter restarts the list. A cursor describes a position in the ordering the
   * previous query produced, and the review queue is ordered the opposite way from the
   * log - so carrying one across would ask for rows after a row that is no longer in the
   * result, and the screen would read "nothing to review" while reads were waiting.
   */
  setOnlyReview(v: boolean): void {
    this.onlyReview.set(v);
    this.firstPage();
  }

  setCameraId(v: string | undefined): void {
    this.cameraId.set(v);
    this.firstPage();
  }

  setPlate(v: string | undefined): void {
    this.plate.set(v);
    this.firstPage();
  }

  refresh(): void {
    this.page.reload();
    this.metricsRes.reload();
  }

  /**
   * The correction. One key per attempt, so a double click replays the first decision
   * instead of writing a second one - the same contract the draw uses.
   *
   * A 409 is an expected outcome, not a crash: another administrator reviewed the same
   * read first. The list is reloaded either way so the screen shows their verdict.
   */
  async resolve(read: PlateRead, draft: PlateReviewDraft): Promise<boolean> {
    this._error.set(null);
    this._busy.set(true);
    try {
      await this.repo.resolve(read.id, draft, `ui-${read.id}-${crypto.randomUUID()}`);
      return true;
    } catch (e) {
      this._error.set(toApiError(e));
      return false;
    } finally {
      // Reloaded on both paths - a 409 means somebody else's verdict is now the true one
      // - and awaited, so the dialog closes onto a log that already shows the decision.
      await reloaded(this.injector, this.page, this.metricsRes);
      this._busy.set(false);
    }
  }

  dismissError(): void {
    this._error.set(null);
  }
}
