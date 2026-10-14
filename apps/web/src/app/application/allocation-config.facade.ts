import { Injectable, Injector, computed, inject, resource, signal } from '@angular/core';
import { AllocationConfigRepository } from '../domain/repositories';
import type {
  AllocationConfig,
  AllocationConfigPatch,
  AllocationConfigVersion,
  ApiError,
} from '../domain/models';
import { toApiError } from '../core/http/api-error';
import { peek, reloaded, viewState } from './async-state';

/**
 * The policy values' allowed ranges, from the contract (openapi.yaml:1051-1055), each
 * with the sentence the field shows. Whole numbers only: every one of these is a count.
 */
const RANGES = {
  allocationDurationMonths: {
    min: 1,
    max: 60,
    message: 'A whole number of months, from 1 to 60.',
  },
  earlyWaitingBiasHours: {
    min: 0,
    max: 8760,
    message: 'A whole number of hours, from 0 to 8760 (a year). 0 switches it off.',
  },
  waitQuantumMinutes: { min: 1, max: undefined, message: 'A whole number of minutes, 1 or more.' },
  absenceResetPeriods: { min: 1, max: undefined, message: 'A whole number of periods, 1 or more.' },
  totalBays: { min: 0, max: undefined, message: 'A whole number of bays, 0 or more.' },
} as const;

/**
 * Rule A's configuration, as an editable form over a versioned server record.
 *
 * The draft is held apart from the saved value so the screen can show what is about to
 * change before it changes, and so a failed save leaves the typed numbers on screen
 * rather than silently reverting them. Saving sends only the fields that actually differ:
 * a patch inserts a new version on the server, and a version whose every value equals the
 * previous one is noise in an audit trail that exists to explain past draws.
 */
@Injectable({ providedIn: 'root' })
export class AllocationConfigFacade {
  private readonly repo = inject(AllocationConfigRepository);
  private readonly injector = inject(Injector);

  private readonly res = resource({ loader: () => this.repo.current() });

  /**
   * The versions behind the current one. Loaded on demand rather than with the form: an
   * administrator changing a number does not need the audit trail on screen to do it,
   * and a request nobody asked for is a request nobody should pay for.
   */
  private readonly _versions = signal<readonly AllocationConfigVersion[] | null>(null);
  private readonly _historyBusy = signal(false);
  readonly versions = this._versions.asReadonly();
  readonly historyBusy = this._historyBusy.asReadonly();

  private readonly _draft = signal<AllocationConfigPatch>({});
  private readonly _busy = signal(false);
  private readonly _error = signal<ApiError | null>(null);
  private readonly _savedVersion = signal<number | null>(null);

  readonly state = viewState(this.res);
  readonly saved = computed(() => peek(this.res)?.config ?? null);
  readonly warnings = computed(() => peek(this.res)?.warnings ?? []);
  readonly busy = this._busy.asReadonly();
  readonly error = this._error.asReadonly();
  /** Set after a successful save, so the screen can confirm which version it created. */
  readonly savedVersion = this._savedVersion.asReadonly();

  /** The saved value with the operator's edits laid over it. */
  readonly draft = computed<AllocationConfig | null>(() => {
    const saved = this.saved();
    return saved ? { ...saved, ...this._draft() } : null;
  });

  readonly dirty = computed(() => {
    const saved = this.saved();
    const draft = this._draft();
    if (!saved) return false;
    return (Object.keys(draft) as (keyof AllocationConfig)[]).some(
      (k) => draft[k as keyof AllocationConfigPatch] !== saved[k],
    );
  });

  /**
   * The changed fields only. An empty result means the form is back where it started,
   * whatever route it took to get there.
   */
  private changes(): AllocationConfigPatch {
    const saved = this.saved();
    const draft = this._draft();
    if (!saved) return {};
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(draft)) {
      const key = k as keyof AllocationConfigPatch;
      if (draft[key] !== saved[key as keyof AllocationConfig]) out[k] = draft[key];
    }
    return out as AllocationConfigPatch;
  }

  edit<K extends keyof AllocationConfigPatch>(field: K, value: AllocationConfigPatch[K]): void {
    this._savedVersion.set(null);
    this._draft.update((d) => ({ ...d, [field]: value }));
  }

  reset(): void {
    this._draft.set({});
    this._error.set(null);
    this._savedVersion.set(null);
  }

  async save(): Promise<boolean> {
    const patch = this.changes();
    if (Object.keys(patch).length === 0) return true;
    // Each objection is already printed under its field; sending would only earn a 400.
    if (this.clientIssues().size > 0) return false;

    this._error.set(null);
    this._busy.set(true);
    try {
      const view = await this.repo.patch(patch);
      /*
       * Reload first, clear the draft after. The other order cleared the edits while the
       * saved value was still the old one, so for the length of the reload the form showed
       * the numbers from before the save - a revert, on screen, of a save that worked.
       */
      await reloaded(this.injector, this.res);
      this._draft.set({});
      this._savedVersion.set(view.config.version);
      if (this._versions() !== null) void this.reloadHistory();
      return true;
    } catch (e) {
      this._error.set(toApiError(e));
      return false;
    } finally {
      this._busy.set(false);
    }
  }

  /** Toggles the history open, fetching it the first time it is asked for. */
  async toggleHistory(): Promise<void> {
    if (this._versions() !== null) {
      this._versions.set(null);
      return;
    }
    this._historyBusy.set(true);
    this._error.set(null);
    try {
      this._versions.set(await this.repo.history(15));
    } catch (e) {
      this._error.set(toApiError(e));
    } finally {
      this._historyBusy.set(false);
    }
  }

  /**
   * The server's field-level complaints, by field. Validation lives in the domain on both
   * sides, so a rejected save names the field it rejected - and the form has to put that
   * message next to the input rather than dropping it into one banner at the top.
   */
  /**
   * What is wrong with the numbers typed so far, before anything is sent.
   *
   * Only fields that have been edited are checked - the draft holds exactly those - so
   * opening the form shows no errors, and a field speaks up the moment it goes out of
   * range. The ranges are the contract's (see RANGES); the server checks the same ones.
   */
  readonly clientIssues = computed(() => {
    const map = new Map<string, string>();
    for (const [field, value] of Object.entries(this._draft())) {
      const range = RANGES[field as keyof typeof RANGES];
      if (!range || value === null) continue;
      const n = value as number;
      if (!Number.isInteger(n) || n < range.min || (range.max !== undefined && n > range.max)) {
        map.set(field, range.message);
      }
    }
    return map;
  });

  /** The client's objection to a field first, then the server's, one message per field. */
  readonly issues = computed(() => {
    const map = new Map<string, string>();
    for (const d of this._error()?.details ?? []) map.set(d.field, d.issue);
    for (const [field, issue] of this.clientIssues()) map.set(field, issue);
    return map;
  });

  refresh(): void {
    this.res.reload();
    // The trail has a new entry after every save, so a stale one must not linger.
    if (this._versions() !== null) void this.reloadHistory();
  }

  private async reloadHistory(): Promise<void> {
    try {
      this._versions.set(await this.repo.history(15));
    } catch {
      // The form is what matters here; a failed trail refresh closes it rather than
      // replacing the save's own confirmation with an error about something else.
      this._versions.set(null);
    }
  }

  dismissError(): void {
    this._error.set(null);
  }
}
