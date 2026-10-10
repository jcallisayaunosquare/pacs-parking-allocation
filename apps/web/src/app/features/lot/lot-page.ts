import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { LotFacade } from '../../application/lot.facade';
import { DatePipe } from '@angular/common';
import { LotMap } from '../../shared/ui/lot-map';
import { LotScene } from '../../shared/ui/lot-scene';
import { ViewStateHost } from '../../shared/ui/view-state';
import type { Bay, LotFilter, NavKey } from '../../domain/lot-layout';

const FILTERS: readonly { readonly value: LotFilter; readonly label: string }[] = [
  { value: 'ALL', label: 'All bays' },
  { value: 'FREE', label: 'Free' },
  { value: 'HELD', label: 'Occupied' },
  { value: 'MINE', label: 'Mine' },
  { value: 'EV', label: 'EV' },
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
 */
@Component({
  selector: 'app-lot-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LotMap, LotScene, ViewStateHost, DatePipe],
  host: { '(keydown.escape)': 'close()' },
  template: `
    <a class="skip" [href]="'#lot-detail'">Skip map, go to bay detail</a>

    <header class="head">
      <div>
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
      </div>

      <div class="head__views" role="group" aria-label="View">
        <button
          type="button"
          [class.on]="view() === 'map'"
          [attr.aria-pressed]="view() === 'map'"
          (click)="view.set('map')"
        >
          Map
        </button>
        <button
          type="button"
          [class.on]="view() === 'table'"
          [attr.aria-pressed]="view() === 'table'"
          (click)="view.set('table')"
        >
          Table
        </button>
      </div>
    </header>

    <!--
      One polite region for the whole screen, owned by the facade. Announcing each bay as it
      changed would queue a hundred and eighty messages during a draw reveal, which is an
      abuse of SC 4.1.3 rather than compliance with it: one summary, and the detail is there
      to navigate to.
    -->
    <p class="sr-only" role="status" aria-live="polite">{{ facade.announcement() }}</p>

    <app-view-state [state]="facade.state()" emptyTitle="No layout yet" (action)="facade.refresh()">
      @if (facade.level(); as level) {
        <div class="bar">
          @if (facade.levels().length > 1) {
          <div class="bar__group" role="group" aria-label="Level">
            @for (l of facade.levels(); track l.levelId) {
              <button
                type="button"
                [class.on]="l.levelId === level.levelId"
                [attr.aria-pressed]="l.levelId === level.levelId"
                (click)="facade.selectLevel(l.levelId)"
              >
                {{ l.label }}
              </button>
            }
          </div>
          }

          <div class="bar__group" role="group" aria-label="Filter">
            @for (f of filters; track f.value) {
              <button
                type="button"
                [class.on]="f.value === facade.filter()"
                [attr.aria-pressed]="f.value === facade.filter()"
                (click)="facade.setFilter(f.value)"
              >
                {{ f.label }}
              </button>
            }
          </div>

          @if (view() === 'map') {
            <div class="bar__group" role="group" aria-label="Projection">
              <button
                type="button"
                [class.on]="!webgl() && facade.projection() === 'plan'"
                [attr.aria-pressed]="!webgl() && facade.projection() === 'plan'"
                (click)="webgl.set(false); facade.setProjection('plan')"
              >
                Plan
              </button>
              <button
                type="button"
                [class.on]="!webgl() && facade.projection() === 'isometric'"
                [attr.aria-pressed]="!webgl() && facade.projection() === 'isometric'"
                (click)="webgl.set(false); facade.setProjection('isometric')"
              >
                2.5D
              </button>
              <button
                type="button"
                [class.on]="webgl()"
                [attr.aria-pressed]="webgl()"
                (click)="webgl.set(true)"
              >
                3D &middot; WebGL
              </button>
            </div>
          }
        </div>

        <p class="counts">
          {{ facade.counts().total }} bays &middot;
          <strong>{{ facade.counts().free }} free</strong> &middot;
          {{ facade.counts().held }} occupied &middot;
          {{ facade.counts().closed }} out of service
        </p>

        <div class="layout">
          <div class="layout__main">
            @if (view() === 'map' && webgl()) {
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
            } @else if (view() === 'map') {
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
            } @else {
              <table class="table">
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
                  @for (bay of tableRows(); track bay.placement.spotId) {
                    <tr [class.on]="bay.placement.spotId === facade.selected()?.placement.spotId">
                      <th scope="row">
                        <button type="button" class="link" (click)="onActivate(bay.placement.spotId)">
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
            }
          </div>

          <!--
            A panel rather than a modal: the plan is the context for the detail, and a dialog
            would cover the thing being inspected and trap focus away from it. Focus moves
            here on selection and returns to the bay on Escape.
          -->
          <aside class="panel" id="lot-detail" tabindex="-1" #panel aria-labelledby="lot-detail-h">
            @if (facade.selected(); as bay) {
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
            } @else {
              <h2 class="panel__h panel__h--quiet" id="lot-detail-h">No bay selected</h2>
              <p class="panel__note">
                Select a bay on the {{ view() === 'map' ? 'plan' : 'list' }} to see its detail.
              </p>
              @if (facade.mine(); as mine) {
                <button type="button" class="link" (click)="onActivate(mine.placement.spotId)">
                  Go to my bay, {{ mine.placement.spotCode }}
                </button>
              }
            }
          </aside>
        </div>
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
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--sp-5);
        flex-wrap: wrap;
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

      .bar {
        display: flex;
        gap: var(--sp-5);
        flex-wrap: wrap;
        margin: var(--sp-5) 0 var(--sp-3);
      }
      .bar__group,
      .head__views {
        display: flex;
        gap: 2px;
      }

      button {
        font: inherit;
        font-size: var(--t-small);
        /* 44 px of height, so a pointer target is comfortable and 2.5.8 is not in play. */
        min-height: 44px;
        padding: 0 var(--sp-4);
        border: 1px solid var(--rule);
        background: var(--slab);
        color: var(--steel);
        border-radius: 3px;
        cursor: pointer;
      }
      button.on {
        background: var(--signal);
        border-color: var(--signal);
        color: var(--on-primary);
      }
      button:focus-visible {
        outline: 3px solid var(--bay-line);
        outline-offset: 2px;
      }

      .link {
        min-height: 0;
        padding: 0;
        border: 0;
        background: none;
        text-decoration: underline;
        color: var(--steel);
      }

      .counts {
        margin: 0 0 var(--sp-4);
        color: var(--steel-soft);
        font-size: var(--t-small);
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
      .sw--mine {
        background: var(--bay-mine);
        border-left: 5px solid var(--bay-mine-edge);
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
      }
      .panel:focus-visible {
        outline: 3px solid var(--bay-line);
        outline-offset: 4px;
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

      .table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--t-small);
      }
      .table th,
      .table td {
        text-align: left;
        padding: var(--sp-3) var(--sp-3);
        border-bottom: 1px solid var(--rule-soft);
      }
      .table thead th {
        color: var(--steel-faint);
        font-size: var(--t-fine);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .table tr.on {
        background: var(--concrete-deep);
      }

      /* A 200-bay level cannot give every bay a 24 px target at 320 px, so the list leads. */
      @media (max-width: 860px) {
        .layout {
          grid-template-columns: minmax(0, 1fr);
        }
        .panel {
          border-left: 0;
          border-top: 3px solid var(--steel);
          padding: var(--sp-4) 0 0;
        }
      }
    `,
  ],
  providers: [LotFacade],
})
export default class LotPage {
  readonly facade = inject(LotFacade);
  readonly filters = FILTERS;

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

  /** The table shows the filter as a filter: hiding rows there loses nothing. */
  readonly tableRows = computed(() => {
    const keep = this.facade.visible();
    return this.facade.bays().filter((b) => keep.has(b.placement.spotId));
  });

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
  readonly dash = '\u2014';
  readonly middot = ' \u00b7 ';

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
