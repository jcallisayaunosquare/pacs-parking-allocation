import { Injectable, computed, inject, resource, signal } from '@angular/core';
import { CycleRepository, DashboardRepository } from '../domain/repositories';
import type { ApiError } from '../domain/models';
import { toApiError } from '../core/http/api-error';
import { peek, viewState } from './async-state';

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
  /**
   * The optimistic override, and only that: `null` means "whatever the server last
   * said". It used to be a plain boolean starting at false, which made entering the
   * draw look like it had not happened the moment the page was reloaded — the flag was
   * client state with nothing behind it. `registeredForNextCycle` on the dashboard is
   * now the source of truth and this only covers the second between the click and the
   * reload.
   */
  private readonly _optimisticallyRegistered = signal<boolean | null>(null);

  readonly state = viewState(this.dashboard);
  readonly historyState = viewState(this.historyRes, (h) => h.length === 0);

  readonly value = computed(() => peek(this.dashboard));
  readonly history = computed(() => peek(this.historyRes) ?? []);
  readonly busy = this._busy.asReadonly();
  readonly mutationError = this._mutationError.asReadonly();

  readonly assignment = computed(() => peek(this.dashboard)?.assignment ?? null);
  readonly waitlist = computed(() => peek(this.dashboard)?.waitlist ?? null);
  readonly fairness = computed(() => peek(this.dashboard)?.fairness ?? null);
  readonly nextCycle = computed(() => peek(this.dashboard)?.nextCycle ?? null);
  readonly resident = computed(() => peek(this.dashboard)?.resident ?? null);

  /** Which of §17's three dashboard states to render. */
  readonly situation = computed<
    'holds-spot' | 'waitlisted' | 'registration-open' | 'draw-pending' | 'idle'
  >(() => {
    const d = peek(this.dashboard);
    if (!d) return 'idle';
    if (d.assignment) return 'holds-spot';
    if (d.waitlist) return 'waitlisted';
    if (d.nextCycle?.state === 'REGISTRATION_OPEN') return 'registration-open';
    if (this.drawPending()) return 'draw-pending';
    return 'idle';
  });

  /**
   * Entered in a period whose registration has closed and whose draw has not run. The
   * server only sends a closed period to someone who entered it, and nothing can be
   * changed any more - withdrawing is refused once registration closes - so this is a
   * state to be told about, not acted on.
   */
  readonly drawPending = computed(
    () =>
      peek(this.dashboard)?.nextCycle?.state === 'REGISTRATION_CLOSED' &&
      (peek(this.dashboard)?.registeredForNextCycle ?? false),
  );

  /**
   * Whether the coming period is taking entries at all.
   *
   * Separate from `situation()` on purpose: a resident holding a bay this period is in
   * the `holds-spot` state, and the bays rotate, so they have to enter the next draw
   * like everyone else. Keying the action off the situation hid it from exactly the
   * people with the most to lose by missing it.
   */
  readonly registrationOpen = computed(
    () => this.nextCycle()?.state === 'REGISTRATION_OPEN',
  );

  readonly registered = computed(
    () => this._optimisticallyRegistered() ?? this.value()?.registeredForNextCycle ?? false,
  );

  readonly canRegister = computed(
    () =>
      this.registrationOpen() &&
      !this.registered() &&
      (this.resident()?.isEligible ?? false),
  );

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
      // Back to the server's answer: the reload now carries it.
      this._optimisticallyRegistered.set(null);
      return true;
    } catch (e) {
      this._optimisticallyRegistered.set(null);
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
      this._optimisticallyRegistered.set(null);
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
