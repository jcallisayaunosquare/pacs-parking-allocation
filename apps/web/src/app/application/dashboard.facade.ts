import { Injectable, computed, inject, resource, signal } from '@angular/core';
import { CycleRepository, DashboardRepository } from '../domain/repositories';
import type { ApiError } from '../domain/models';
import { toApiError } from '../core/http/api-error';
import { viewState } from './async-state';

/**
 * The resident dashboard, as one page-level query feeding presentational children —
 * §17's rule, and the reason the screen is not six spinners and four race conditions.
 *
 * Mutations are optimistic where the outcome is obvious (entering the raffle) and
 * confirmed where it is not (releasing a spot, which promotes someone else). A failure
 * restores the previous state and explains why, rather than leaving the UI lying.
 */
@Injectable({ providedIn: 'root' })
export class DashboardFacade {
  private readonly dashboards = inject(DashboardRepository);
  private readonly cycles = inject(CycleRepository);

  private readonly dashboard = resource({
    loader: () => this.dashboards.load(),
  });

  private readonly historyLimit = signal(25);
  private readonly historyRes = resource({
    params: () => ({ limit: this.historyLimit() }),
    loader: ({ params }) => this.dashboards.history(params.limit),
  });

  /** Set while a mutation is in flight, so buttons can disable without a global spinner. */
  private readonly _busy = signal(false);
  private readonly _mutationError = signal<ApiError | null>(null);
  /** Shown optimistically the moment the resident enters the raffle. */
  private readonly _optimisticallyRegistered = signal(false);

  readonly state = viewState(this.dashboard);
  readonly historyState = viewState(this.historyRes, (h) => h.length === 0);

  readonly value = computed(() => this.dashboard.value());
  readonly history = computed(() => this.historyRes.value() ?? []);
  readonly busy = this._busy.asReadonly();
  readonly mutationError = this._mutationError.asReadonly();

  readonly assignment = computed(() => this.dashboard.value()?.assignment ?? null);
  readonly waitlist = computed(() => this.dashboard.value()?.waitlist ?? null);
  readonly fairness = computed(() => this.dashboard.value()?.fairness ?? null);
  readonly nextCycle = computed(() => this.dashboard.value()?.nextCycle ?? null);
  readonly resident = computed(() => this.dashboard.value()?.resident ?? null);

  /** Which of §17's three dashboard states to render. */
  readonly situation = computed<'holds-spot' | 'waitlisted' | 'registration-open' | 'idle'>(() => {
    const d = this.dashboard.value();
    if (!d) return 'idle';
    if (d.assignment) return 'holds-spot';
    if (d.waitlist) return 'waitlisted';
    if (d.nextCycle?.state === 'REGISTRATION_OPEN') return 'registration-open';
    return 'idle';
  });

  readonly canRegister = computed(
    () =>
      this.situation() === 'registration-open' &&
      !this._optimisticallyRegistered() &&
      (this.resident()?.isEligible ?? false),
  );
  readonly registered = this._optimisticallyRegistered.asReadonly();

  refresh(): void {
    this.dashboard.reload();
    this.historyRes.reload();
  }

  /** UC-08. Optimistic: the pill flips immediately, and rolls back on failure. */
  async register(): Promise<boolean> {
    const cycle = this.nextCycle();
    if (!cycle) return false;

    this._mutationError.set(null);
    this._optimisticallyRegistered.set(true);
    this._busy.set(true);
    try {
      await this.cycles.register(cycle.id);
      this.refresh();
      return true;
    } catch (e) {
      this._optimisticallyRegistered.set(false);
      this._mutationError.set(toApiError(e));
      return false;
    } finally {
      this._busy.set(false);
    }
  }

  async withdraw(): Promise<boolean> {
    const cycle = this.nextCycle();
    if (!cycle) return false;

    this._mutationError.set(null);
    this._busy.set(true);
    try {
      await this.cycles.withdraw(cycle.id);
      this._optimisticallyRegistered.set(false);
      this.refresh();
      return true;
    } catch (e) {
      this._mutationError.set(toApiError(e));
      return false;
    } finally {
      this._busy.set(false);
    }
  }

  /**
   * UC-11. Not optimistic: giving up a spot promotes the waitlist head, so the screen
   * waits for the server rather than guessing at a change it cannot predict.
   */
  async releaseSpot(): Promise<boolean> {
    this._mutationError.set(null);
    this._busy.set(true);
    try {
      await this.dashboards.releaseAssignment();
      this.refresh();
      return true;
    } catch (e) {
      this._mutationError.set(toApiError(e));
      return false;
    } finally {
      this._busy.set(false);
    }
  }

  dismissError(): void {
    this._mutationError.set(null);
  }
}
