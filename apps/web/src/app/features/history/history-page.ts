import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { DashboardFacade } from '../../application/dashboard.facade';
import { StatusPill } from '../../shared/ui/status-pill';
import { ViewStateHost } from '../../shared/ui/view-state';

/**
 * UC-10 — every past result and the score it was drawn against.
 *
 * The score column is the reason this page exists: it is the snapshot taken at draw
 * time (§11) and never recalculated, so a resident can see why a past draw went the way
 * it did instead of being asked to trust it. A plain list rather than a data grid,
 * because four quarters a year is not a data grid.
 */
@Component({
  selector: 'app-history-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, StatusPill, ViewStateHost],
  template: `
    <header class="head">
      <h1 class="head__h">Your results</h1>
      <p class="head__p">
        The score shown is the one you held when the draw ran, not your score today.
      </p>
    </header>

    <app-view-state
      [state]="facade.historyState()"
      [skeletonCount]="5"
      emptyTitle="You have not been in a draw yet"
      emptyBody="Once a draw runs with you entered, the result appears here along with the score it was drawn against."
      (retry)="facade.refresh()"
    >
      <ol class="list">
        @for (h of facade.history(); track h.cycle + h.recordedAt.toISOString()) {
          <li class="row" [class.row--won]="h.result === 'ASSIGNED'">
            <span class="row__line" aria-hidden="true"></span>

            <div class="row__main">
              <span class="row__cycle stencil">{{ h.cycle }}</span>
              <span class="row__what">
                @switch (h.result) {
                  @case ('ASSIGNED') {
                    Won bay {{ h.spotCode }}
                  }
                  @case ('WAITLISTED') {
                    Waitlist position {{ h.position }}
                  }
                  @default {
                    Did not take part
                  }
                }
              </span>
            </div>

            <div class="row__end">
              @switch (h.result) {
                @case ('ASSIGNED') {
                  <app-status-pill label="Won" tone="held" />
                }
                @case ('WAITLISTED') {
                  <app-status-pill label="Waitlisted" tone="waiting" />
                }
                @default {
                  <app-status-pill label="Skipped" tone="idle" />
                }
              }
              <span class="row__score">{{ h.scoreAtDraw }} score at draw</span>
              <span class="row__when">{{ h.recordedAt | date: 'd MMM y' }}</span>
            </div>
          </li>
        }
      </ol>
    </app-view-state>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--sp-5);
      }
      .head__h {
        font-size: var(--t-head);
      }
      .head__p {
        color: var(--steel-soft);
        margin-top: var(--sp-1);
      }

      .list {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .row {
        display: grid;
        grid-template-columns: 6px 1fr auto;
        gap: var(--sp-4);
        align-items: center;
        padding: var(--sp-3) 0;
        border-bottom: 1px solid var(--rule-soft);
      }

      /* The painted line marks the quarters you actually won. */
      .row__line {
        align-self: stretch;
        background: var(--rule);
      }
      .row--won .row__line {
        background: var(--bay-line);
      }

      .row__main {
        display: flex;
        align-items: baseline;
        gap: var(--sp-4);
        flex-wrap: wrap;
      }
      .row__cycle {
        font-size: 1.15rem;
        min-width: 5.5rem;
      }
      .row__what {
        color: var(--steel-soft);
      }

      .row__end {
        display: flex;
        align-items: center;
        gap: var(--sp-4);
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .row__score,
      .row__when {
        font-size: var(--t-fine);
        color: var(--steel-faint);
      }

      @media (max-width: 40rem) {
        .row {
          grid-template-columns: 6px 1fr;
        }
        .row__end {
          grid-column: 2;
          justify-content: flex-start;
          gap: var(--sp-3);
        }
      }
    `,
  ],
})
export default class HistoryPage {
  readonly facade = inject(DashboardFacade);
}
