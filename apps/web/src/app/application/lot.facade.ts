import { Injectable, computed, inject, resource, signal } from '@angular/core';
import { LotRepository } from '../domain/repositories';
import {
  type Bay,
  type LotFilter,
  type Projection,
  joinOccupancy,
  matchesFilter,
  navigate,
  findByTypeAhead,
  summarise,
  type NavKey,
} from '../domain/lot-layout';
import { SeedLotRepository } from '../data/seed-lot.repository';
import { AuthStore } from '../core/auth/auth.store';
import { peek, viewState } from './async-state';

/**
 * The lot screen as one page-level query pair feeding a dumb renderer.
 *
 * Everything the map draws is derived here: the layout<->occupancy join, the filter, the
 * selection and the focused cell. The map component receives the result and emits
 * intentions; it owns no state of its own, which is what makes the renderer swappable and
 * the navigation unit-testable without a DOM.
 */
@Injectable()
export class LotFacade {
  private readonly lots = inject(LotRepository);
  private readonly auth = inject(AuthStore);

  private readonly _levelId = signal<string | null>(null);
  private readonly _filter = signal<LotFilter>('ALL');
  private readonly _projection = signal<Projection>('plan');
  private readonly _selected = signal<string | null>(null);
  private readonly _focused = signal<string | null>(null);
  private readonly _announcement = signal('');

  private readonly levelsRes = resource({ loader: () => this.lots.levels() });

  readonly levels = computed(() => peek(this.levelsRes) ?? []);

  /** Deepest level first, so the default view is the one with the most bays. */
  readonly level = computed(() => {
    const all = this.levels();
    const id = this._levelId();
    return all.find((l) => l.levelId === id) ?? all[0] ?? null;
  });

  private readonly occupancyRes = resource({
    params: () => ({ levelId: this.level()?.levelId ?? null }),
    loader: ({ params }) =>
      params.levelId ? this.lots.occupancy(params.levelId) : Promise.resolve([]),
  });

  readonly state = viewState(this.levelsRes, (l) => l.length === 0);
  readonly occupancyState = viewState(this.occupancyRes);

  readonly filter = this._filter.asReadonly();
  readonly projection = this._projection.asReadonly();
  readonly announcement = this._announcement.asReadonly();

  /**
   * Whether this viewer is one who may be told who holds a bay. Only an administrator is:
   * a resident sees that a bay is occupied and nothing more.
   *
   * It drives copy — a column heading, a caption, the promise in the page header — and
   * nothing else. It is deliberately not what hides the names: those are already absent
   * from the payload for a resident, and a flag that both hid the data and described the
   * screen would make the second job silently load-bearing for the first.
   */
  readonly showsOccupants = computed(() => this.auth.isAdmin());

  /** Every bay on the level, joined and flagged. The filter de-emphasises; it never hides. */
  readonly bays = computed<readonly Bay[]>(() => {
    const lvl = this.level();
    const occ = peek(this.occupancyRes);
    if (!lvl || !occ) return [];
    // An administrator runs the draw, so an administrator holds no bay: there is nothing
    // to mark as theirs, and marking one would suggest the person operating the raffle is
    // also competing in it. The server is the real boundary (it must not issue an
    // assignment to an account with the ADMIN role); this keeps the screen honest.
    const mine =
      !this.auth.isAdmin() && this.lots instanceof SeedLotRepository
        ? this.lots.mySpotId()
        : null;

    /*
     * Belt and braces on occupant identity.
     *
     * The payload already omits it for a resident, which is the fix and the only one that
     * counts — the client is not a security boundary. This second pass exists because the
     * cost of the server getting it wrong is the whole building's parking register read
     * out by a screen reader, bay by bay, and because `occupant` is consumed in four
     * places (the SVG map's accessible name and tooltip, the WebGL overlay's, the table
     * cell and the detail panel). One join is a cheaper place to be sure than four.
     */
    const redacted = this.auth.isAdmin()
      ? occ
      : occ.map((o) => (o.occupant === null ? o : { ...o, occupant: null }));

    return joinOccupancy(lvl, redacted, mine);
  });

  readonly visible = computed(() => {
    const f = this._filter();
    return new Set(this.bays().filter((b) => matchesFilter(b, f)).map((b) => b.placement.spotId));
  });

  readonly counts = computed(() => {
    const b = this.bays();
    return {
      total: b.length,
      free: b.filter((x) => x.status === 'FREE').length,
      held: b.filter((x) => x.status === 'HELD').length,
      closed: b.filter((x) => x.status === 'OUT_OF_SERVICE').length,
      ev: b.filter((x) => x.placement.type === 'EV').length,
    };
  });

  readonly selected = computed(
    () => this.bays().find((b) => b.placement.spotId === this._selected()) ?? null,
  );

  /**
   * The roving tabindex target. One bay in the whole grid is tabbable; the rest are
   * reached with the arrow keys, so tabbing past the map costs one keystroke rather than
   * two hundred.
   */
  readonly focused = computed(
    () => this._focused() ?? this.bays()[0]?.placement.spotId ?? null,
  );

  readonly mine = computed(() => this.bays().find((b) => b.isMine) ?? null);

  selectLevel(levelId: string): void {
    this._levelId.set(levelId);
    this._selected.set(null);
    this._focused.set(null);
    const lvl = this.levels().find((l) => l.levelId === levelId);
    if (lvl) this.announce(`${lvl.label}. ${summarise(this.bays())}`);
  }

  setFilter(filter: LotFilter): void {
    this._filter.set(filter);
    const n = this.visible().size;
    this.announce(filter === 'ALL' ? summarise(this.bays()) : `Showing ${n} of ${this.bays().length} bays.`);
  }

  setProjection(projection: Projection): void {
    this._projection.set(projection);
  }

  select(spotId: string | null): void {
    this._selected.set(spotId);
    if (spotId) this._focused.set(spotId);
  }

  focus(spotId: string): void {
    this._focused.set(spotId);
  }

  /** Arrow/Home/End/Page movement, delegated to the pure domain function. */
  move(key: NavKey): string | null {
    const from = this.focused();
    if (!from) return null;
    const next = navigate(
      this.bays().map((b) => b.placement),
      from,
      key,
    );
    if (next) this._focused.set(next);
    return next;
  }

  /** Type-ahead on the bay code: the actual task is "find B2-14", not "arrow 200 times". */
  typeAhead(buffer: string): string | null {
    const hit = findByTypeAhead(
      this.bays().map((b) => b.placement),
      buffer,
    );
    if (hit) this._focused.set(hit);
    return hit;
  }

  /**
   * One polite region, owned here rather than in the renderer. Announcing per bay would
   * queue 180 messages during a draw reveal, which is a denial of service on a screen
   * reader dressed up as compliance with SC 4.1.3.
   */
  private announce(message: string): void {
    this._announcement.set('');
    // Re-setting the same string does not re-announce; the empty frame forces it.
    queueMicrotask(() => this._announcement.set(message));
  }

  refresh(): void {
    this.levelsRes.reload();
    this.occupancyRes.reload();
  }
}
