import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { CyclesFacade, MetricsFacade } from '../../application/admin.facades';
import { ViewStateHost } from '../../shared/ui/view-state';
import { AllocationConfigFacade } from '../../application/allocation-config.facade';
import type { AllocationConfigVersion } from '../../domain/models';

/**
 * Admin — fairness (FR-22, §17).
 *
 * The distribution is the honest picture of whether the draw is working. A healthy
 * building is bunched at the low scores with a short tail; a long tail means somebody
 * has been losing for years, which is the exact thing the weighting exists to prevent.
 * So the highest score and the never-won count are called out separately instead of
 * being averaged into comfort.
 */
@Component({
  selector: 'app-metrics-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatSelectModule,
    ViewStateHost,
  ],
  template: `
    <header class="head">
      <div>
        <h1 class="head__h">Fairness</h1>
        <p class="head__p">Whether the draw is spreading bays the way it is supposed to.</p>
      </div>
      <button matButton="outlined" type="button" (click)="facade.refresh()">Refresh</button>
    </header>

    <app-view-state
      [state]="facade.state()"
      [skeletonCount]="4"
      loadingLabel="Loading fairness data"
      emptyTitle="No fairness data yet"
      emptyBody="Scores appear after the first draw. Until then every resident sits at zero."
      (retry)="facade.refresh()"
    >
      @if (facade.value(); as m) {
        <!--
          A figure the server did not send is absent, and is drawn as absent - but a row
          of nothing but dashes is not a tally reporting absence, it is a tally that
          looks broken. When none of the figures came back, the row is replaced by the
          one sentence that actually tells an administrator what to do.
        -->
        @if (noFigures()) {
          <p class="tally__out">
            The server did not return the fairness figures. The register below is
            unaffected; the rules can still be read and changed.
            <button type="button" class="tally__retry" (click)="facade.refresh()">
              Try again
            </button>
          </p>
        } @else {
        <div class="tally">
          <div class="tally__item">
            <span class="tally__n stencil" [class.tally__n--none]="m.residents === null">
              {{ m.residents ?? dash }}
            </span>
            <span class="tally__l">residents</span>
          </div>
          <div class="tally__item">
            <span class="tally__n stencil" [class.tally__n--none]="m.averageWaitHours === null">
              {{ m.averageWaitHours ?? dash }}
            </span>
            <span class="tally__l">average wait, hours</span>
          </div>
          <div class="tally__item" [class.tally__item--watch]="longWait()">
            <span class="tally__n stencil" [class.tally__n--none]="m.maxWaitHours === null">
              {{ m.maxWaitHours ?? dash }}
            </span>
            <span class="tally__l">longest wait, hours</span>
          </div>
          <div class="tally__item">
            <span class="tally__n stencil" [class.tally__n--none]="m.neverServed === null">
              {{ m.neverServed ?? dash }}
            </span>
            <span class="tally__l">never served</span>
          </div>
        </div>
        }

        @if (longWait()) {
          <p class="watch">
            Someone has been waiting {{ m.maxWaitHours }} hours, which is longer than one
            whole allocation period. Waiting time is the first priority criterion, so they
            will be at the head of the next draw - but it is worth checking whether the
            building simply has too few bays for the number of residents who want one.
          </p>
        }

        <section class="dist">
          <h2 class="sec__h">Allocations per resident</h2>
          <p class="dist__p">
            Each row is the number of residents who have held a bay that many times. Rule D
            makes this the second criterion: among residents with equal waiting time, fewer
            past allocations wins.
          </p>
          @if (facade.distribution().length === 0) {
            <p class="dist__none">
              The server did not return a distribution for this period.
            </p>
          }
          <ul class="dist__list">
            @for (d of facade.distribution(); track d.servedCount) {
              <li class="dist__row">
                <span class="dist__score">{{ d.servedCount }}</span>
                <span class="dist__track">
                  <span class="dist__bar" [style.width.%]="d.percent"></span>
                </span>
                <span class="dist__count">
                  {{ d.residents }}
                  <span class="dist__weight">
                    {{ d.servedCount === 1 ? 'allocation' : 'allocations' }} each
                  </span>
                </span>
              </li>
            }
          </ul>
        </section>
      }
    </app-view-state>

    <!--
      Rule A. The policy numbers live here rather than in the code, because they are
      properties of the building, not of the software: a committee that votes to rotate
      every four months must not need a deployment. Saving inserts a new version on the
      server, and every run records the version it was decided with, so changing a number
      today never rewrites why someone lost a draw last quarter.
    -->
    <section class="config">
      <h2 class="sec__h">Allocation rules</h2>

      <app-view-state
        [state]="config.state()"
        [skeletonCount]="2"
        [busy]="config.busy()"
        loadingLabel="Loading the rules"
        busyLabel="Saving the rules"
        (retry)="config.refresh()"
      >
        @if (config.draft(); as c) {
          <p class="dist__p">
            In force: version {{ config.saved()?.version }}.
            @if (config.dirty()) {
              <strong>Unsaved changes.</strong>
            }
          </p>

          <div class="config__grid">
            <label class="field">
              <span class="field__l">Period length</span>
              <span class="field__row">
                <input
                  class="field__i"
                  type="number"
                  min="1"
                  max="60"
                  [ngModel]="c.allocationDurationMonths"
                  (ngModelChange)="config.edit('allocationDurationMonths', +$event)"
                />
                <span class="field__u">months</span>
              </span>
              <span class="field__h">
                How long a period runs, and so how long a bay is held before it goes back
                into the draw. Creating a period takes its end date from this.
              </span>
              @if (config.issues().get('allocationDurationMonths'); as issue) {
                <span class="field__e" role="alert">{{ issue }}</span>
              }
            </label>

            <label class="field">
              <span class="field__l">Early-waiting bias</span>
              <span class="field__row">
                <input
                  class="field__i"
                  type="number"
                  min="0"
                  max="8760"
                  [ngModel]="c.earlyWaitingBiasHours"
                  (ngModelChange)="config.edit('earlyWaitingBiasHours', +$event)"
                />
                <span class="field__u">hours</span>
              </span>
              <span class="field__h">
                How long after their assignment ends a resident is held behind someone
                taking part for the first time. 0 switches the rule off.
              </span>
              @if (config.issues().get('earlyWaitingBiasHours'); as issue) {
                <span class="field__e" role="alert">{{ issue }}</span>
              }
            </label>

            <label class="field">
              <span class="field__l">Waiting times tie within</span>
              <span class="field__row">
                <input
                  class="field__i"
                  type="number"
                  min="1"
                  [ngModel]="c.waitQuantumMinutes"
                  (ngModelChange)="config.edit('waitQuantumMinutes', +$event)"
                />
                <span class="field__u">minutes</span>
              </span>
              <span class="field__h">
                Two residents within this much of each other count as equal, which is what
                lets the second criterion and the raffle decide. Coarser means more raffles.
              </span>
              @if (config.issues().get('waitQuantumMinutes'); as issue) {
                <span class="field__e" role="alert">{{ issue }}</span>
              }
            </label>

            <label class="field">
              <span class="field__l">Bays the scheme allocates</span>
              <span class="field__row">
                <input
                  class="field__i"
                  type="number"
                  min="0"
                  [ngModel]="c.totalBays"
                  (ngModelChange)="config.edit('totalBays', +$event)"
                />
                <span class="field__u">bays</span>
              </span>
              <span class="field__h">0 means the whole active inventory.</span>
              @if (config.issues().get('totalBays'); as issue) {
                <span class="field__e" role="alert">{{ issue }}</span>
              }
            </label>

            <!--
              The one nullable knob, so it leads with the choice rather than the number -
              an empty box would have to mean "never", which no number can say.

              Counted in periods, not months: that is the unit the rule is stated in and
              the only one a resident can act on. Missing the draw is the thing that costs
              them, not the calendar passing.
            -->
            <label class="field">
              <span class="field__l">Waiting restarts after missing</span>
              <span class="field__row">
                <input
                  class="field__c"
                  type="checkbox"
                  [checked]="c.absenceResetPeriods !== null"
                  (change)="toggleAbsenceReset($event)"
                />
                <input
                  class="field__i"
                  type="number"
                  min="1"
                  [disabled]="c.absenceResetPeriods === null"
                  [ngModel]="c.absenceResetPeriods"
                  (ngModelChange)="config.edit('absenceResetPeriods', +$event)"
                />
                <span class="field__u">periods</span>
              </span>
              <span class="field__h">
                A resident who enters none of this many periods in a row starts their wait
                again from the entry that brings them back. Their history is untouched.
                Withdrawing an entry is taking part, not sitting out. Unticked, a
                returning resident keeps the wait they had.
              </span>
              @if (config.issues().get('absenceResetPeriods'); as issue) {
                <span class="field__e" role="alert">{{ issue }}</span>
              }
            </label>
          </div>

          @for (w of config.warnings(); track w) {
            <p class="watch">{{ w }}</p>
          }

          @if (config.error(); as e) {
            <p class="watch watch--stop" role="alert">
              {{ e.message }}
              <button matButton type="button" (click)="config.dismissError()">Dismiss</button>
            </p>
          }

          @if (config.savedVersion(); as v) {
            <p class="ok" role="status">Saved as version {{ v }}.</p>
          }

          <div class="config__actions">
            <button
              matButton="filled"
              type="button"
              [disabled]="!config.dirty() || config.busy()"
              [class.is-pending]="config.busy()"
              (click)="config.save()"
            >
              {{ config.busy() ? 'Saving…' : 'Save rules' }}
            </button>
            <button
              matButton="outlined"
              type="button"
              [disabled]="!config.dirty() || config.busy()"
              (click)="config.reset()"
            >
              Discard
            </button>

            <button type="button" class="link" (click)="config.toggleHistory()">
              {{ config.versions() ? 'Hide history' : 'Show history' }}
            </button>
          </div>

          <!--
            The trail. Versioning these numbers is only worth the complexity if someone
            can read what changed, so this is the view that pays for it: every version
            the server kept, newest first, with the date it was set. A row that differs
            from the one under it says so in words rather than asking a reader to
            compare six columns.
          -->
          @if (config.historyBusy()) {
            <p class="hist__note">Loading the history.</p>
          } @else if (config.versions(); as versions) {
            @if (versions.length === 0) {
              <p class="hist__note">No versions recorded yet.</p>
            } @else {
              <ol class="hist">
                @for (v of versions; track v.version; let i = $index) {
                  <li class="hist__row">
                    <span class="hist__v">v{{ v.version }}</span>
                    <span class="hist__when">{{ v.changedAt | date: 'd MMM y, HH:mm' }}</span>
                    <span class="hist__what">{{ changeSummary(versions, i) }}</span>
                  </li>
                }
              </ol>
            }
          }
        }
      </app-view-state>
    </section>

    <!--
      Running the draw from the screen that shows whether the draw is fair, because that
      is where an administrator is standing when they decide it is time.
    -->
    <section class="run">
      <h2 class="sec__h">Run the allocation</h2>

      @if (cycles.runnable(); as c) {
        <p class="dist__p">
          {{ c.label }} has closed registration and is ready. The draw assigns every
          available bay by waiting time, then past allocations, then the raffle for exact
          ties - and records the key it used for each resident, so any result can be
          explained afterwards.
        </p>
        <button
          class="run__go"
          type="button"
          [disabled]="cycles.busy()"
          (click)="runAllocation(c.id, c.label)"
        >
          {{ cycles.busy() ? 'Running…' : 'Run the draw for ' + c.label }}
        </button>
      } @else {
        <p class="dist__p">
          No period is ready to draw. A period has to have its registration closed first,
          which is done on
          <a routerLink="/admin/cycles">Cycles and draws</a>.
        </p>
      }

      @if (runMessage(); as msg) {
        <p class="ok" role="status">{{ msg }}</p>
      }
    </section>

    <section class="export">
      <h2 class="sec__h">Quarterly report</h2>
      <p class="dist__p">One row per person who took part in a cycle, as CSV (UC-07).</p>
      <div class="export__row">
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>Cycle to export</mat-label>
          <mat-select
            [ngModel]="selectedCycle()"
            (ngModelChange)="selectedCycle.set($event || null)"
          >
            @for (o of cycleOptions(); track o.value) {
              <mat-option [value]="o.value">{{ o.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <button
          matButton="outlined"
          type="button"
          [disabled]="!selectedCycle()"
          (click)="download()"
        >
          Download CSV
        </button>
      </div>
    </section>
  `,
  styles: [
    `
      :host {
        /* This screen's measure. The shell is full-bleed; pages own their width. */
        width: 100%;
        max-width: 88rem;
        margin: 0 auto;
        padding: var(--sp-6) var(--sp-5) var(--sp-8);
        /* A register needs columns, not a reading measure. */
        display: flex;
        flex-direction: column;
        gap: var(--sp-6);
      }
      .head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--sp-5);
        flex-wrap: wrap;
      }
      .head__h {
        font-size: var(--t-head);
      }
      .head__p {
        color: var(--steel-soft);
        margin-top: var(--sp-1);
      }
      .sec__h {
        font-size: var(--t-lead);
        margin-bottom: var(--sp-2);
      }

      .tally {
        display: flex;
        gap: var(--sp-7);
        flex-wrap: wrap;
        margin-bottom: var(--sp-5);
      }
      .tally__item {
        display: flex;
        flex-direction: column;
        border-top: 3px solid var(--steel);
        padding-top: var(--sp-2);
        min-width: 7.5rem;
      }
      .tally__item--watch {
        border-top-color: var(--attention);
      }
      .tally__item--watch .tally__n {
        color: var(--attention);
      }
      .tally__n {
        font-size: 2.4rem;
      }
      .tally__out {
        margin: var(--sp-5) 0 var(--sp-6);
        color: var(--steel-soft);
        max-width: 62ch;
      }

      .tally__retry {
        font: inherit;
        font-size: var(--t-small);
        padding: 0;
        border: 0;
        background: none;
        color: var(--signal);
        text-decoration: underline;
        cursor: pointer;
      }

      /* An absent figure is not a measurement, so it does not get the ink of one. */
      .tally__n--none {
        color: var(--steel-faint);
      }

      .tally__l {
        font-size: var(--t-fine);
        color: var(--steel-soft);
      }

      .watch {
        border-left: 3px solid var(--attention);
        background: var(--attention-wash);
        color: var(--warning);
        padding: var(--sp-3) var(--sp-4);
        margin-bottom: var(--sp-5);
      }

      .dist__p {
        color: var(--steel-soft);
        font-size: 0.9375rem;
        margin-bottom: var(--sp-4);
      }

      .dist__none {
        color: var(--steel-faint);
        font-size: var(--t-small);
      }

      .dist__list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--sp-2);
      }
      .dist__row {
        display: grid;
        grid-template-columns: 2.25rem 1fr 11rem;
        align-items: center;
        gap: var(--sp-4);
      }
      .dist__score {
        text-align: right;
        font-weight: 650;
      }
      .dist__track {
        height: 1.1rem;
        background: var(--concrete-deep);
      }
      .dist__bar {
        display: block;
        height: 100%;
        min-width: 3px;
        background: var(--signal);
      }
      .dist__count {
        font-size: 0.9375rem;
      }
      .dist__weight {
        display: block;
        font-size: var(--t-fine);
        color: var(--steel-faint);
      }

      /*
       * A policy number is painted onto the structure, not typed into a form. Each rule
       * is a plate: the figure stencilled at the size of a bay number, the unit set small
       * beside it, and the rule underneath carrying the state. No box, because a box
       * would make five of these read as a settings grid rather than as five decisions.
       */
      .config__grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
        gap: var(--sp-6) var(--sp-7);
        margin: var(--sp-5) 0 0;
      }

      .field {
        display: flex;
        flex-direction: column;
        gap: var(--sp-2);
      }

      .field__l {
        font-size: var(--t-small);
        color: var(--steel-soft);
      }

      .field__row {
        display: flex;
        align-items: baseline;
        gap: var(--sp-2);
        border-bottom: 3px solid var(--rule);
        padding-bottom: var(--sp-1);
        transition: border-color 120ms linear;
      }

      .field__i {
        font: inherit;
        font-size: var(--t-head);
        font-variation-settings:
          'wdth' 118,
          'wght' 760;
        width: 4.5ch;
        min-height: 44px;
        padding: 0;
        border: 0;
        /* Painted, so square. */
        border-radius: 0;
        background: transparent;
        color: var(--steel);
        /* Number spinners would put two tiny targets next to a 44px one. */
        appearance: textfield;
        -moz-appearance: textfield;
      }

      .field__i::-webkit-outer-spin-button,
      .field__i::-webkit-inner-spin-button {
        appearance: none;
        margin: 0;
      }

      .field__i:focus {
        outline: none;
      }

      /* The focus ring is the painted line: the accent means "this one is live". */
      .field__row:focus-within {
        border-bottom-color: var(--bay-line);
      }

      .field__u {
        font-size: var(--t-small);
        color: var(--steel-faint);
      }

      .field__h {
        font-size: var(--t-fine);
        color: var(--steel-soft);
        max-width: 32ch;
      }

      .field__e {
        font-size: var(--t-fine);
        color: var(--revoked);
      }

      .field__c {
        width: 18px;
        height: 18px;
        accent-color: var(--signal);
        flex: 0 0 auto;
      }

      /* ------------------------------------------------------------ the trail */

      .hist {
        list-style: none;
        margin: var(--sp-5) 0 0;
        padding: 0;
        border-top: 1px solid var(--rule-soft);
        max-width: 70ch;
      }

      /* Columns never move, whatever a row says. */
      .hist__row {
        display: grid;
        grid-template-columns: 4ch 13ch minmax(0, 1fr);
        gap: var(--sp-4);
        align-items: baseline;
        padding: var(--sp-3) 0;
        border-bottom: 1px solid var(--rule-soft);
        font-size: var(--t-small);
      }

      .hist__v {
        color: var(--steel-faint);
        font-variant-numeric: tabular-nums;
      }

      .hist__when {
        color: var(--steel-soft);
        font-variant-numeric: tabular-nums;
      }

      .hist__note {
        margin-top: var(--sp-4);
        font-size: var(--t-small);
        color: var(--steel-faint);
      }

      .link {
        font: inherit;
        font-size: var(--t-small);
        padding: 0;
        border: 0;
        background: none;
        color: var(--signal);
        text-decoration: underline;
        cursor: pointer;
      }

      @media (max-width: 46rem) {
        .hist__row {
          grid-template-columns: 4ch minmax(0, 1fr);
        }
        .hist__what {
          grid-column: 2;
        }
      }

      .config__actions {
        display: flex;
        gap: var(--sp-3);
        margin-top: var(--sp-6);
      }

      .config,
      .run {
        border-top: 1px solid var(--rule);
        padding-top: var(--sp-5);
        margin-top: var(--sp-7);
      }

      /*
       * The one loud element on the page. Running a draw reassigns every bay in the
       * building for three months, so it is built as a bay: painted steel behind the
       * yellow boundary line, at the scale of the thing it does.
       */
      .run__go {
        margin-top: var(--sp-4);
        min-height: 4.5rem;
        padding: 0 var(--sp-6);
        border: 0;
        border-left: 10px solid var(--bay-line);
        border-radius: 0;
        background: var(--signal);
        color: var(--on-primary);
        font-size: var(--t-lead);
        cursor: pointer;
      }

      .run__go:disabled {
        background: var(--steel-faint);
        border-left-color: var(--rule);
        cursor: default;
      }

      .run__go:focus-visible {
        outline: 3px solid var(--bay-line);
        outline-offset: 3px;
      }

      .ok {
        margin: var(--sp-4) 0 0;
        font-size: var(--t-small);
        color: var(--held);
      }

      .watch--stop {
        color: var(--revoked);
      }

      .export {
        border-top: 1px solid var(--rule);
        padding-top: var(--sp-4);
      }
      .export__row {
        display: flex;
        gap: var(--sp-3);
        align-items: center;
        flex-wrap: wrap;
      }

      @media (max-width: 36rem) {
        .dist__row {
          grid-template-columns: 2.25rem 1fr;
        }
        .dist__count {
          grid-column: 2;
        }
      }
    `,
  ],
})
export default class MetricsPage {
  readonly config = inject(AllocationConfigFacade);
  readonly cycles = inject(CyclesFacade);

  /** Confirmation of the last draw, shown where the button is rather than as a toast. */
  readonly runMessage = signal<string | null>(null);

  /** Kept as an escape so the source file stays ASCII whatever opens it. */
  readonly dash = '\u2014';

  /**
   * What a version changed, against the one before it. The list is newest first, so the
   * previous version is the next element - the oldest row has nothing to compare to and
   * says what it is instead of inventing a diff.
   */
  changeSummary(versions: readonly AllocationConfigVersion[], index: number): string {
    const now = versions[index];
    const before = versions[index + 1];
    if (!now) return '';
    if (!before) return 'The first recorded version.';

    const labels: [keyof AllocationConfigVersion, string, string][] = [
      ['allocationDurationMonths', 'period length', ' months'],
      ['earlyWaitingBiasHours', 'early-waiting bias', ' h'],
      ['waitQuantumMinutes', 'tie window', ' min'],
      ['absenceResetPeriods', 'absence reset', ' periods'],
      ['totalBays', 'bays allocated', ''],
    ];

    const changes = labels
      .filter(([key]) => now[key] !== before[key])
      .map(([key, label, unit]) => {
        const from = before[key] === null ? 'off' : `${before[key]}${unit}`;
        const to = now[key] === null ? 'off' : `${now[key]}${unit}`;
        return `${label} ${from} to ${to}`;
      });

    // A version with no differences is possible: the server rejects an empty patch, but
    // not one that sets every field to the value it already had.
    return changes.length === 0 ? 'No values changed.' : changes.join(', ');
  }

  /** Turns the absence reset on at the current value, or off entirely. */
  toggleAbsenceReset(event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.config.edit('absenceResetPeriods', on ? (this.config.saved()?.absenceResetPeriods ?? 1) : null);
  }

  /** True when the server returned the shape but none of the numbers in it. */
  readonly noFigures = computed(() => {
    const m = this.facade.value();
    return (
      !!m &&
      m.averageWaitHours === null &&
      m.maxWaitHours === null &&
      m.neverServed === null
    );
  });

  /** A wait past one whole period is the signal the scheme is oversubscribed. */
  readonly longWait = computed(() => {
    const max = this.facade.value()?.maxWaitHours;
    if (max === null || max === undefined) return false;
    const months = this.config.saved()?.allocationDurationMonths ?? 3;
    return max > months * 30 * 24;
  });

  async runAllocation(cycleId: string, label: string): Promise<void> {
    this.runMessage.set(null);
    const ok = await this.cycles.executeRun(cycleId);
    this.runMessage.set(
      ok ? `The draw for ${label} is done. Fairness figures below are recalculated.` : null,
    );
    if (ok) this.facade.refresh();
  }

  readonly facade = inject(MetricsFacade);


  readonly selectedCycle = signal<string | null>(null);

  readonly cycleOptions = computed(() =>
    this.cycles.allCycles().map((c) => ({ label: c.label, value: c.id })),
  );

  async download(): Promise<void> {
    const id = this.selectedCycle();
    if (!id) return;
    const label = this.cycles.allCycles().find((c) => c.id === id)?.label ?? id;
    await this.facade.downloadQuarterlyCsv(id, label);
  }
}
