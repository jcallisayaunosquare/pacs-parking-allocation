import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { LotFacade } from '../../application/lot.facade';
import { DatePipe } from '@angular/common';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { LotMap } from '../../shared/ui/lot-map';
import { LotScene } from '../../shared/ui/lot-scene';
import { ViewStateHost } from '../../shared/ui/view-state';
import { Pager } from '../../shared/ui/pager';
import type { Bay, LotFilter, NavKey } from '../../domain/lot-layout';

/** How the plan is drawn. The WebGL scene is a third projection as far as a person cares. */
type Perspective = 'plan' | 'isometric' | 'webgl';

const PERSPECTIVES: readonly { readonly value: Perspective; readonly label: string }[] = [
  { value: 'plan', label: 'Plan, from above' },
  { value: 'isometric', label: '2.5D' },
  { value: 'webgl', label: '3D (WebGL)' },
];

/**
 * The lot screen: a graphical plan of one level, a detail panel for the selected bay, and
 * the same data as a table one keypress away.
 *
 * The table is not a fallback nobody visits. It is the floor the map is built on: it is
 * how a screen-reader user who prefers table navigation reads the lot, it is what satisfies
 * reflow and target size on a phone without arguing about exceptions, it is the only
 * sortable and exportable view, and it is what renders when the layout has not been seeded
 * or the plate fails to load. Under 600 px it is the default, because a 200-bay level at
 * fit-to-width cannot give every bay a 24 px target (SC 2.5.8) on a 320 px screen.
 *
 * The controls were three rows of filled buttons - levels, five filters, three
 * projections - plus a Map/Table pair in the header, all in the signal colour when on: a
 * dozen loud controls above a plan whose job is to be read. They are now one toolbar of
 * labelled controls. View, the one choice that changes the whole screen, stays a visible
 * two-way switch; the rest are selects, because each is one answer from a short list and
 * a select states the answer in force without showing every alternative all the time.
 */
@Component({
  selector: 'app-lot-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    LotMap,
    LotScene,
    MatFormFieldModule,
    MatIconModule,
    MatSelectModule,
    Pager,
    ViewStateHost,
  ],
  host: { '(keydown.escape)': 'close()' },
  template: `
    @if (view() === 'map') {
      <a class="skip" [href]="'#lot-detail'">Skip map, go to bay detail</a>
    }

    <header class="head">
      <h1 class="head__h">The lot</h1>
      <!--
        The sentence has to match what the viewer will actually get. Promising "who
        holds it" to a resident, who is never shown an occupant, reads as a screen that
        is broken rather than as a rule being kept.
      -->
      <p class="head__p">
        Every bay on the level, as it stands now.
        @if (facade.showsOccupants()) {
          Select a bay for its detail and who holds it.
        } @else {
          Select a bay for its detail. Who holds a bay is shown to building
          administrators only.
        }
      </p>
    </header>

    <!--
      One polite region for the whole screen, owned by the facade. Announcing each bay as it
      changed would queue a hundred and eighty messages during a draw reveal, which is an
      abuse of SC 4.1.3 rather than compliance with it: one summary, and the detail is there
      to navigate to.
    -->
    <p class="sr-only" role="status" aria-live="polite">{{ facade.announcement() }}</p>

    <app-view-state
      [state]="facade.state()"
      loadingLabel="Loading the lot plan"
      emptyTitle="No layout yet"
      (action)="facade.refresh()"
    >
      @if (facade.level(); as level) {
        <div class="tools">
          <!--
            View is a switch, not a select: it changes the whole screen, so both ways of
            seeing the lot stay on show. Same hairline pair as the gate's capture modes.
          -->
          <div class="seg" role="group" aria-label="View">
            <button
              class="seg__b"
              type="button"
              [attr.aria-pressed]="view() === 'map'"
              (click)="setView('map')"
            >
              <mat-icon aria-hidden="true">map</mat-icon>
              Map
            </button>
            <button
              class="seg__b"
              type="button"
              [attr.aria-pressed]="view() === 'table'"
              (click)="setView('table')"
            >
              <mat-icon aria-hidden="true">table_rows</mat-icon>
              Table
            </button>
          </div>

          @if (facade.levels().length > 1) {
            <mat-form-field appearance="outline" subscriptSizing="dynamic" class="tools__f">
              <mat-label>Level</mat-label>
              <mat-select
                [value]="level.levelId"
                (selectionChange)="facade.selectLevel($event.value)"
              >
                @for (l of facade.levels(); track l.levelId) {
                  <mat-option [value]="l.levelId">{{ l.label }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
          }

          <!--
            Reads the plan again: after a draw, a release or a period closing, the bays
            change on the server and this screen does not hear about it on its own.
          -->
          <button
            class="tools__refresh"
            type="button"
            aria-label="Refresh the plan"
            title="Refresh the plan"
            (click)="facade.refresh()"
          >
            <mat-icon aria-hidden="true">refresh</mat-icon>
          </button>

          <!-- Each option carries its count, so choosing a filter is also reading the lot. -->
          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="tools__f">
            <mat-label>Show</mat-label>
            <mat-select
              [value]="facade.filter()"
              (selectionChange)="facade.setFilter($event.value)"
            >
              @for (f of filterOptions(); track f.value) {
                <mat-option [value]="f.value">
                  {{ f.label }} <span class="opt__n">{{ f.count }}</span>
                </mat-option>
              }
            </mat-select>
          </mat-form-field>

          @if (view() === 'map') {
            <mat-form-field appearance="outline" subscriptSizing="dynamic" class="tools__f">
              <mat-label>Perspective</mat-label>
              <mat-select
                [value]="perspective()"
                (selectionChange)="setPerspective($event.value)"
              >
                @for (p of perspectives; track p.value) {
                  <mat-option [value]="p.value">{{ p.label }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
          }
        </div>

        <p class="counts">
          {{ facade.counts().total }} bays &middot;
          <strong>{{ facade.counts().free }} free</strong> &middot;
          {{ facade.counts().held }} occupied &middot;
          {{ facade.counts().closed }} out of service
        </p>

        @if (view() === 'map') {
          <div class="layout view-in">
            <div class="layout__main">
              @if (webgl()) {
                @defer (when webgl()) {
                  <app-lot-scene
                    #scene
                    [level]="level"
                    [bays]="facade.bays()"
                    [visible]="facade.visible()"
                    [selected]="facade.selected()?.placement.spotId ?? null"
                    [focused]="facade.focused()"
                    (activate)="onActivate($event)"
                    (focusMove)="facade.focus($event)"
                    (navigate)="onNavigate($event)"
                    (search)="onSearch($event)"
                  />
                } @loading {
                  <p class="hint">Loading the 3D renderer&hellip;</p>
                } @placeholder {
                  <p class="hint">3D view</p>
                }

                <p class="hint">
                  The 3D view downloads a WebGL renderer the plan view does not need. A canvas
                  has no accessibility tree, so the same invisible grid sits over it: arrow
                  keys, type-ahead and Enter behave exactly as they do on the plan.
                </p>
              } @else {
                <app-lot-map
                  #map
                  [level]="level"
                  [bays]="facade.bays()"
                  [visible]="facade.visible()"
                  [projection]="facade.projection()"
                  [selected]="facade.selected()?.placement.spotId ?? null"
                  [focused]="facade.focused()"
                  [busy]="facade.occupancyState().kind === 'loading'"
                  (activate)="onActivate($event)"
                  (focusMove)="facade.focus($event)"
                  (navigate)="onNavigate($event)"
                  (search)="onSearch($event)"
                />

                <!--
                  The legend states every status in shape, pattern, glyph and words, so the
                  map is readable in greyscale and by anyone who does not distinguish the
                  fills (SC 1.4.1).
                -->
                <ul class="legend">
                  <li>
                    <span class="sw sw--free" aria-hidden="true"></span>
                    <span><strong>Free</strong> &mdash; no resident holds this bay. It goes
                    into the next draw.</span>
                  </li>
                  <li>
                    <span class="sw sw--held" aria-hidden="true"></span>
                    <span><strong>Occupied</strong> &mdash; assigned to a resident for the
                    current period.</span>
                  </li>
                  <li>
                    <span class="sw sw--mine" aria-hidden="true"></span>
                    <span><strong>Yours</strong> &mdash; the bay assigned to you, until the
                    date in the detail panel.</span>
                  </li>
                  <li>
                    <span class="sw sw--closed" aria-hidden="true"></span>
                    <span><strong>Out of service</strong> &mdash; unusable, for works or
                    repairs. Left out of the draw.</span>
                  </li>
                  <li>
                    <span class="sw sw--glyph" aria-hidden="true">&#9889;</span>
                    <span><strong>EV</strong> &mdash; has a charging point.</span>
                  </li>
                </ul>

                <p class="hint">
                  Arrow keys move between bays, Enter opens the detail, Escape closes it, and
                  typing a bay number jumps straight to that bay.
                </p>
              }
            </div>

            <!--
              A panel rather than a modal: the plan is the context for the detail, and a
              dialog would cover the thing being inspected and trap focus away from it. Focus
              moves here on selection and returns to the bay on Escape.

              Map only. In the table every one of these facts is already a column of the
              row, so the panel beside it repeated the row in larger type.
            -->
            <aside class="panel" id="lot-detail" tabindex="-1" #panel aria-labelledby="lot-detail-h">
              <!--
                Keyed on the bay, so choosing another one replaces the block and its entry
                plays again: the detail visibly changes to the new bay instead of its text
                being swapped in place where the change is easy to miss.
              -->
              @for (bay of selectedList(); track bay.placement.spotId) {
                <div class="panel__in">
                  <h2 class="panel__h stencil" id="lot-detail-h">{{ bay.placement.spotCode }}</h2>
                  <p class="panel__status">{{ statusWord(bay) }}</p>

                  <dl class="panel__dl">
                    <dt>Type</dt>
                    <dd>{{ typeWord(bay) }}</dd>
                    <dt>Aisle</dt>
                    <dd>Row {{ bay.placement.row }}, position {{ bay.placement.col }}</dd>
                    <dt>Zone</dt>
                    <dd>{{ bay.placement.zoneId ?? dash }}</dd>
                    @if (bay.occupant) {
                      <dt>Held by</dt>
                      <dd>{{ bay.occupant.displayName }}{{ middot }}unit {{ bay.occupant.unit }}</dd>
                    }
                    @if (bay.validUntil) {
                      <dt>Until</dt>
                      <dd>{{ bay.validUntil | date: 'longDate' }}</dd>
                    }
                  </dl>

                  @if (!bay.occupant && bay.status === 'HELD') {
                    <p class="panel__note">
                      Who holds a bay is shown to building administrators only.
                    </p>
                  }

                  <button type="button" class="link" (click)="close()">Close detail (Esc)</button>
                </div>
              } @empty {
                <div class="panel__in">
                  <h2 class="panel__h panel__h--quiet" id="lot-detail-h">No bay selected</h2>
                  <p class="panel__note">Select a bay on the plan to see its detail.</p>
                  @if (facade.mine(); as mine) {
                    <button type="button" class="link" (click)="onActivate(mine.placement.spotId)">
                      Go to my bay, {{ mine.placement.spotCode }}
                    </button>
                  }
                </div>
              }
            </aside>
          </div>
        } @else {
          <div class="view-in">
            <div class="table-scroll">
              <table class="data-table">
                <!--
                  The "Held by" column exists only for a viewer who may be told. For a
                  resident it would be a column of em dashes, which is not privacy kept
                  quietly but a visible hole where a name is understood to be - and it is
                  the caption a screen-reader user hears first, so it has to be true too.
                -->
                <caption class="sr-only">
                  Every bay on {{ level.label }}, with its status@if
                  (facade.showsOccupants()) { and who holds it }
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Bay</th>
                    <th scope="col">Aisle</th>
                    <th scope="col">Type</th>
                    <th scope="col">Status</th>
                    @if (facade.showsOccupants()) {
                      <th scope="col">Held by</th>
                    }
                    <th scope="col">Until</th>
                  </tr>
                </thead>
                <tbody>
                  @for (bay of pagedRows(); track bay.placement.spotId) {
                    <tr [class.on]="bay.placement.spotId === facade.selected()?.placement.spotId">
                      <th scope="row">
                        <!--
                          A row and its bay on the plan are one object, reachable from either
                          side: the code takes you to the bay, selected, on the map.
                        -->
                        <button
                          type="button"
                          class="link code"
                          [attr.aria-label]="'Show ' + bay.placement.spotCode + ' on the map'"
                          (click)="showOnMap(bay.placement.spotId)"
                        >
                          {{ bay.placement.spotCode }}
                        </button>
                      </th>
                      <td>{{ bay.placement.row }}</td>
                      <td>{{ typeWord(bay) }}</td>
                      <td>{{ statusWord(bay) }}</td>
                      @if (facade.showsOccupants()) {
                        <td>{{ occupantLine(bay) }}</td>
                      }
                      <td>{{ bay.validUntil ? (bay.validUntil | date: 'mediumDate') : dash }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>

            <!-- The same pager, in the same place, as every other register. -->
            @if (pageCount() > 1) {
              <app-pager
                [page]="page()"
                [pageSize]="pageSize"
                [count]="pagedRows().length"
                [hasPrevious]="page() > 1"
                [hasNext]="page() < pageCount()"
                (previous)="previousPage()"
                (next)="nextPage()"
              />
            }
          </div>
        }
      }
    </app-view-state>
  `,
  styles: [
    `
      :host {
        /* This screen's measure. The shell is full-bleed; pages own their width. */
        width: 100%;
        max-width: 108rem;
        margin: 0 auto;
        padding: var(--sp-6) var(--sp-5) var(--sp-8);

        display: block;
        /* A floor plan is the one screen that wants every pixel it can get. */
      }

      .tools__refresh {
        display: inline-grid;
        place-items: center;
        width: 2.75rem;
        height: 2.75rem;
        padding: 0;
        border: 1px solid var(--rule);
        border-radius: 3px;
        background: transparent;
        color: var(--ink-2);
        cursor: pointer;
      }

      @media (hover: hover) and (pointer: fine) {
        .tools__refresh:hover {
          background: var(--surface-3);
          color: var(--ink-1);
        }
      }

      .skip {
        position: absolute;
        left: -9999px;
      }
      .skip:focus {
        position: static;
        display: inline-block;
        margin-bottom: var(--sp-3);
      }

      .head {
        border-bottom: 1px solid var(--rule);
        padding-bottom: var(--sp-4);
      }
      .head__h {
        margin: 0;
        font-size: var(--t-head);
      }
      .head__p {
        margin: var(--sp-2) 0 0;
        color: var(--steel-soft);
        max-width: 54ch;
      }

      /* ----------------------------------------------------------------- tools */

      .tools {
        display: flex;
        align-items: center;
        gap: var(--sp-4);
        flex-wrap: wrap;
        margin: var(--sp-5) 0 var(--sp-3);
      }

      .tools__f {
        width: 12rem;
      }

      .opt__n {
        margin-left: var(--sp-2);
        color: var(--ink-3);
        font-variant-numeric: tabular-nums;
      }

      /* Two buttons in one hairline frame, so the pair reads as one control. */
      .seg {
        display: inline-flex;
        border: 1px solid var(--rule);
        border-radius: 3px;
      }

      .seg__b {
        display: inline-flex;
        align-items: center;
        gap: var(--sp-2);
        font: inherit;
        font-size: var(--t-small);
        /* 44 px of height, so a pointer target is comfortable and 2.5.8 is not in play. */
        min-height: 44px;
        padding: 0 var(--sp-4);
        background: transparent;
        color: var(--ink-3);
        border: 0;
        border-radius: 0;
        cursor: pointer;
        transition:
          color 140ms ease,
          box-shadow 180ms cubic-bezier(0.16, 1, 0.3, 1);
      }

      .seg__b + .seg__b {
        border-left: 1px solid var(--rule);
      }

      .seg__b mat-icon {
        width: 20px;
        height: 20px;
        font-size: 20px;
      }

      @media (hover: hover) and (pointer: fine) {
        .seg__b:hover {
          color: var(--ink-1);
        }
      }

      /* The one in force is darker and heavier, with the signal under it - not a fill. */
      .seg__b[aria-pressed='true'] {
        color: var(--ink-1);
        font-variation-settings: 'wght' 620;
        box-shadow: inset 0 -3px 0 0 var(--signal);
      }

      .seg__b:focus-visible,
      .link:focus-visible {
        outline: 2px solid var(--signal);
        outline-offset: 2px;
      }

      .link {
        font: inherit;
        padding: 0;
        border: 0;
        background: none;
        text-decoration: underline;
        text-underline-offset: 3px;
        color: var(--steel);
        cursor: pointer;
      }

      .counts {
        margin: 0 0 var(--sp-4);
        color: var(--steel-soft);
        font-size: var(--t-small);
      }

      /*
       * Switching view brings the new one in with a short rise rather than a hard cut,
       * so the change reads as the same lot seen another way.
       */
      .view-in {
        animation: view-in 260ms cubic-bezier(0.16, 1, 0.3, 1);
      }

      @keyframes view-in {
        from {
          opacity: 0;
          transform: translateY(6px);
        }
      }

      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 19rem;
        gap: var(--sp-6);
        align-items: start;
      }

      .legend {
        list-style: none;
        margin: var(--sp-4) 0 0;
        padding: 0;
        display: flex;
        flex-wrap: wrap;
        gap: var(--sp-2) var(--sp-5);
        font-size: var(--t-fine);
        color: var(--steel-soft);
      }
      .legend li {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
      }
      .sw {
        width: 18px;
        height: 26px;
        display: inline-block;
      }
      .sw--free {
        background: var(--bay-free);
        outline: 2px dashed var(--bay-free-edge);
        outline-offset: -2px;
      }
      .sw--held {
        background: var(--bay-held);
        outline: 2px solid var(--bay-held-edge);
        outline-offset: -2px;
      }
      /* The same edge the map gives your bay, so the key matches the plan. Inset, so the
         swatch keeps its 18px width like the others. */
      .sw--mine {
        background: var(--bay-mine);
        box-shadow: inset 5px 0 0 var(--bay-mine-edge);
      }
      .sw--closed {
        background: var(--bay-closed);
        background-image: repeating-linear-gradient(
          45deg,
          transparent 0 4px,
          var(--bay-closed-ink) 4px 6px
        );
      }

      .hint {
        margin: var(--sp-3) 0 0;
        font-size: var(--t-fine);
        color: var(--steel-faint);
      }

      .panel {
        border-left: 3px solid var(--steel);
        padding: 0 0 0 var(--sp-5);
        /* Sticky beside a tall plan, so the detail stays in view while the map scrolls. */
        position: sticky;
        top: var(--sp-4);
      }
      .panel:focus-visible {
        outline: 3px solid var(--bay-line);
        outline-offset: 4px;
      }

      /* Each bay's detail slides in from the plan's side as it is chosen. */
      .panel__in {
        animation: panel-in 240ms cubic-bezier(0.16, 1, 0.3, 1);
      }

      @keyframes panel-in {
        from {
          opacity: 0;
          transform: translateX(-10px);
        }
      }

      .panel__h {
        margin: 0;
        font-size: var(--t-head);
      }
      .panel__h--quiet {
        font-size: var(--t-lead);
        color: var(--steel-faint);
      }
      .panel__status {
        margin: var(--sp-1) 0 var(--sp-4);
        font-size: var(--t-lead);
      }
      .panel__dl {
        margin: 0 0 var(--sp-4);
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--sp-2) var(--sp-4);
        font-size: var(--t-small);
      }
      .panel__dl dt {
        color: var(--steel-faint);
      }
      .panel__dl dd {
        margin: 0;
      }
      .panel__note {
        margin: 0 0 var(--sp-4);
        font-size: var(--t-small);
        color: var(--steel-soft);
      }

      /* The list is the shared .data-table; only the selected bay is marked here, with
         the same tint the map's selection uses. */
      .data-table tr.on {
        background: var(--concrete-deep);
      }

      /* A 200-bay level cannot give every bay a 24 px target at 320 px, so the list leads. */
      @media (max-width: 860px) {
        .layout {
          grid-template-columns: minmax(0, 1fr);
        }
        .panel {
          position: static;
          border-left: 0;
          border-top: 3px solid var(--steel);
          padding: var(--sp-4) 0 0;
        }
      }

      @media (max-width: 40rem) {
        .tools__f {
          width: 100%;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .view-in,
        .panel__in {
          animation: none;
        }
        .seg__b {
          transition: none;
        }
      }
    `,
  ],
  providers: [LotFacade],
})
export default class LotPage {
  readonly facade = inject(LotFacade);
  readonly perspectives = PERSPECTIVES;

  private readonly map = viewChild<LotMap>('map');
  private readonly scene = viewChild<LotScene>('scene');

  /** The WebGL renderer, off by default so three.js is never in the first download. */
  readonly webgl = signal(false);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  /** Map or table, and the table leads on a narrow screen rather than a cramped map. */
  readonly view = signal<'map' | 'table'>(
    typeof window !== 'undefined' && window.matchMedia('(max-width: 600px)').matches
      ? 'table'
      : 'map',
  );

  /** The selected bay as a list of zero or one, so the panel can key its entry on it. */
  readonly selectedList = computed(() => {
    const bay = this.facade.selected();
    return bay ? [bay] : [];
  });

  /** The two projections and the WebGL scene, as the one answer the select shows. */
  readonly perspective = computed<Perspective>(() =>
    this.webgl() ? 'webgl' : this.facade.projection(),
  );

  /**
   * The filter choices, each with how many bays it would show. Counted from the level's
   * bays here rather than from facade.counts(), because two of the choices - Mine and
   * EV - are not statuses the counts carry.
   */
  readonly filterOptions = computed(() => {
    const bays = this.facade.bays();
    const count = (pick: (b: Bay) => boolean) => bays.filter(pick).length;
    const options: { value: LotFilter; label: string; count: number }[] = [
      { value: 'ALL', label: 'All bays', count: bays.length },
      { value: 'FREE', label: 'Free', count: count((b) => b.status === 'FREE') },
      { value: 'HELD', label: 'Occupied', count: count((b) => b.status === 'HELD') },
      { value: 'MINE', label: 'Mine', count: count((b) => b.isMine) },
      { value: 'EV', label: 'EV', count: count((b) => b.placement.type === 'EV') },
    ];
    return options;
  });

  /** The table shows the filter as a filter: hiding rows there loses nothing. */
  readonly tableRows = computed(() => {
    const keep = this.facade.visible();
    return this.facade.bays().filter((b) => keep.has(b.placement.spotId));
  });

  /** The gate log's page size: the lot is a register of similar length. */
  readonly pageSize = 25;

  /**
   * The table page, back to 1 whenever the filter or the level changes. A page number
   * belongs to one particular list; carried into another it can point past its end and
   * show an empty table over bays that exist. linkedSignal resets it from those sources
   * and leaves it writable for Previous and Next.
   */
  readonly page = linkedSignal({
    source: () => ({ filter: this.facade.filter(), level: this.facade.level()?.levelId }),
    computation: () => 1,
  });

  readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.tableRows().length / this.pageSize)),
  );

  readonly pagedRows = computed(() => {
    const start = (this.page() - 1) * this.pageSize;
    return this.tableRows().slice(start, start + this.pageSize);
  });

  previousPage(): void {
    this.page.update((p) => Math.max(1, p - 1));
  }

  nextPage(): void {
    this.page.update((p) => Math.min(this.pageCount(), p + 1));
  }

  constructor() {
    // Focus follows the model: when the facade moves the current cell, the real element
    // takes focus, which is what makes a roving tabindex grid work at all.
    effect(() => {
      const id = this.facade.focused();
      const map = this.map();
      const scene = this.scene();
      if (!id || this.view() !== 'map') return;
      if (this.webgl()) scene?.focusCell(id);
      else map?.focusCell(id);
    });
  }

  setView(view: 'map' | 'table'): void {
    this.view.set(view);
  }

  setPerspective(p: Perspective): void {
    if (p === 'webgl') {
      this.webgl.set(true);
      return;
    }
    this.webgl.set(false);
    this.facade.setProjection(p);
  }

  /** From a table row to its bay: the map, with that bay selected and its detail open. */
  showOnMap(spotId: string): void {
    this.view.set('map');
    this.facade.select(spotId);
    this.facade.focus(spotId);
    // After the map has rendered, so the panel it moves focus to exists.
    queueMicrotask(() => this.panel()?.nativeElement.focus());
  }

  onActivate(spotId: string): void {
    this.facade.select(spotId);
    this.panel()?.nativeElement.focus();
  }

  onNavigate(key: NavKey): void {
    this.facade.move(key);
  }

  onSearch(buffer: string): void {
    this.facade.typeAhead(buffer);
  }

  /** Escape closes the detail and returns focus to the bay it came from. */
  close(): void {
    const id = this.facade.selected()?.placement.spotId ?? null;
    this.facade.select(null);
    if (!id) return;
    if (this.webgl()) this.scene()?.focusCell(id);
    else this.map()?.focusCell(id);
  }

  /**
   * Punctuation the template interpolates. Kept here as escapes rather than literal
   * characters so the source file stays ASCII and cannot be mangled by a tool that
   * guesses its encoding wrongly.
   */
  readonly dash = '—';
  readonly middot = ' · ';

  occupantLine(bay: Bay): string {
    return bay.occupant
      ? `${bay.occupant.displayName}${this.middot}${bay.occupant.unit}`
      : this.dash;
  }

  statusWord(bay: Bay): string {
    if (bay.isMine) return 'Yours';
    switch (bay.status) {
      case 'FREE':
        return 'Free';
      case 'HELD':
        return 'Occupied';
      case 'OUT_OF_SERVICE':
        return 'Out of service';
    }
  }

  typeWord(bay: Bay): string {
    switch (bay.placement.type) {
      case 'EV':
        return 'EV';
      default:
        return 'Standard';
    }
  }
}
