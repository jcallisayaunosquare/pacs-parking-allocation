import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { CyclesFacade, MetricsFacade } from '../../application/admin.facades';
import { ViewStateHost } from '../../shared/ui/view-state';

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
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatSelectModule, ViewStateHost],
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
      emptyTitle="No fairness data yet"
      emptyBody="Scores appear after the first draw. Until then every resident sits at zero."
      (retry)="facade.refresh()"
    >
      @if (facade.value(); as m) {
        <div class="tally">
          <div class="tally__item">
            <span class="tally__n stencil">{{ m.residents }}</span>
            <span class="tally__l">residents</span>
          </div>
          <div class="tally__item">
            <span class="tally__n stencil">{{ m.averageScore }}</span>
            <span class="tally__l">average score</span>
          </div>
          <div class="tally__item" [class.tally__item--watch]="m.maxScore >= 8">
            <span class="tally__n stencil">{{ m.maxScore }}</span>
            <span class="tally__l">highest score</span>
          </div>
          <div class="tally__item">
            <span class="tally__n stencil">{{ m.neverWon }}</span>
            <span class="tally__l">never won</span>
          </div>
        </div>

        @if (m.maxScore >= 8) {
          <p class="watch">
            Someone has gone {{ m.maxScore }} cycles without a bay. The weighting gives
            them {{ m.maxScore + 1 }} entries against one for a recent winner, so the draw
            is doing its job — but it is worth checking whether the building simply has
            too few bays for the number of residents who want one.
          </p>
        }

        <section class="dist">
          <h2 class="sec__h">Score distribution</h2>
          <p class="dist__p">
            Each row is the number of residents on that score. Entries in the next draw
            are the score plus one.
          </p>
          <ul class="dist__list">
            @for (d of facade.distribution(); track d.score) {
              <li class="dist__row">
                <span class="dist__score">{{ d.score }}</span>
                <span class="dist__track">
                  <span class="dist__bar" [style.width.%]="d.percent"></span>
                </span>
                <span class="dist__count">
                  {{ d.residents }}
                  <span class="dist__weight">
                    {{ d.score + 1 }} {{ d.score === 0 ? 'entry' : 'entries' }} each
                  </span>
                </span>
              </li>
            }
          </ul>
        </section>
      }
    </app-view-state>

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
      .tally__l {
        font-size: var(--t-fine);
        color: var(--steel-soft);
      }

      .watch {
        border-left: 3px solid var(--attention);
        background: var(--attention-wash);
        color: #5e3d0d;
        padding: var(--sp-3) var(--sp-4);
        margin-bottom: var(--sp-5);
      }

      .dist__p {
        color: var(--steel-soft);
        font-size: 0.9375rem;
        margin-bottom: var(--sp-4);
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
        background: var(--steel);
      }
      .dist__count {
        font-size: 0.9375rem;
      }
      .dist__weight {
        display: block;
        font-size: var(--t-fine);
        color: var(--steel-faint);
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
  readonly facade = inject(MetricsFacade);
  private readonly cycles = inject(CyclesFacade);

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
