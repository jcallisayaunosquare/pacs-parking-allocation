import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { DashboardFacade } from '../../application/dashboard.facade';
import { Bay } from '../../shared/ui/bay';
import type { PillTone } from '../../shared/ui/status-pill';
import { ViewStateHost } from '../../shared/ui/view-state';
import { FairnessExplainer } from '../../shared/ui/fairness-explainer';
import { ConfirmService } from '../../shared/ui/confirm';

/**
 * The resident screen. §17's three situations, one layout, and the bay carrying the
 * answer so it reads from across the room.
 *
 * One page-level query feeds everything; no child fetches on its own, which is what
 * keeps this from becoming six spinners and four race conditions. The bay is an
 * aria-live region so a screen reader announces an allocation that changed while the
 * page was open.
 */
@Component({
  selector: 'app-dashboard-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, Bay, ViewStateHost, FairnessExplainer],
  template: `
    <header class="head">
      <h1 class="head__h">Your parking</h1>
      @if (facade.resident(); as r) {
        <p class="head__who">{{ r.fullName }}, unit {{ r.unit }}</p>
      }
    </header>

    @if (facade.mutationError(); as err) {
      <div class="msg msg--bad" role="alert">
        {{ err.message }}
        <button class="btn btn--bare" type="button" (click)="facade.dismissError()">Dismiss</button>
      </div>
    }

    <app-view-state
      [state]="facade.state()"
      [skeletonCount]="4"
      emptyTitle="No parking activity yet"
      emptyBody="When the building opens registration for the next quarter, you can enter the draw from this page."
      (retry)="facade.refresh()"
    >
      <div class="live" aria-live="polite" aria-atomic="true">
        @switch (facade.situation()) {
          @case ('holds-spot') {
            @if (facade.assignment(); as a) {
              <app-bay
                variant="held"
                [code]="a.spotCode"
                [caption]="'Level ' + a.level + ', ' + bayType(a.type)"
                [note]="'Yours until ' + (a.validUntil | date: 'd MMMM y')"
                [label]="'You hold bay ' + a.spotCode"
                status="Held"
                statusTone="held"
              >
                <button
                  class="btn btn--on-dark btn--sm"
                  type="button"
                  [disabled]="facade.busy()"
                  (click)="release()"
                >
                  Release this spot
                </button>
              </app-bay>
            }
          }

          @case ('waitlisted') {
            @if (facade.waitlist(); as w) {
              <app-bay
                variant="waiting"
                [code]="'Position ' + w.position"
                caption="You are on the waitlist for this quarter."
                note="If someone releases a bay, the first person in the queue gets it. You will be told."
                [label]="'Waitlist position ' + w.position"
                status="Waiting"
                statusTone="waiting"
              />
            }
          }

          @case ('registration-open') {
            @if (facade.nextCycle(); as c) {
              <app-bay
                variant="open"
                [code]="c.label"
                caption="Registration is open."
                [note]="closingNote(c.registrationClosesAt)"
                [label]="'Registration open for ' + c.label"
                [status]="openBayStatus()"
                [statusTone]="openBayTone()"
              >
                @if (facade.registered()) {
                  <button
                    class="btn btn--bare"
                    type="button"
                    [disabled]="facade.busy()"
                    (click)="withdraw()"
                  >
                    Withdraw
                  </button>
                } @else if (facade.canRegister()) {
                  <button
                    class="btn btn--go"
                    type="button"
                    [disabled]="facade.busy()"
                    (click)="facade.register()"
                  >
                    Enter the draw
                  </button>
                } @else {
                  <p class="ineligible">
                    Ask the building administration to resolve this before the draw.
                  </p>
                }
              </app-bay>
            }
          }

          @default {
            <app-bay
              variant="closed"
              code="No open cycle"
              caption="Nothing is being allocated right now."
              note="The building opens registration once a quarter, before the draw."
              label="No open cycle"
              status="Closed"
              statusTone="idle"
            />
          }
        }
      </div>

      @if (facade.fairness(); as f) {
        <app-fairness-explainer [fairness]="f" />
      }

      @if (facade.nextCycle(); as c) {
        <section class="cycle">
          <h2 class="sec__h">Next cycle {{ c.label }}</h2>
          <ol class="timeline">
            <li class="timeline__step" [class.timeline__step--done]="past(c.registrationOpensAt)">
              <span class="timeline__when">{{ c.registrationOpensAt | date: 'd MMM' }}</span>
              <span class="timeline__what">Registration opens</span>
            </li>
            <li class="timeline__step" [class.timeline__step--done]="past(c.registrationClosesAt)">
              <span class="timeline__when">{{ c.registrationClosesAt | date: 'd MMM' }}</span>
              <span class="timeline__what">Registration closes</span>
            </li>
            <li class="timeline__step" [class.timeline__step--done]="past(c.startsOn)">
              <span class="timeline__when">{{ c.startsOn | date: 'd MMM' }}</span>
              <span class="timeline__what">Quarter begins</span>
            </li>
          </ol>
        </section>
      }

      <section class="recent">
        <div class="recent__head">
          <h2 class="sec__h">Recent results</h2>
          <a routerLink="/history">All results</a>
        </div>

        @if (recent().length === 0) {
          <p class="recent__none">
            You have not been in a draw yet. Your first result will appear here, with the
            score it was drawn against.
          </p>
        } @else {
          <ul class="results">
            @for (h of recent(); track h.cycle + h.recordedAt.toISOString()) {
              <li class="results__row">
                <span class="results__cycle">{{ h.cycle }}</span>
                <span class="results__what">
                  @switch (h.result) {
                    @case ('ASSIGNED') {
                      Won {{ h.spotCode }}
                    }
                    @case ('WAITLISTED') {
                      Waitlist position {{ h.position }}
                    }
                    @default {
                      Did not take part
                    }
                  }
                </span>
                <span class="results__score">{{ h.scoreAtDraw }} score at draw</span>
              </li>
            }
          </ul>
        }
      </section>
    </app-view-state>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--sp-6);
      }

      .head__h {
        font-size: var(--t-head);
      }
      .head__who {
        color: var(--steel-soft);
        margin-top: var(--sp-1);
      }

      .msg {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--sp-4);
      }

      .live {
        margin-bottom: var(--sp-6);
      }

      .ineligible {
        font-size: var(--t-fine);
        color: var(--steel-soft);
      }

      .sec__h {
        font-size: var(--t-lead);
        margin-bottom: var(--sp-3);
      }

      .cycle,
      .recent {
        border-top: 1px solid var(--rule);
        padding-top: var(--sp-4);
      }

      /* A genuine sequence, so it reads along a line. */
      .timeline {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-wrap: wrap;
        gap: var(--sp-5);
      }
      .timeline__step {
        display: flex;
        flex-direction: column;
        border-top: 3px solid var(--rule);
        padding-top: var(--sp-2);
        min-width: 10rem;
      }
      .timeline__step--done {
        border-top-color: var(--steel);
      }
      .timeline__when {
        font-weight: 650;
      }
      .timeline__what {
        font-size: var(--t-fine);
        color: var(--steel-soft);
      }

      .recent__head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--sp-4);
      }
      .recent__none {
        color: var(--steel-soft);
      }

      .results {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .results__row {
        display: grid;
        grid-template-columns: 6rem 1fr auto;
        gap: var(--sp-4);
        align-items: baseline;
        padding: var(--sp-3) 0;
        border-bottom: 1px solid var(--rule-soft);
      }
      .results__cycle {
        font-weight: 650;
      }
      .results__score {
        font-size: var(--t-fine);
        color: var(--steel-faint);
      }

      @media (max-width: 34rem) {
        .results__row {
          grid-template-columns: 1fr;
          gap: var(--sp-1);
        }
      }
    `,
  ],
})
export default class DashboardPage {
  readonly facade = inject(DashboardFacade);
  private readonly confirm = inject(ConfirmService);

  readonly recent = computed(() => this.facade.value()?.recentHistory ?? []);

  /** The open bay's marker depends on whether the resident is in and eligible. */
  readonly openBayStatus = computed<string>(() => {
    if (this.facade.registered()) return 'You are entered';
    return this.facade.canRegister() ? 'Open' : 'Not eligible';
  });

  readonly openBayTone = computed<PillTone>(() => {
    if (this.facade.registered()) return 'held';
    return this.facade.canRegister() ? 'attention' : 'revoked';
  });

  bayType(t: string): string {
    return t === 'ACCESSIBLE' ? 'accessible bay' : t === 'EV' ? 'EV bay' : 'standard bay';
  }

  past(at: Date): boolean {
    return at.getTime() <= Date.now();
  }

  closingNote(closesAt: Date): string {
    const days = Math.ceil((closesAt.getTime() - Date.now()) / 86_400_000);
    if (days <= 0) return 'Registration has closed. The draw runs next.';
    if (days === 1) return 'Registration closes tomorrow.';
    return `Registration closes in ${days} days.`;
  }

  async release(): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Release your bay?',
      body:
        'The bay goes to the first person on the waitlist and you cannot take it back ' +
        'until the next draw. Your score is not affected.',
      confirmLabel: 'Release it',
      cancelLabel: 'Keep it',
      danger: true,
    });
    if (ok) await this.facade.releaseSpot();
  }

  async withdraw(): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Withdraw from the draw?',
      body: 'You can enter again while registration is still open.',
      confirmLabel: 'Withdraw',
      cancelLabel: 'Stay in',
    });
    if (ok) await this.facade.withdraw();
  }
}
