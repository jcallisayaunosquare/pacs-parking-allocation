import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import {
  type Bay,
  type LotLevel,
  type NavKey,
  type Projection,
  bayLabel,
  renderLabel,
  projectedViewBox,
  ISO_MATRIX,
  showsCode,
} from '../../domain/lot-layout';
import { facePoints, overlayBox, sidePoints } from '../../domain/lot-projection';

/**
 * How tall the plan's frame is allowed to be. Shared by the stylesheet's max-height`n * and by the width ceiling that makes it fit, which is why it is one constant and
 * not two numbers that drift.
 */
const FRAME_HEIGHT = '78vh';

/**
 * The lot, drawn.
 *
 * Two layers over one coordinate system. The SVG underneath is the art -- painted bays,
 * kerbs, aisle markings -- and it is `aria-hidden` in its entirety, because a shape is not
 * a control. On top sits an invisible layer of real HTML elements, one per bay, carrying
 * every role, name, tabindex and pointer handler.
 *
 * That split is the whole architecture, and it is why this is SVG rather than a canvas or
 * a WebGL scene. A canvas renders pixels and has no accessibility tree at all: there are
 * no child nodes to label, nothing to focus, nothing for a screen reader to find. The only
 * mitigation is a parallel DOM with one real element per object -- that is, this overlay,
 * built anyway -- at which point you have paid 50 to 170 kB and reimplemented hit-testing
 * and focus management for pixels you could have drawn for free. At the ~200 bays this
 * building has, the browser's own hit-testing, focus handling and accessibility tree are
 * correct and cost nothing.
 *
 * The consequence worth keeping: because the semantics live in the overlay and not in the
 * renderer, the renderer is replaceable without touching accessibility.
 *
 * The grid pattern is `role="grid"` with a physical aisle as each row, so a screen reader
 * announces "row 3, column 7 of 14" -- position in the lot, which a listbox cannot express.
 * Row and column come from authored data, never inferred from coordinates: aisles are
 * staggered and a wrong row count read aloud is worse than none.
 */
@Component({
  selector: 'app-lot-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  template: `
    <!--
      Zoom is a control, not a gesture. A 180-bay level at fit-to-width gives every bay
      about fourteen pixels, which is under the WCAG 2.2 target minimum and under what a
      person can read, so the plan has to be enlargeable - and the enlargement has to be
      reachable without a pinch (SC 2.5.7) and without a drag (SC 2.1.1). So: buttons for
      the scale, and the browser's own scroll container for the panning, which already
      answers the wheel, the trackpad, the scrollbars, the arrow keys and a screen
      reader's own scrolling. Nothing here reimplements any of that.
    -->
    <div class="tools">
      <div class="tools__zoom" role="group" aria-label="Zoom">
        <button
          type="button"
          [disabled]="zoom() <= 1"
          aria-label="Zoom out"
          (click)="zoomBy(1 / 1.5)"
        >
          <mat-icon>zoom_out</mat-icon>
        </button>
        <button
          type="button"
          [disabled]="zoom() >= maxZoom"
          aria-label="Zoom in"
          (click)="zoomBy(1.5)"
        >
          <mat-icon>zoom_in</mat-icon>
        </button>
        <button type="button" [disabled]="zoom() === 1" aria-label="Fit the level" (click)="fit()">
          <mat-icon>fit_screen</mat-icon>
        </button>
        @if (selected()) {
          <button type="button" aria-label="Centre on the selected bay" (click)="centreOnSelected()">
            <mat-icon>my_location</mat-icon>
          </button>
        }
      </div>

      <p class="tools__scale" aria-live="polite">
        @if (zoom() > 1) {
          {{ zoomLabel() }}
        }
      </p>
    </div>

    <div class="port" #port (scroll)="onScroll()">
    <!--
      Width carries the zoom and the aspect ratio gives the height, so one number scales
      both layers together and the overlay cannot drift off the art. The max-width is
      what makes "fit" mean fit: without it a level that is wider than it is tall still
      overflows the frame vertically at 100%, and the button that claims to fit the level
      does not.
    -->
    <div
      class="lot"
      [style.aspect-ratio]="aspect()"
      [style.width.%]="zoom() * 100"
      [style.max-width]="ceiling()"
    >
      <!-- The art. Decorative by construction: every name lives in the overlay. -->
      <svg
        class="lot__art"
        [attr.viewBox]="'0 0 ' + box().w + ' ' + box().h"
        aria-hidden="true"
        focusable="false"
        preserveAspectRatio="xMidYMid meet"
      >
        <!-- 45 deg hatch for a bay held by someone else: status must survive greyscale. -->
        <defs>
          <pattern id="lot-cross" width="30" height="30" patternUnits="userSpaceOnUse">
            <path d="M0 0 L30 30 M30 0 L0 30" stroke="var(--bay-closed-ink)" stroke-width="6" fill="none" />
          </pattern>
        </defs>

        <!--
          The plate: the building shell. Decorative, and generated from the same level
          data as the bays so the two cannot drift apart. A hand-cleaned Figma export
          drops in here unchanged once the floor plan is drawn, because it shares this
          viewBox -- that is the whole reason the coordinate system lives in the data.
        -->
        <g class="lot__plate" [attr.transform]="plateTransform()">
          <rect
            class="lot__wall"
            [attr.x]="margin()"
            [attr.y]="margin()"
            [attr.width]="box().w - margin() * 2"
            [attr.height]="box().h - margin() * 2"
          />
          @for (aisle of aisles(); track aisle.y) {
            <line
              class="lot__aisle"
              [attr.x1]="aisleStart()"
              [attr.y1]="aisle.y"
              [attr.x2]="box().w - margin() * 1.6"
              [attr.y2]="aisle.y"
            />
            <polygon class="lot__arrow" [attr.points]="arrow(aisle.y)" />
          }
          <rect
            class="lot__core"
            [attr.x]="margin() * 1.35"
            [attr.y]="box().h * 0.32"
            [attr.width]="margin() * 1.5"
            [attr.height]="box().h * 0.36"
          />
          @for (row of rows(); track row.row) {
            <text
              class="lot__row-letter stencil"
              [attr.x]="letterX()"
              [attr.y]="rowMidY(row.row)"
              [attr.font-size]="codeSize() * 1.5"
              text-anchor="middle"
              dominant-baseline="central"
            >
              {{ rowLetter(row.row) }}
            </text>
          }

          <!--
            Outside the shell, not inside it. Set within the wall it printed across the
            first row of bays, which made the level's own name the least readable thing
            on the plan and the bays underneath it worse.
          -->
          <text
            class="lot__level-label stencil"
            [attr.x]="box().w - margin()"
            [attr.y]="margin() * 0.5"
            [attr.font-size]="codeSize() * 1.6"
            text-anchor="end"
            dominant-baseline="central"
          >
            {{ level().label }}
          </text>

          <text
            class="lot__core-label"
            [attr.x]="margin() * 2.1"
            [attr.y]="box().h * 0.5"
            [attr.font-size]="codeSize() * 0.8"
            text-anchor="middle"
            dominant-baseline="central"
          >
            LIFT
          </text>
        </g>
        @if (projection() === 'isometric') {
          @for (bay of bays(); track bay.placement.spotId) {
            <polygon class="lot__kerb" [attr.points]="side(bay)" />
          }
        }

        @for (bay of bays(); track bay.placement.spotId) {
          <g
            [class]="'lot__bay lot__bay--' + tone(bay)"
            [class.lot__bay--dim]="isDimmed(bay)"
            [class.lot__bay--hot]="bay.placement.spotId === hovered()"
            [style.--row]="bay.placement.row"
            [style.--col]="bay.placement.col"
          >
            <polygon class="lot__floor" [attr.points]="face(bay)" />
            @if (bay.status === 'OUT_OF_SERVICE') {
              <polygon class="lot__cross" [attr.points]="face(bay)" />
            }
            @if (codeVisible()) {
              <text
                class="lot__code stencil"
                [attr.x]="centre(bay).x"
                [attr.y]="centre(bay).y"
                [attr.font-size]="codeSize()"
                text-anchor="middle"
                dominant-baseline="central"
              >
                {{ short(bay) }}
              </text>
            }
            @if (glyph(bay)) {
              <text
                class="lot__glyph"
                [attr.x]="centre(bay).x"
                [attr.y]="centre(bay).y + glyphOffset()"
                [attr.font-size]="codeSize() * 0.9"
                text-anchor="middle"
                dominant-baseline="central"
              >
                {{ glyph(bay) }}
              </text>
            }
          </g>
        }
      </svg>

      <!--
        The semantics. Transparent, absolutely positioned, and the only thing the keyboard
        and the accessibility tree ever see. A separate focus layer is not needed because
        these elements are siblings in the DOM, so a focus ring is never overdrawn by a
        neighbour the way an SVG node would be -- SVG has no z-index.
      -->
      <div
        class="lot__grid"
        role="grid"
        [attr.aria-label]="level().label + ' parking map'"
        [attr.aria-rowcount]="rows().length"
        [attr.aria-colcount]="maxCols()"
        [attr.aria-busy]="busy() ? 'true' : null"
        (keydown)="onKeydown($event)"
      >
        @for (row of rows(); track row.row; let r = $index) {
          <div role="row" [attr.aria-rowindex]="r + 1">
            @for (bay of row.bays; track bay.placement.spotId; let c = $index) {
              <div
                role="gridcell"
                class="lot__cell"
                [attr.aria-colindex]="c + 1"
                [attr.aria-selected]="bay.placement.spotId === selected() ? 'true' : 'false'"
                [attr.aria-label]="name(bay)"
                [attr.data-spot-id]="bay.placement.spotId"
                [attr.data-status]="bay.status"
                [attr.title]="name(bay)"
                [tabindex]="bay.placement.spotId === focused() ? 0 : -1"
                [class.lot__cell--focus]="bay.placement.spotId === focused()"
                [class.lot__cell--selected]="bay.placement.spotId === selected()"
                [style.left.%]="placement(bay).left"
                [style.top.%]="placement(bay).top"
                [style.width.%]="placement(bay).width"
                [style.height.%]="placement(bay).height"
                (click)="activate.emit(bay.placement.spotId)"
                (focus)="focusMove.emit(bay.placement.spotId)"
                (pointerenter)="hovered.set(bay.placement.spotId)"
                (pointerleave)="hovered.set(null)"
              ></div>
            }
          </div>
        }
      </div>
    </div>
    </div>

    <!--
      The minimap, which appears only once the plan is bigger than its frame - at
      fit-to-width there is nothing it could tell you. Decorative and aria-hidden: it
      reports where the scroll is, and the scroll is already operable and already
      announced. A second control here would be a second thing to keep in step.
    -->
    @if (zoom() > 1) {
      <svg
        class="mini"
        [attr.viewBox]="'0 0 ' + box().w + ' ' + box().h"
        aria-hidden="true"
        focusable="false"
        preserveAspectRatio="xMidYMid meet"
      >
        @for (bay of bays(); track bay.placement.spotId) {
          <rect
            [class]="'mini__bay mini__bay--' + tone(bay)"
            [attr.x]="bay.placement.geometry.x"
            [attr.y]="bay.placement.geometry.y"
            [attr.width]="bay.placement.geometry.w"
            [attr.height]="bay.placement.geometry.h"
          />
        }
        <rect
          class="mini__port"
          [attr.x]="frame().x"
          [attr.y]="frame().y"
          [attr.width]="frame().w"
          [attr.height]="frame().h"
        />
      </svg>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        position: relative;
        --lot-hatch: var(--ink-2);
      }

      /* ----------------------------------------------------------------- tools */

      .tools {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--sp-4);
        margin-bottom: var(--sp-2);
      }

      .tools__zoom {
        display: flex;
        gap: 2px;
      }

      .tools__zoom button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font: inherit;
        /* A comfortable pointer target, which also puts SC 2.5.8 out of play. */
        min-width: 44px;
        min-height: 44px;
        border: 1px solid var(--rule);
        border-radius: 3px;
        background: transparent;
        color: var(--ink-2);
        cursor: pointer;
      }

      .tools__zoom button:disabled {
        opacity: 0.4;
        cursor: default;
      }

      @media (hover: hover) and (pointer: fine) {
        .tools__zoom button:not(:disabled):hover {
          border-color: var(--ink-3);
          color: var(--ink-1);
        }
      }

      .tools__scale {
        margin: 0;
        font-size: var(--t-fine);
        color: var(--ink-3);
        font-variant-numeric: tabular-nums;
      }

      /*
       * The frame. The browser's scroll container is the pan: it costs nothing, it is
       * already keyboard-operable, and it already has scrollbars a person can drag.
       */
      .port {
        overflow: auto;
        /* Keep in step with FRAME_HEIGHT above. */
        max-height: 78vh;
        overscroll-behavior: contain;
        background: var(--concrete);
        border: 1px solid var(--rule);
      }

      .lot {
        position: relative;
        background: var(--concrete);
        /* Keeps a 200-bay level from invalidating layout for the whole page. */
        contain: layout paint;
      }

      .lot__art,
      .lot__grid {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }

      /* ------------------------------------------------------------------- art */

      /* --------------------------------------------------------------- plate */

      .lot__wall {
        fill: none;
        stroke: var(--steel);
        stroke-width: 14;
      }

      /*
       * Aisle markings are paint on a deck, not meaning, so they are drawn in the rule
       * value. The signal is reserved for position, turn and the one action, and a lane
       * marking is none of those.
       */
      .lot__aisle {
        stroke: var(--rule);
        stroke-width: 5;
        stroke-dasharray: 40 40;
      }

      .lot__arrow {
        fill: var(--rule);
      }

      .lot__core {
        fill: var(--concrete-deep);
        stroke: var(--steel);
        stroke-width: 8;
      }

      .lot__row-letter {
        fill: var(--steel-soft);
      }

      .lot__level-label {
        fill: var(--steel-faint);
        letter-spacing: 0.12em;
      }

      .lot__core-label {
        fill: var(--steel-soft);
        letter-spacing: 0.1em;
      }

      .lot__floor {
        stroke-width: 8;
        /*
         * Status changes ease rather than snap: when occupancy reloads after a draw, the
         * bays that changed hands visibly turn, which is the result being read rather
         * than a frame swapped under the reader. The edge is quicker - it is hover.
         */
        transition:
          fill 360ms ease,
          stroke 160ms ease,
          stroke-width 160ms ease;
      }

      /*
       * The plan's one authored moment: when it is drawn, the bays come up row by row,
       * front to back, the way a deck is read. Opacity and a slight scale only - both
       * composited - and 'backwards' fill, so once it has run the bay belongs to its
       * status and filter classes again (a 'both' fill would pin it at full opacity and
       * break the dimming a filter applies).
       */
      .lot__bay {
        transform-box: fill-box;
        transform-origin: center;
        transition: opacity 240ms cubic-bezier(0.16, 1, 0.3, 1);
        animation: bay-in 460ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
        animation-delay: calc(var(--row, 0) * 70ms + var(--col, 0) * 14ms);
      }

      @keyframes bay-in {
        from {
          opacity: 0;
          transform: scale(0.82);
        }
      }

      /*
       * Status is encoded on fill plus border treatment; type is encoded on a glyph. Two
       * axes, because collapsing them means inventing fifteen colours, and colour alone
       * carries no meaning for anyone (SC 1.4.1). Every bay also states its status in
       * words, in the accessible name and in the table view.
       */
      .lot__bay--free .lot__floor {
        fill: var(--bay-free);
        stroke: var(--bay-free-edge);
        /* Dashed as well as green: the state survives greyscale and colour blindness. */
        stroke-dasharray: 26 18;
      }

      .lot__bay--held .lot__floor {
        fill: var(--bay-held);
        stroke: var(--bay-held-edge);
      }

      .lot__bay--mine .lot__floor {
        fill: var(--bay-mine);
        /* Yellow is too light to hold an edge against concrete, so the edge is steel. */
        stroke: var(--bay-mine-edge);
        stroke-width: 16;
      }

      .lot__bay--closed .lot__floor {
        fill: var(--bay-closed);
        stroke: var(--bay-closed-edge);
        opacity: 0.9;
      }

      .lot__cross {
        fill: url(#lot-cross);
        pointer-events: none;
      }

      /* The extruded side of a bay in 2.5D: the deck's own shadow, one step down. */
      .lot__kerb {
        fill: var(--concrete-deep);
      }

      .lot__code {
        pointer-events: none;
      }
      .lot__bay--free .lot__code {
        fill: var(--bay-free-ink);
      }
      .lot__bay--held .lot__code {
        fill: var(--bay-held-ink);
      }
      .lot__bay--closed .lot__code {
        fill: var(--bay-closed-ink);
      }
      .lot__bay--mine .lot__code {
        fill: var(--bay-mine-ink);
      }

      .lot__glyph {
        fill: var(--bay-mine-ink);
        pointer-events: none;
      }
      .lot__bay--free .lot__glyph {
        fill: var(--bay-free-ink);
      }
      .lot__bay--held .lot__glyph {
        fill: var(--bay-held-ink);
      }
      .lot__bay--closed .lot__glyph {
        fill: var(--bay-closed-ink);
      }

      /* A filter de-emphasises rather than hides: a bay that vanishes breaks the plan. */
      .lot__bay--dim {
        opacity: 0.22;
      }

      /*
       * Hover. The pointer was over a bay with nothing to show for it, which on a plan of
       * two hundred identical rectangles leaves a person unsure which one they are about
       * to open. The edge brightens rather than the fill: the fill is carrying status.
       */
      .lot__bay--hot .lot__floor {
        stroke: var(--ink-1);
        stroke-width: 18;
        /*
         * SVG has no z-index, so a thicker edge would be half-covered by the next bay
         * painted. Drawing it inside the shape keeps it whole wherever the bay sits.
         */
        paint-order: stroke fill;
      }

      /* --------------------------------------------------------------- semantics */

      .lot__grid [role='row'] {
        display: contents;
      }

      .lot__cell {
        position: absolute;
        /* Transparent: the art underneath is the picture. This is the control. */
        background: transparent;
        border: 0;
        cursor: pointer;
        /* Below the WCAG 2.2 minimum the page scopes and zooms instead (SC 2.5.8). */
        min-width: 24px;
        min-height: 24px;
      }

      .lot__cell:focus {
        outline: none;
      }

      /*
       * The ring is drawn on the overlay element, not the SVG node, which is why it is
       * never painted over by a later sibling. 3:1 against both concrete and steel.
       */
      .lot__cell--focus:focus-visible::after,
      .lot__cell--selected::after {
        content: '';
        position: absolute;
        inset: -5px;
        border: 3px solid var(--steel);
        box-shadow: 0 0 0 3px var(--bay-line);
      }

      .lot__cell--selected::after {
        border-color: var(--bay-line);
        box-shadow: 0 0 0 3px var(--surface-1);
        /* The ring closes in on the bay as it is chosen, so the eye lands on it. */
        animation: ring-in 320ms cubic-bezier(0.16, 1, 0.3, 1);
      }

      @keyframes ring-in {
        from {
          opacity: 0;
          transform: scale(1.35);
        }
      }

      /* ---------------------------------------------------------------- minimap */

      .mini {
        position: absolute;
        right: var(--sp-3);
        bottom: var(--sp-3);
        width: 9rem;
        /* The plan's own proportion, so the schematic cannot lie about the shape. */
        height: auto;
        max-height: 7rem;
        background: var(--concrete);
        border: 1px solid var(--rule);
        pointer-events: none;
      }

      .mini__bay {
        fill: var(--bay-held);
      }
      .mini__bay--free {
        fill: var(--bay-free);
      }
      .mini__bay--mine {
        fill: var(--bay-mine);
      }
      .mini__bay--closed {
        fill: var(--bay-closed);
      }

      .mini__port {
        fill: none;
        stroke: var(--ink-1);
        stroke-width: 24;
      }

      /* Under a phone's width the minimap would cover the plan it describes. */
      @media (max-width: 40rem) {
        .mini {
          display: none;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .lot__bay,
        .lot__floor,
        .lot__cell--selected::after {
          transition: none !important;
          animation: none !important;
        }
      }
    `,
  ],
})
export class LotMap {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly level = input.required<LotLevel>();
  readonly bays = input.required<readonly Bay[]>();
  /** Spot ids the current filter keeps. Everything else is dimmed, never removed. */
  readonly visible = input<ReadonlySet<string> | null>(null);
  readonly projection = input<Projection>('plan');
  readonly selected = input<string | null>(null);
  readonly focused = input<string | null>(null);
  readonly busy = input(false);

  readonly activate = output<string>();
  readonly focusMove = output<string>();
  readonly navigate = output<NavKey>();
  readonly search = output<string>();

  private readonly typeBuffer = signal('');
  private typeTimer: ReturnType<typeof setTimeout> | null = null;

  /** The bay under the pointer. Hover is a pointer affordance; focus is the keyboard's. */
  readonly hovered = signal<string | null>(null);

  /** Scale, as a multiple of fit-to-width. One is the whole level in the frame. */
  readonly zoom = signal(1);
  readonly maxZoom = 4;

  private readonly port = viewChild<ElementRef<HTMLElement>>('port');

  /** Where the frame currently sits over the plan, in the plan's own coordinates. */
  private readonly scrolled = signal({ left: 0, top: 0, w: 1, h: 1, sw: 1, sh: 1 });

  readonly zoomLabel = computed(() => `${Math.round(this.zoom() * 100)}%`);

  /** The widest the plan may be drawn, so at 100% the whole level is inside the frame. */
  readonly ceiling = computed(() => {
    const b = this.box();
    return `calc(${(b.w / b.h).toFixed(4)} * ${FRAME_HEIGHT} * ${this.zoom()})`;
  });

  readonly frame = computed(() => {
    const s = this.scrolled();
    const b = this.box();
    return {
      x: (s.left / s.sw) * b.w,
      y: (s.top / s.sh) * b.h,
      w: (s.w / s.sw) * b.w,
      h: (s.h / s.sh) * b.h,
    };
  });

  /**
   * Zoom about the centre of the frame, not about the top left, so the bay a person was
   * looking at is still the bay in front of them afterwards.
   */
  zoomBy(factor: number): void {
    const el = this.port()?.nativeElement;
    const from = this.zoom();
    const to = Math.min(this.maxZoom, Math.max(1, from * factor));
    if (to === from) return;

    const cx = el ? (el.scrollLeft + el.clientWidth / 2) / from : 0;
    const cy = el ? (el.scrollTop + el.clientHeight / 2) / from : 0;
    this.zoom.set(to);

    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollLeft = cx * to - el.clientWidth / 2;
      el.scrollTop = cy * to - el.clientHeight / 2;
      this.onScroll();
    });
  }

  fit(): void {
    this.zoom.set(1);
    this.onScroll();
  }

  /** Brings the selected bay back into the frame after a zoom has left it outside. */
  centreOnSelected(): void {
    const id = this.selected();
    if (!id) return;
    this.host.nativeElement
      .querySelector<HTMLElement>(`[data-spot-id="${id}"]`)
      ?.scrollIntoView({ block: 'center', inline: 'center' });
  }

  onScroll(): void {
    const el = this.port()?.nativeElement;
    if (!el) return;
    this.scrolled.set({
      left: el.scrollLeft,
      top: el.scrollTop,
      w: el.clientWidth,
      h: el.clientHeight,
      sw: Math.max(1, el.scrollWidth),
      sh: Math.max(1, el.scrollHeight),
    });
  }

  readonly box = computed(() => projectedViewBox(this.level(), this.projection()));
  readonly aspect = computed(() => `${this.box().w} / ${this.box().h}`);

  /** Rows are the authored aisles, in order, so the DOM order matches what is announced. */
  readonly rows = computed(() => {
    const groups = new Map<number, Bay[]>();
    for (const bay of this.bays()) {
      const list = groups.get(bay.placement.row) ?? [];
      list.push(bay);
      groups.set(bay.placement.row, list);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a - b)
      .map(([row, bays]) => ({ row, bays: bays.sort((x, y) => x.placement.col - y.placement.col) }));
  });

  readonly maxCols = computed(() => Math.max(1, ...this.rows().map((r) => r.bays.length)));

  /**
   * One user-unit-per-pixel figure for the whole level, so the code either shows on every
   * bay or on none. Mixed is worse than either: it reads as a rendering fault.
   */
  private readonly unitsPerPx = signal(1);

  readonly codeVisible = computed(() => {
    const first = this.bays()[0];
    return first ? showsCode(first.placement, this.unitsPerPx()) : false;
  });

  readonly codeSize = computed(() => Math.round(this.box().w / 58));

  rowLetter(row: number): string {
    return String.fromCharCode(64 + row);
  }

  /** Vertical centre of a row, for the letter painted beside it in the service strip. */
  rowMidY(row: number): number {
    const bays = this.rows().find((r) => r.row === row)?.bays ?? [];
    const g = bays[0]?.placement.geometry;
    return g ? g.y + g.h / 2 : 0;
  }

  /** The right edge of the lift core, which the letters must clear. */
  private readonly coreRight = computed(() => this.margin() * (1.35 + 1.5));

  /** Where the bays begin: the left edge of the leftmost first bay on the level. */
  private readonly baysLeft = computed(() => {
    const xs = this.rows()
      .map((r) => r.bays[0]?.placement.geometry.x)
      .filter((x): x is number => x !== undefined);
    return xs.length > 0 ? Math.min(...xs) : this.margin() * 4;
  });

  /**
   * Every letter on one vertical line, centred in the gutter between the lift and the
   * bays.
   *
   * It used to be a fixed `margin * 3`, which on the seeded deck put the letters three
   * units off the lift's right wall: B and C, level with the lift, read as glued to it,
   * while A and D, above and below it, read as floating - one column of letters that
   * looked like two. Taken from the geometry, the gutter is the same for every row and
   * stays right if the deck is redrawn.
   */
  readonly letterX = computed(() => Math.round((this.coreRight() + this.baysLeft()) / 2));

  /** Lane paint starts at the bays, not across the letters' gutter. */
  readonly aisleStart = computed(() => this.baysLeft() - Math.round(this.margin() * 0.15));
  readonly glyphOffset = computed(() => this.codeSize() * 1.25);

  constructor() {
    // The code threshold is a rendered-size question, so it needs the real box.
    effect((onCleanup) => {
      const el = this.host.nativeElement.querySelector('.lot') as HTMLElement | null;
      if (!el || typeof ResizeObserver === 'undefined') return;
      const w = this.box().w;
      const ro = new ResizeObserver(([entry]) => {
        const px = entry?.contentRect.width ?? 0;
        if (px > 0) this.unitsPerPx.set(w / px);
      });
      ro.observe(el);
      onCleanup(() => ro.disconnect());
    });
  }

  /**
   * The plate is authored in level space, so the projection has to be applied to it as a
   * transform rather than baked into its coordinates. Same matrix as the bays, which is
   * what keeps the shell sitting under them instead of floating beside them.
   */
  readonly plateTransform = computed(() => {
    if (this.projection() === 'plan') return null;
    const [a, b, c, d] = ISO_MATRIX;
    const box = this.box();
    return `matrix(${a},${b},${c},${d},${-box.x},${-box.y})`;
  });
  /** The shell inset, derived from the level so a bigger deck gets a bigger margin. */
  readonly margin = computed(() => Math.round(Math.min(this.box().w, this.box().h) / 16));

  /** One aisle line down the middle of each pair of facing rows. */
  readonly aisles = computed(() => {
    const rows = this.rows();
    const out: { y: number }[] = [];
    for (let i = 0; i + 1 < rows.length; i += 2) {
      const a = rows[i]!.bays[0]?.placement.geometry;
      const b = rows[i + 1]!.bays[0]?.placement.geometry;
      if (!a || !b) continue;
      out.push({ y: Math.round((a.y + a.h + b.y) / 2) });
    }
    return out;
  });

  /** A direction arrow on the aisle, so the plan reads as traffic rather than a grid. */
  arrow(y: number): string {
    const x = this.box().w / 2;
    const s = this.margin() / 3;
    return `${x - s},${y - s} ${x + s},${y} ${x - s},${y + s}`;
  }

  tone(bay: Bay): string {
    if (bay.isMine) return 'mine';
    switch (bay.status) {
      case 'FREE':
        return 'free';
      case 'OUT_OF_SERVICE':
        return 'closed';
      case 'HELD':
        return 'held';
    }
  }

  isDimmed(bay: Bay): boolean {
    const v = this.visible();
    return v !== null && !v.has(bay.placement.spotId);
  }

  name(bay: Bay): string {
    return renderLabel(bayLabel(bay, this.isDimmed(bay)));
  }

  face(bay: Bay): string {
    const b = this.box();
    return facePoints(bay.placement.geometry, this.projection(), { x: b.x, y: b.y });
  }

  side(bay: Bay): string {
    const b = this.box();
    return sidePoints(bay.placement.geometry, { x: b.x, y: b.y });
  }

  centre(bay: Bay): { x: number; y: number } {
    const pts = this.face(bay)
      .split(' ')
      .map((p) => p.split(',').map(Number));
    const xs = pts.map((p) => p[0]!);
    const ys = pts.map((p) => p[1]!);
    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
  }

  /** The tail of the code: at bay scale "014" is legible where "B2-014" is not. */
  short(bay: Bay): string {
    const parts = bay.placement.spotCode.split('-');
    return parts[parts.length - 1] ?? bay.placement.spotCode;
  }

  glyph(bay: Bay): string | null {
    if (bay.isMine) return '\u2713\ufe0e';
    switch (bay.placement.type) {
      case 'EV':
        return '\u26a1\ufe0e';
      default:
        return null;
    }
  }

  placement(bay: Bay) {
    return overlayBox(bay.placement.geometry, this.projection(), this.level());
  }

  /**
   * Keyboard handling for the grid. Movement is emitted rather than applied, because the
   * facade owns which cell is current -- the map stays a renderer.
   */
  onKeydown(event: KeyboardEvent): void {
    const nav: Record<string, NavKey> = {
      ArrowUp: 'ArrowUp',
      ArrowDown: 'ArrowDown',
      ArrowLeft: 'ArrowLeft',
      ArrowRight: 'ArrowRight',
      Home: 'Home',
      End: 'End',
      PageUp: 'PageUp',
      PageDown: 'PageDown',
    };

    const key = nav[event.key];
    if (key) {
      event.preventDefault();
      this.navigate.emit(key);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const id = this.focused();
      if (id) this.activate.emit(id);
      return;
    }

    // Type-ahead. One printable character at a time, with a one-second idle reset, so
    // "b214" lands on B2-014 instead of arrowing across two hundred cells to reach it.
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const next = this.typeBuffer() + event.key;
      this.typeBuffer.set(next);
      this.search.emit(next);
      if (this.typeTimer) clearTimeout(this.typeTimer);
      this.typeTimer = setTimeout(() => this.typeBuffer.set(''), 1000);
    }
  }

  /** Called by the page after the focused bay changes, so focus follows the model. */
  focusCell(spotId: string): void {
    const el = this.host.nativeElement.querySelector<HTMLElement>(
      `[data-spot-id="${spotId}"]`,
    );
    el?.focus();
  }
}
