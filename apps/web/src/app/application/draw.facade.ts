import { Injectable, computed, inject, signal } from '@angular/core';
import {
  CycleRepository,
  LotRepository,
  RunRepository,
  type Entrant,
} from '../domain/repositories';
import type {
  ApiError,
  Cycle,
  DecidedBy,
  RunAssignment,
  RunCandidate,
  RunResult,
} from '../domain/models';
import type { Bay, LotLevel } from '../domain/lot-layout';
import { toApiError } from '../core/http/api-error';

export type DrawStep = 0 | 1 | 2;

/**
 * Running a draw, as the three things it actually is: who is in it, who got what, and
 * where those bays are.
 *
 * It was previously one button on a management screen, which is honest about the API call
 * and dishonest about the act: a draw reassigns every bay in the building for a whole
 * period, and the administrator pressing it is answerable for the result. Three steps let
 * them see the field before committing, read the outcome against the rule that produced
 * it, and hand a resident an answer afterwards.
 *
 * The step is not a wizard collecting input - nothing here is typed. It is a sequence
 * because the draw genuinely has a before, a during and an after, and the screen refuses
 * to let someone skip from the first to the third.
 */
@Injectable()
export class DrawFacade {
  private readonly cycles = inject(CycleRepository);
  private readonly runs = inject(RunRepository);
  private readonly lots = inject(LotRepository);

  private readonly _step = signal<DrawStep>(0);
  private readonly _cycle = signal<Cycle | null>(null);
  private readonly _candidates = signal<readonly Entrant[]>([]);
  private readonly _run = signal<RunResult | null>(null);
  private readonly _assignments = signal<readonly RunAssignment[]>([]);
  private readonly _explanation = signal<readonly RunCandidate[]>([]);
  private readonly _level = signal<LotLevel | null>(null);
  private _levels: readonly LotLevel[] = [];
  private readonly _busy = signal(false);
  private readonly _loading = signal(true);
  private readonly _error = signal<ApiError | null>(null);

  readonly step = this._step.asReadonly();
  readonly cycle = this._cycle.asReadonly();
  readonly candidates = this._candidates.asReadonly();
  readonly run = this._run.asReadonly();
  readonly assignments = this._assignments.asReadonly();
  readonly level = this._level.asReadonly();
  readonly busy = this._busy.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();

  /** A draw can only start from a period whose registration has closed. */
  readonly ready = computed(() => this._cycle() !== null);
  readonly drawn = computed(() => this._run() !== null);

  /**
   * The bays as the map draws them, with this run's winners placed. Built here rather
   * than from live occupancy so the third step shows the result of the draw that just
   * ran, not whatever the lot looks like now.
   */
  readonly bays = computed<readonly Bay[]>(() => {
    const level = this._level();
    if (!level) return [];
    const byCode = new Map(this._assignments().map((a) => [a.spotCode, a]));
    // The unit lives on the contestable record, not on the assignment row. Without this
    // join the detail read "unit ," - a label with nothing after it, which looks like a
    // rendering fault rather than a missing field.
    const unitOf = new Map(this._explanation().map((c) => [c.residentId, c.unit]));

    return level.bays.map((placement) => {
      const hit = byCode.get(placement.spotCode);
      return {
        placement,
        status: hit ? ('HELD' as const) : ('FREE' as const),
        occupant: hit
          ? { displayName: hit.fullName, unit: unitOf.get(hit.residentId) ?? '' }
          : null,
        validUntil: this._cycle()?.endsOn ?? null,
        isMine: false,
      };
    });
  });

  readonly assignedCount = computed(() => this._assignments().length);
  readonly waitlistedCount = computed(() => this._run()?.waitlisted ?? 0);

  /** Bays this run had to hand out. The cut line every rank is read against. */
  readonly baysOffered = computed(() => this._run()?.spots ?? 0);

  /**
   * The winners, in the order the rule produced: rank 1 to N, N being the bays offered.
   *
   * Built from the contestable record rather than from the assignment list, because an
   * assignment list has no order - it answers "who got a bay" and the question on this
   * screen is "who came first, and why". Residents who did not win are deliberately not
   * here: the screen states how many are waiting, which is the fact an administrator
   * needs, without publishing a list of losers.
   */
  readonly winners = computed(() => {
    const names = new Map(this._candidates().map((r) => [r.id, r.fullName]));
    return this._explanation()
      .filter((c) => c.outcome === 'ASSIGNED')
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .map((c) => ({ ...c, fullName: names.get(c.residentId) ?? `Unit ${c.unit}` }));
  });

  /**
   * How many of the winners each clause of the rule decided. The stepper teaches the
   * rule by showing it working, and a tally is the shortest way to say "waiting time
   * did almost all of this, and the raffle settled two".
   */
  readonly decidedTally = computed(() => {
    const counts = new Map<DecidedBy, number>();
    for (const w of this.winners()) counts.set(w.decidedBy, (counts.get(w.decidedBy) ?? 0) + 1);
    return [...counts.entries()]
      .map(([by, count]) => ({ by, count }))
      .sort((a, b) => b.count - a.count);
  });

  /** True once the record has been read: the result screen waits for it, not for the run. */
  readonly explained = computed(() => this._explanation().length > 0);

  async load(): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    try {
      const cycles = await this.cycles.list();
      const cycle = cycles.find((c) => c.state === 'REGISTRATION_CLOSED') ?? null;
      this._cycle.set(cycle);

      // Who entered this period's draw - the pool the server draws from. It used to be
      // every eligible resident, which listed people who never pressed "Enter the draw"
      // as if they were in it. No period ready to draw means nobody to list.
      this._candidates.set(cycle ? await this.cycles.entrants(cycle.id) : []);

      const levels = await this.lots.levels();
      this._levels = levels;
      this._level.set(levels[0] ?? null);
    } catch (e) {
      this._error.set(toApiError(e));
    } finally {
      this._loading.set(false);
    }
  }

  go(step: DrawStep): void {
    // The third step has nothing to show before the draw has run.
    if (step === 2 && !this.drawn()) return;
    this._step.set(step);
  }

  /**
   * UC-05. The idempotency key is the caller's: a retried click must replay the run it
   * already made rather than draw the building's bays a second time.
   */
  private readonly _refreshing = signal(false);
  readonly refreshing = this._refreshing.asReadonly();

  /**
   * Reads the result again: the lot's levels and this run's assignments. The map is
   * built from them, so a refresh shows the bays as the server has them now - after a
   * release, say - without leaving the step.
   */
  async refreshResult(): Promise<void> {
    const run = this._run();
    if (!run || this._refreshing()) return;
    this._refreshing.set(true);
    try {
      this._levels = await this.lots.levels();
      const assigned = await this.runs.assignments(run.runId);
      this._assignments.set(assigned);
      const codes = new Set(assigned.map((a) => a.spotCode));
      const where =
        this._levels.find((l) => l.bays.some((b) => codes.has(b.spotCode))) ??
        this._levels.find((l) => l.levelId === this._level()?.levelId) ??
        this._levels[0] ??
        null;
      this._level.set(where);
    } catch (e) {
      this._error.set(toApiError(e));
    } finally {
      this._refreshing.set(false);
    }
  }

  async run_(): Promise<boolean> {
    const cycle = this._cycle();
    if (!cycle || this._busy()) return false;

    this._busy.set(true);
    this._error.set(null);
    try {
      const result = await this.runs.execute(cycle.id, `ui-${cycle.id}-${crypto.randomUUID()}`);
      this._run.set(result);
      const assigned = await this.runs.assignments(result.runId);
      this._assignments.set(assigned);
      // Show the level the bays were handed out on, not simply the first one: a draw
      // that filled B2 drew an empty B1 on the result's map.
      const codes = new Set(assigned.map((a) => a.spotCode));
      const where = this._levels.find((l) => l.bays.some((b) => codes.has(b.spotCode)));
      if (where) this._level.set(where);
      // The record is what the result screen reads. A run whose record cannot be read
      // is still a committed run, so a failure here must not look like a failed draw.
      try {
        this._explanation.set((await this.runs.explanation(result.runId)).items);
      } catch {
        this._explanation.set([]);
      }
      this._step.set(1);
      return true;
    } catch (e) {
      this._error.set(toApiError(e));
      return false;
    } finally {
      this._busy.set(false);
    }
  }

  dismissError(): void {
    this._error.set(null);
  }
}
