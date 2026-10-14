import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { DashboardFacade } from '../../application/dashboard.facade';
import { Bay } from '../../shared/ui/bay';
import type { Cycle, HistoryEntry } from '../../domain/models';
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
  imports: [DatePipe, RouterLink, MatButtonModule, Bay, ViewStateHost, FairnessExplainer],
  template: `
    <!--
      The subject of this screen is a number, not a greeting. So the heading is small,
      top left, and states the period and whose board this is; the number underneath is
      the thing at display scale. "Your parking" stays as the page's accessible heading,
      because a screen reader does need a title even where the eye does not.
    -->
    <header class="head">
      <h1 class="sr-only">Your parking</h1>
      <p class="head__period">
        @if (facade.nextCycle(); as c) {
          {{ c.label }} &middot; closes {{ c.registrationClosesAt | date: 'd MMM' }}
        } @else {
          No period open
        }
      </p>
      @if (facade.resident(); as r) {
        <p class="head__who">{{ r.fullName }}, unit {{ r.unit }}</p>
      }
    </header>

    @if (facade.mutationError(); as err) {
      <div class="msg msg--bad" role="alert">
        {{ err.message }}
        <button matButton type="button" (click)="facade.dismissError()">Dismiss</button>
      </div>
    }

    <app-view-state
      [state]="facade.state()"
      [skeletonCount]="4"
      [busy]="facade.busy()"
      loadingLabel="Loading your parking"
      busyLabel="Updating your registration"
      emptyTitle="No parking activity yet"
      emptyBody="When the building opens registration for the next period, you can enter the draw from this page."
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
                  matButton="outlined"
                  class="on-steel"
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
              <!--
                The position is the number, so it is set as one. Prefixing it with the
                word "Position" halved it on screen to make room for a label the status
                marker and the caption were both already carrying.
              -->
              <app-bay
                variant="waiting"
                [code]="w.position.toString()"
                caption="Your position in the queue for this quarter."
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
                    matButton
                    class="on-steel"
                    type="button"
                    [disabled]="facade.busy()"
                    (click)="withdraw()"
                  >
                    Withdraw
                  </button>
                } @else if (facade.canRegister()) {
                  <button
                    matButton="filled"
                    class="go"
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

          <!--
            The entry for the coming period, for whoever the block above did not offer
            it to. Bays rotate: a resident holding one this period keeps it only by
            entering the next draw like everyone else, and that screen state used to
            have no way to do it at all - the one person it mattered most to was the one
            person who could not see the button.
          -->
          @if (facade.registrationOpen() && facade.situation() !== 'registration-open') {
            <div class="enter">
              <p class="enter__p">
                @if (facade.registered()) {
                  You are entered for {{ c.label }}. Bays are reassigned from scratch, so
                  this entry is what keeps you in the order.
                } @else if (facade.canRegister()) {
                  Registration for {{ c.label }} is open. Every bay is reassigned, so an
                  entry is needed even if you hold one now.
                } @else {
                  You are not eligible for {{ c.label }}. Ask the building administration
                  to resolve it before registration closes.
                }
              </p>

              @if (facade.registered()) {
                <button
                  matButton
                  type="button"
                  [disabled]="facade.busy()"
                  (click)="withdraw()"
                >
                  Withdraw
                </button>
              } @else if (facade.canRegister()) {
                <button
                  matButton="filled"
                  type="button"
                  [disabled]="facade.busy()"
                  (click)="facade.register()"
                >
                  Enter the draw
                </button>
              }
            </div>
          }

          <ol class="timeline">
            @for (step of timeline(c); track step.what) {
              <li class="timeline__step" [class.timeline__step--done]="step.done">
                <span class="timeline__when">{{ step.when | date: 'd MMM' }}</span>
                <span class="timeline__what">{{ step.what }}</span>
              </li>
            }
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
            waiting time it was decided on.
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
                <!--
                  The key as it stood in that run, not a score: there is no score. A
                  run the resident sat out has no key at all, and says so.
                -->
                <span class="results__score">{{ keyAtDraw(h) }}</span>
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
        /* This screen's measure. The shell is full-bleed; pages own their width. */
        width: 100%;
        max-width: 68rem;
        margin: 0 auto;
        padding: var(--sp-6) var(--sp-5) var(--sp-8);
        display: flex;
        flex-direction: column;
        gap: var(--sp-6);
      }

      /* Small, factual, and out of the way of the number. */
      .head__period {
        font-size: var(--t-small);
        letter-spacing: 0.08em;
        color: var(--steel-soft);
      }
      .head__who {
        color: var(--steel-faint);
        font-size: var(--t-small);
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
      /* A line of text and its action, not a panel: the direction contract has no cards. */
      .enter {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: var(--sp-3);
        margin-bottom: var(--sp-4);
        padding-bottom: var(--sp-4);
        border-bottom: 1px solid var(--rule-soft);
      }
      .enter__p {
        margin: 0;
        max-width: 60ch;
        color: var(--ink-2);
      }

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

  /**
   * What a past run was decided on, from that run's stored row. Hours up to two days,
   * then days, so a long wait does not print as a four-digit number nobody reads.
   */
  keyAtDraw(h: HistoryEntry): string {
    if (h.effectiveWaitHours === null) return 'not in this draw';
    const hours = Math.round(h.effectiveWaitHours);
    const wait =
      Math.abs(hours) < 48
        ? `${hours} ${Math.abs(hours) === 1 ? 'hour' : 'hours'}`
        : `${Math.floor(hours / 24)} days`;
    const rank = h.finalRank === null ? '' : `, ranked ${h.finalRank}`;
    return `${wait} waited${rank}`;
  }

  bayType(t: string): string {
    return t === 'ACCESSIBLE' ? 'accessible bay' : t === 'EV' ? 'EV bay' : 'standard bay';
  }

  /**
   * The cycle timeline, with any unusable date left out rather than rendered.
   *
   * DatePipe throws on an Invalid Date, which takes the whole dashboard down with it.
   * A date arriving broken is a server problem — and one was, the dashboard payload was
   * omitting startsOn — but a resident should lose one line, not the page.
   */
  timeline(c: Cycle): { when: Date; what: string; done: boolean }[] {
    const steps: { when: Date; what: string }[] = [
      { when: c.registrationOpensAt, what: 'Registration opens' },
      { when: c.registrationClosesAt, what: 'Registration closes' },
      { when: c.startsOn, what: 'Quarter begins' },
    ];
    return steps
      .filter((s) => s.when instanceof Date && !Number.isNaN(s.when.getTime()))
      .map((s) => ({ ...s, done: s.when.getTime() <= Date.now() }));
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
        'until the next draw. It counts as a bay you have held, and your waiting time ' +
        'starts again from today.',
      confirmLabel: 'Release it',
      cancelLabel: 'Keep it',
      danger: true,
    });
    if (ok) await this.facade.releaseSpot();
  }

  async withdraw(): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Withdraw from the draw?',
      body:
        'Withdrawing counts as a bay you have held, and your waiting time starts again ' +
        'from today. You can enter again while registration is still open, but the count ' +
        'stays.',
      confirmLabel: 'Withdraw',
      cancelLabel: 'Stay in',
      danger: true,
    });
    if (ok) await this.facade.withdraw();
  }
}
