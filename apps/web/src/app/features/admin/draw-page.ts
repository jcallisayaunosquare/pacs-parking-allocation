import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  type OnDestroy,
  type OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { DrawFacade } from '../../application/draw.facade';
import { LotMap } from '../../shared/ui/lot-map';
import type { Bay } from '../../domain/lot-layout';
import type { DecidedBy } from '../../domain/models';

/**
 * The draw, in the three parts it actually has.
 *
 * Not a Material stepper: that component is built for a form split across pages, and it
 * brings a horizontal header of numbered circles plus its own linear/editable state
 * machine, none of which this needs. The steps here are a board the administrator moves
 * along - the current one is the one lit, the ones behind are readable, and the one ahead
 * is unreachable until the draw has run, which the component enforces rather than
 * decorates.
 */
@Component({
  selector: 'app-draw-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, MatIconModule, LotMap],
  providers: [DrawFacade],
  template: `
    <header class="head">
      <h1 class="head__h">Run the draw</h1>
      <p class="head__p">
        Every bay in the building is reassigned for one period. Waiting time decides, past
        allocations break the tie, and a seeded draw settles what is still level.
      </p>
    </header>

    <!--
      The steps. Each one states what it is for, so the row is readable before anything
      has happened rather than being three numbered circles.

      Three states, each carried by two channels rather than by colour alone: the current
      step is lit and ruled, a step behind is marked done with a tick, and the step ahead
      is ruled off with a lock and says in words what unlocks it. Left and right arrow
      keys walk the row, because a row of three buttons that only answers the pointer is
      not a row anyone navigates.
    -->
    <nav class="steps" aria-label="The draw, in three steps">
      <ol class="steps__list" #steplist (keydown)="onStepKey($event)">
        @for (s of stepLabels; track s.index) {
          <li
            class="step"
            [class.step--on]="facade.step() === s.index"
            [class.step--done]="isDone(s.index)"
            [class.step--locked]="isLocked(s.index)"
          >
            <button
              type="button"
              class="step__b"
              [disabled]="isLocked(s.index)"
              [attr.aria-current]="facade.step() === s.index ? 'step' : null"
              (click)="facade.go(s.index)"
            >
              <span class="step__n" aria-hidden="true">
                @if (isDone(s.index)) {
                  <mat-icon class="step__i">check</mat-icon>
                } @else if (isLocked(s.index)) {
                  <mat-icon class="step__i">lock</mat-icon>
                } @else {
                  {{ s.index + 1 }}
                }
              </span>
              <span class="step__t">
                <span class="step__title">
                  {{ s.title }}
                  <span class="sr-only">
                    , step {{ s.index + 1 }} of 3{{ stateWord(s.index) }}
                  </span>
                </span>
                <!-- A locked step states what unlocks it. Dimming it says nothing. -->
                <span class="step__sub">{{ isLocked(s.index) ? s.locked : s.sub }}</span>
              </span>
            </button>
          </li>
        }
      </ol>
    </nav>

    @if (facade.error(); as e) {
      <p class="alert" role="alert">
        {{ e.message }}
        @if (e.traceId) {
          <span class="alert__id">Trace {{ e.traceId }}</span>
        }
        <button type="button" class="link" (click)="facade.dismissError()">Dismiss</button>
      </p>
    }

    @if (facade.loading()) {
      <p class="quiet">Loading the register.</p>
    } @else if (!facade.ready()) {
      <p class="quiet">
        No period is ready to draw. Open a period and close its registration first, on
        Periods.
      </p>
    } @else {
      @switch (facade.step()) {
        <!-- ------------------------------------------------ 1. who is in it -->
        @case (0) {
          <section class="panel">
            <div class="panel__say">
              <h2 class="panel__h">{{ facade.candidates().length }} residents in this draw</h2>
              <p class="panel__p">
                Period {{ facade.cycle()?.label }}, ending
                {{ facade.cycle()?.endsOn | date: 'longDate' }}. These are the eligible
                residents on the register. The authoritative list is recomputed on the
                server when the draw runs, from the registrations for this period.
              </p>

              <button
                class="go"
                type="button"
                [disabled]="facade.busy()"
                (click)="facade.run_()"
              >
                {{ facade.busy() ? 'Drawing…' : 'Run the draw' }}
              </button>

              <!--
                The rule, stated before it runs rather than explained afterwards. An
                administrator about to reassign every bay in the building should be able
                to say what is about to decide it, and the next step shows this same
                three-part rule doing the work, clause by clause.
              -->
              <ol class="rule">
                <li class="rule__step">
                  <span class="rule__n">1</span>
                  <span>Longest waiting time goes first.</span>
                </li>
                <li class="rule__step">
                  <span class="rule__n">2</span>
                  <span>Level on that, fewer past bays wins.</span>
                </li>
                <li class="rule__step">
                  <span class="rule__n">3</span>
                  <span>
                    Level on both, a seeded raffle decides - and every resident can
                    recompute their own token.
                  </span>
                </li>
              </ol>

              <p class="panel__warn">
                This assigns every bay for the whole period and cannot be undone from here.
              </p>
            </div>

            <div class="board">
              <p class="board__cap">The register</p>
              <ol class="rows">
                @for (r of facade.candidates(); track r.id) {
                  <li class="row">
                    <span class="row__n">{{ $index + 1 }}</span>
                    <span class="row__name">{{ r.fullName }}</span>
                    <span class="row__unit">{{ r.unitNumber }}</span>
                  </li>
                }
              </ol>
            </div>
          </section>
        }

        <!-- ------------------------------------------------- 2. who got what -->
        @case (1) {
          <section class="panel">
            <div class="panel__say">
              <h2 class="panel__h">
                {{ facade.assignedCount() }} of {{ facade.run()?.entrants }} residents won a bay
              </h2>
              <p class="panel__p">
                Ranked 1 to {{ facade.baysOffered() }} by the rule, not by chance.
                {{ facade.waitlistedCount() }} residents wait for the next period, and keep
                accruing waiting time from here - so a draw they lost raises them in the next.
              </p>

              <!--
                What actually decided the result, counted. The stepper is meant to teach
                the rule, and the shortest way to teach it is to show it working: waiting
                time usually does nearly all of the work, and a raffle settling two places
                is the honest shape of the policy rather than a claim about it.
              -->
              @if (facade.decidedTally().length > 0) {
                <ul class="tally">
                  @for (t of facade.decidedTally(); track t.by) {
                    <li class="tally__row">
                      <span class="tally__c">{{ t.count }}</span>
                      <span class="tally__w">{{ ruleSentence(t.by) }}</span>
                    </li>
                  }
                </ul>
              }

              <dl class="facts">
                <dt>Period</dt>
                <dd>{{ facade.cycle()?.label }}</dd>
                <dt>Bays offered</dt>
                <dd>{{ facade.baysOffered() }}</dd>
                <dt>Run</dt>
                <dd class="mono">{{ facade.run()?.runId }}</dd>
                <dt>Algorithm</dt>
                <dd class="mono">{{ facade.run()?.algorithmVersion }}</dd>
              </dl>

              <button class="go" type="button" (click)="facade.go(2)">See them on the lot</button>
            </div>

            <!--
              The winners, and only the winners, in the order the rule produced them.
              Rank is the subject of this board: a bare list of names answers "who got a
              bay", and the question an administrator is actually asked is "why them and
              not me". So every row carries the clause that decided its place, and the
              board is read against the cut line at N.
            -->
            <div class="board">
              <p class="board__cap">
                Won a bay &middot; 1 to {{ facade.baysOffered() }}
              </p>

              @if (facade.winners().length > 0) {
                <ol class="rows">
                  @for (w of facade.winners(); track w.residentId) {
                    <li class="row row--win">
                      <span class="row__n">{{ w.rank }}</span>
                      <span class="row__name">
                        {{ w.fullName }}
                        <span class="row__why">{{ ruleWord(w.decidedBy) }}</span>
                      </span>
                      <span class="row__bay">{{ w.spotCode }}</span>
                    </li>
                  }
                </ol>
              } @else {
                <!--
                  The record is a separate read from the run. The run still happened, so
                  this says what is missing rather than implying nobody won.
                -->
                <p class="board__none">
                  {{ facade.assignedCount() }} bays were assigned, but the ranked record
                  could not be read, so the order cannot be shown here. The lot below is
                  unaffected.
                </p>
              }
            </div>
          </section>
        }

        <!-- ------------------------------------------------------ 3. the lot -->
        @case (2) {
          <section class="lot">
            <div class="lot__say">
              <!--
                The period names the board. On this step the plan fills the screen, and
                without the period in the heading there is nothing on it that says which
                draw is being looked at.
              -->
              <p class="lot__period">{{ facade.cycle()?.label }}</p>
              <h2 class="panel__h">The lot, as the draw left it</h2>
              <p class="panel__p">
                The bays fill in the order the rule put them, highest waiting time first.
                Select a bay to see who holds it. This is the result of the run above, not
                the live state of the building.
              </p>

              <!--
                The one orchestrated moment in the product: the board filling. It shows
                the order the rule produced, which is the thing an administrator has to
                be able to repeat to a resident. It is skippable, replayable, and under
                reduced motion it never runs at all.
              -->
              <p class="reveal" role="status" aria-live="polite">
                @if (revealing()) {
                  <span class="reveal__count">
                    {{ revealed()?.size ?? 0 }} of {{ facade.assignedCount() }} placed
                  </span>
                  <button type="button" class="link" (click)="showAll()">Show all now</button>
                } @else {
                  <span class="reveal__count">All {{ facade.assignedCount() }} bays placed</span>
                  <button type="button" class="link" (click)="replay()">
                    <mat-icon class="link__i">replay</mat-icon>
                    Replay in draw order
                  </button>
                }
              </p>
            </div>

            @if (facade.level(); as level) {
              <app-lot-map
                [level]="level"
                [bays]="facade.bays()"
                [visible]="revealed()"
                [selected]="selected()?.placement?.spotId ?? null"
                [focused]="selected()?.placement?.spotId ?? null"
                (activate)="select($event)"
              />

              @if (selected(); as bay) {
                <p class="pick">
                  <strong class="stencil">{{ bay.placement.spotCode }}</strong>
                  {{ bay.occupant ? bay.occupant.displayName : 'not assigned in this draw' }}
                </p>
              }
            }
          </section>
        }
      }

      <!--
        Back and on, at the foot of the step rather than only in the row above it: after
        reading a screenful of result the row of steps is off the top of the viewport.
      -->
      <nav class="move" aria-label="Move between steps">
        <button
          type="button"
          class="move__b"
          [disabled]="facade.step() === 0"
          (click)="back()"
        >
          <mat-icon class="move__i">arrow_back</mat-icon>
          {{ facade.step() > 0 ? stepLabels[facade.step() - 1].title : 'Back' }}
        </button>

        <p class="move__where">Step {{ facade.step() + 1 }} of 3</p>

        <button
          type="button"
          class="move__b"
          [disabled]="facade.step() === 2 || !facade.drawn()"
          [attr.title]="facade.drawn() ? null : 'Run the draw first'"
          (click)="next()"
        >
          {{ facade.step() < 2 ? stepLabels[facade.step() + 1].title : 'Done' }}
          <mat-icon class="move__i">arrow_forward</mat-icon>
        </button>
      </nav>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        max-width: 88rem;
        margin: 0 auto;
        padding: var(--sp-6) var(--sp-5) var(--sp-8);
      }

      .head__h {
        margin: 0;
        font-size: var(--t-head);
        color: var(--ink-1);
      }

      .head__p {
        margin: var(--sp-2) 0 0;
        color: var(--ink-2);
        max-width: 62ch;
      }

      /* ------------------------------------------------------------- the steps */

      .steps {
        margin: var(--sp-6) 0;
      }

      .steps__list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        border: 1px solid var(--rule);
      }

      .step + .step {
        border-left: 1px solid var(--rule);
      }

      .step__b {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: flex-start;
        gap: var(--sp-3);
        font: inherit;
        text-align: left;
        padding: var(--sp-4);
        border: 0;
        /*
         * The progress rule. It is reserved at rest, so lighting a step never shifts the
         * row by three pixels, and it is the only place the signal appears here.
         */
        border-bottom: 3px solid transparent;
        background: transparent;
        color: var(--ink-2);
        cursor: pointer;
      }

      .step__n {
        flex: 0 0 auto;
        /* A fixed column, so the tick and the lock land where the digit was. */
        width: 1.5ch;
        display: flex;
        justify-content: center;
        font-variation-settings:
          'wdth' 112,
          'wght' 620;
        color: var(--ink-3);
      }

      .step__i {
        font-size: 18px;
        width: 18px;
        height: 18px;
      }

      .step__t {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }

      .step__title {
        font-size: var(--t-body);
        color: var(--ink-1);
      }

      .step__sub {
        font-size: var(--t-small);
        color: var(--ink-3);
      }

      /* ------------------------------------------------- the three step states */

      .step--on .step__b {
        background: var(--surface-1);
        border-bottom-color: var(--signal);
      }

      .step--on .step__n,
      .step--on .step__title {
        color: var(--signal);
      }

      /*
       * Done: the rule stays, at the value of a hairline rather than a signal, and the
       * number becomes a tick. Two channels, so the state is not a colour.
       */
      .step--done .step__b {
        border-bottom-color: var(--rule);
      }

      .step--done .step__n {
        color: var(--ink-2);
      }

      @media (hover: hover) and (pointer: fine) {
        .step__b:not(:disabled):hover {
          background: var(--surface-1);
        }

        .step--done .step__b:hover {
          border-bottom-color: var(--ink-3);
        }
      }

      /*
       * Locked: ruled off rather than faded out. A step at 50% opacity reads as a
       * rendering fault; a hatched rule reads as closed, and the sub-label says why.
       */
      .step--locked .step__b {
        cursor: default;
        background: repeating-linear-gradient(
          -45deg,
          transparent 0 7px,
          var(--rule-soft) 7px 8px
        );
        border-bottom-color: transparent;
      }

      .step--locked .step__title {
        color: var(--ink-3);
      }

      .step--locked .step__n {
        color: var(--ink-3);
      }

      /* ------------------------------------------------------------ the panels */

      .panel {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 0.9fr);
        gap: var(--sp-7);
        align-items: start;
      }

      .panel__h {
        margin: 0;
        font-size: var(--t-title);
        color: var(--ink-1);
      }

      .panel__p {
        margin: var(--sp-3) 0 var(--sp-5);
        color: var(--ink-2);
        max-width: 50ch;
      }

      .panel__warn {
        margin: var(--sp-3) 0 0;
        font-size: var(--t-small);
        color: var(--ink-3);
        max-width: 46ch;
      }

      /*
       * The consequential control on the screen, and the only filled thing on it.
       */
      .go {
        font: inherit;
        font-size: var(--t-body);
        font-weight: 600;
        min-height: 3rem;
        padding: 0 var(--sp-6);
        border: 0;
        border-radius: 3px;
        background: var(--signal);
        color: var(--on-primary);
        cursor: pointer;
        touch-action: manipulation;
      }

      .go:disabled {
        opacity: 0.6;
        cursor: default;
      }

      .facts {
        margin: 0 0 var(--sp-5);
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--sp-2) var(--sp-5);
        font-size: var(--t-small);
      }

      .facts dt {
        color: var(--ink-3);
      }

      .facts dd {
        margin: 0;
        color: var(--ink-1);
      }

      /* A run id is a string to copy, not prose. */
      .mono {
        font-variation-settings:
          'wdth' 100,
          'wght' 500;
        word-break: break-all;
      }

      /* The rule, taught before it runs. Hairlines, like every other ruled list here. */
      .rule {
        list-style: none;
        margin: 0 0 var(--sp-5);
        padding: 0;
        max-width: 46ch;
        border-top: 1px solid var(--rule-soft);
      }

      .rule__step {
        display: grid;
        grid-template-columns: 2.5ch minmax(0, 1fr);
        gap: var(--sp-3);
        align-items: baseline;
        padding: var(--sp-2) 0;
        border-bottom: 1px solid var(--rule-soft);
        font-size: var(--t-small);
        color: var(--ink-2);
      }

      .rule__n {
        color: var(--ink-3);
        font-variant-numeric: tabular-nums;
      }

      /* The period, small and above the heading: context, not a title. */
      .lot__period {
        margin: 0 0 var(--sp-1);
        font-size: var(--t-small);
        letter-spacing: 0.08em;
        color: var(--signal);
      }

      /* What decided the result, counted. */
      .tally {
        list-style: none;
        margin: 0 0 var(--sp-5);
        padding: 0;
        max-width: 46ch;
        border-top: 1px solid var(--rule-soft);
      }

      .tally__row {
        display: grid;
        grid-template-columns: 3ch minmax(0, 1fr);
        gap: var(--sp-3);
        align-items: baseline;
        padding: var(--sp-2) 0;
        border-bottom: 1px solid var(--rule-soft);
        font-size: var(--t-small);
      }

      .tally__c {
        text-align: right;
        color: var(--signal);
        font-variant-numeric: tabular-nums;
      }

      .tally__w {
        color: var(--ink-2);
      }

      /* -------------------------------------------------------------- the board */

      .board {
        background: var(--board);
        color: var(--board-ink);
        padding: var(--sp-5);
      }

      .board__cap {
        margin: 0 0 var(--sp-3);
        font-size: var(--t-fine);
        letter-spacing: 0.2em;
        color: var(--board-ink-dim);
      }

      .rows {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 26rem;
        overflow: auto;
        border-top: 1px solid var(--board-rule);
      }

      /* Columns never move, whatever a row says. */
      .row {
        display: grid;
        grid-template-columns: 3.5ch 1fr 6ch;
        gap: var(--sp-4);
        align-items: baseline;
        padding: var(--sp-3) 0;
        border-bottom: 1px solid var(--board-rule);
        font-size: var(--t-small);
      }

      .row__n {
        color: var(--board-ink-dim);
        text-align: right;
      }

      .row__name {
        color: var(--board-ink);
      }

      .row__unit,
      .row__bay {
        color: var(--signal-on-board);
        text-align: right;
      }

      .row--past {
        opacity: 0.6;
      }

      /* The clause that decided a place, beside the name it decided. */
      .row__why {
        display: block;
        font-size: var(--t-fine);
        color: var(--board-ink-dim);
      }

      .row--win .row__n {
        color: var(--signal-on-board);
      }

      .board__none {
        margin: var(--sp-4) 0 0;
        font-size: var(--t-small);
        color: var(--board-ink-dim);
      }

      .cut {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        padding: var(--sp-4) 0 var(--sp-3);
        font-size: var(--t-fine);
        letter-spacing: 0.18em;
        color: var(--board-ink-dim);
      }

      .cut::after {
        content: '';
        flex: 1;
        height: 1px;
        background: repeating-linear-gradient(
          to right,
          var(--board-rule) 0 6px,
          transparent 6px 12px
        );
      }

      /* ---------------------------------------------------------------- the lot */

      .lot__say {
        margin-bottom: var(--sp-5);
      }

      .pick {
        margin: var(--sp-4) 0 0;
        font-size: var(--t-body);
        color: var(--ink-2);
      }

      .pick strong {
        color: var(--ink-1);
        font-size: var(--t-title);
        margin-right: var(--sp-3);
      }

      /* --------------------------------------------------------- the reveal line */

      .reveal {
        display: flex;
        align-items: baseline;
        gap: var(--sp-4);
        flex-wrap: wrap;
        margin: 0 0 var(--sp-5);
        font-size: var(--t-small);
      }

      .reveal__count {
        /* Tabular, because this number counts up and must not jitter. */
        color: var(--ink-2);
        font-variant-numeric: tabular-nums;
      }

      .link__i,
      .move__i {
        font-size: 16px;
        width: 16px;
        height: 16px;
        vertical-align: -3px;
      }

      /* ----------------------------------------------------- back, and on from here */

      .move {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--sp-4);
        margin-top: var(--sp-7);
        padding-top: var(--sp-4);
        border-top: 1px solid var(--rule);
      }

      .move__b {
        display: inline-flex;
        align-items: center;
        gap: var(--sp-2);
        font: inherit;
        font-size: var(--t-small);
        min-height: 2.75rem;
        padding: 0 var(--sp-4);
        border: 1px solid var(--rule);
        border-radius: 3px;
        background: transparent;
        color: var(--ink-1);
        cursor: pointer;
      }

      .move__b:disabled {
        /* Invisible rather than greyed: a dead end is not worth a row of grey buttons. */
        visibility: hidden;
      }

      @media (hover: hover) and (pointer: fine) {
        .move__b:hover {
          border-color: var(--ink-3);
        }
      }

      .move__where {
        margin: 0;
        font-size: var(--t-fine);
        color: var(--ink-3);
      }

      .quiet {
        color: var(--ink-3);
      }

      .alert {
        margin: 0 0 var(--sp-5);
        padding: var(--sp-3) var(--sp-4);
        background: var(--danger-wash);
        color: var(--danger);
        display: flex;
        gap: var(--sp-4);
        align-items: baseline;
        flex-wrap: wrap;
      }

      .alert__id {
        font-size: var(--t-fine);
      }

      .link {
        font: inherit;
        font-size: var(--t-small);
        border: 0;
        background: none;
        color: inherit;
        text-decoration: underline;
        cursor: pointer;
      }

      @media (max-width: 62rem) {
        .steps__list {
          grid-template-columns: minmax(0, 1fr);
        }

        .step + .step {
          border-left: 0;
          border-top: 1px solid var(--rule);
        }

        .panel {
          grid-template-columns: minmax(0, 1fr);
          gap: var(--sp-5);
        }
      }
    `,
  ],
})
export default class DrawPage implements OnInit, OnDestroy {
  readonly facade = inject(DrawFacade);

  readonly selected = signal<Bay | null>(null);

  private readonly stepButtons = viewChild<ElementRef<HTMLElement>>('steplist');

  readonly stepLabels = [
    {
      index: 0 as const,
      title: 'The register',
      sub: 'Who is in this draw',
      locked: '',
    },
    {
      index: 1 as const,
      title: 'The result',
      sub: 'Who got which bay',
      locked: 'After the draw has run',
    },
    {
      index: 2 as const,
      title: 'The lot',
      sub: 'Where those bays are',
      locked: 'After the draw has run',
    },
  ];

  /**
   * The bays the reveal has painted so far, or null for "all of them". Null is also what
   * the map wants when nothing is being staged, so the quiet state costs nothing.
   */
  private readonly _revealed = signal<ReadonlySet<string> | null>(null);
  readonly revealed = this._revealed.asReadonly();
  readonly revealing = computed(() => this._revealed() !== null);

  private revealTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Arriving at the lot step is what stages the reveal, however the step was reached.
    effect(() => {
      if (this.facade.step() === 2 && this.facade.drawn()) this.replay();
      else this.stopReveal();
    });
  }

  ngOnInit(): void {
    void this.facade.load();
  }

  ngOnDestroy(): void {
    this.stopReveal();
  }

  /**
   * The clause that decided a place, as a tag beside a name. Short on purpose: it sits
   * in a column and has to be scannable down the list, not read as a sentence.
   */
  ruleWord(by: DecidedBy): string {
    switch (by) {
      case 'WAITING_TIME':
        return 'waited longest';
      case 'ALLOCATION_HISTORY':
        return 'fewer past bays';
      case 'RAFFLE':
        return 'raffle';
      case 'EARLY_WAITING_BIAS':
        return 'early-waiting window';
    }
  }

  /** The same clause as a counted statement, for the tally that teaches the rule. */
  ruleSentence(by: DecidedBy): string {
    switch (by) {
      case 'WAITING_TIME':
        return 'decided on waiting time alone';
      case 'ALLOCATION_HISTORY':
        return 'were level on waiting time, so fewer past bays decided';
      case 'RAFFLE':
        return 'were level on both, so the seeded raffle decided';
      case 'EARLY_WAITING_BIAS':
        return 'were inside the early-waiting window';
    }
  }

  // ------------------------------------------------------------------ the steps

  isDone(index: number): boolean {
    return this.facade.step() > index && (index === 0 ? this.facade.drawn() : true);
  }

  /** Nothing past the register exists until the draw has actually run. */
  isLocked(index: number): boolean {
    return index > 0 && !this.facade.drawn();
  }

  /** Read after the step title, so the state is spoken and not only drawn. */
  stateWord(index: number): string {
    if (this.isLocked(index)) return ', locked until the draw has run';
    if (this.facade.step() === index) return ', current';
    if (this.isDone(index)) return ', done';
    return '';
  }

  back(): void {
    const step = this.facade.step();
    if (step > 0) this.facade.go((step - 1) as 0 | 1);
  }

  next(): void {
    const step = this.facade.step();
    if (step < 2) this.facade.go((step + 1) as 1 | 2);
  }

  /** The row of steps answers the arrow keys, the way any row of related controls does. */
  onStepKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.next();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.back();
    } else {
      return;
    }
    // Focus follows the step, or the arrow key moves the screen and not the keyboard.
    const buttons = this.stepButtons()?.nativeElement.querySelectorAll('button');
    queueMicrotask(() => buttons?.item(this.facade.step())?.focus());
  }

  // ----------------------------------------------------------------- the reveal

  /**
   * Paints the assigned bays in the order the rule produced, which is the order an
   * administrator has to be able to recite. Under reduced motion it does not run: the
   * whole lot is simply there, which is the correct outcome, not a degraded one.
   */
  replay(): void {
    this.stopReveal();

    const order = this.drawOrder();
    const reduced =
      typeof matchMedia !== 'undefined' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced || order.length === 0) {
      this._revealed.set(null);
      return;
    }

    const painted = new Set<string>();
    this._revealed.set(painted);

    // One moment of fixed length whatever the building's size: 180 bays must not take
    // three times as long as 60.
    let i = 0;
    const every = Math.max(12, Math.round(1600 / order.length));
    this.revealTimer = setInterval(() => {
      painted.add(order[i]!);
      // A new Set each tick, because a signal holding a mutated Set never notifies.
      this._revealed.set(new Set(painted));
      if (++i >= order.length) this.showAll();
    }, every);
  }

  /** Ends the reveal where it would have ended: every bay on, nothing dimmed. */
  showAll(): void {
    this.stopReveal();
    this._revealed.set(null);
  }

  private stopReveal(): void {
    if (this.revealTimer) clearInterval(this.revealTimer);
    this.revealTimer = null;
  }

  /** Assignment order, resolved to the spot ids the map addresses bays by. */
  private drawOrder(): readonly string[] {
    const byCode = new Map(
      this.facade.bays().map((b) => [b.placement.spotCode, b.placement.spotId]),
    );
    return this.facade
      .assignments()
      .map((a) => byCode.get(a.spotCode))
      .filter((id): id is string => id !== undefined);
  }

  select(spotId: string): void {
    this.selected.set(
      this.facade.bays().find((b) => b.placement.spotId === spotId) ?? null,
    );
  }
}
