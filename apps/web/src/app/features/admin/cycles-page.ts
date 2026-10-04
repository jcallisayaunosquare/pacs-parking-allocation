import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CyclesFacade } from '../../application/admin.facades';
import type { Cycle, RunAssignment } from '../../domain/models';
import { ConfirmService } from '../../shared/ui/confirm';
import { Modal } from '../../shared/ui/modal';
import { StatusPill } from '../../shared/ui/status-pill';
import { ViewStateHost } from '../../shared/ui/view-state';

/**
 * Admin — cycles and draws (UC-04, UC-05, §17).
 *
 * The draw button is the most consequential control in the product, so it is guarded
 * three ways: it appears only for the one cycle in REGISTRATION_CLOSED, which is the
 * only state a draw may start from (§11); it goes through a confirmation; and the
 * request carries an idempotency key, so a double click replays the first draw rather
 * than running a second one.
 *
 * The seed is shown afterwards and set like a stamp, because it is the artefact that
 * makes the result checkable — an administrator who can quote it can answer "why did I
 * lose?" with something a neighbour can verify rather than a reassurance.
 */
@Component({
  selector: 'app-cycles-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, Modal, StatusPill, ViewStateHost],
  template: `
    <header class="head">
      <div>
        <h1 class="head__h">Cycles and draws</h1>
        <p class="head__p">One cycle per quarter: open registration, close it, run the draw.</p>
      </div>
      <button class="btn" type="button" (click)="openCreate()">New cycle</button>
    </header>

    @if (facade.error(); as e) {
      <div class="msg msg--bad" role="alert">{{ e.message }}</div>
    }

    @if (facade.runnable(); as c) {
      <section class="ready">
        <span class="ready__line" aria-hidden="true"></span>
        <div class="ready__body">
          <h2 class="ready__h">{{ c.label }} is ready to draw</h2>
          <p class="ready__p">
            Registration is closed. Running the draw assigns the bays, builds the
            waitlist and updates everyone's score. It cannot be undone.
          </p>
          <button
            class="btn btn--go"
            type="button"
            [disabled]="facade.busy()"
            (click)="runDraw(c)"
          >
            Run the draw
          </button>
        </div>
      </section>
    }

    @if (facade.lastRun(); as run) {
      <section class="record">
        <h2 class="sec__h">Last draw</h2>

        <div class="record__nums">
          <div>
            <span class="record__n stencil">{{ run.entrants }}</span>
            <span class="record__l">entered</span>
          </div>
          <div>
            <span class="record__n stencil">{{ run.assigned }}</span>
            <span class="record__l">got a bay</span>
          </div>
          <div>
            <span class="record__n stencil">{{ run.waitlisted }}</span>
            <span class="record__l">waitlisted</span>
          </div>
        </div>

        <dl class="seal">
          <div>
            <dt>Seed</dt>
            <dd><code>{{ run.randomSeed }}</code></dd>
          </div>
          <div>
            <dt>Algorithm</dt>
            <dd><code>{{ run.algorithmVersion }}</code></dd>
          </div>
          <div>
            <dt>Finished</dt>
            <dd>{{ run.finishedAt ? (run.finishedAt | date: 'd MMM y, HH:mm') : '—' }}</dd>
          </div>
        </dl>
        <p class="seal__p">
          The same seed and the same entrants always produce the same result. That is what
          makes this draw checkable rather than merely trusted.
        </p>

        <button
          class="btn btn--quiet btn--sm"
          type="button"
          (click)="loadAssignments(run.runId)"
        >
          Show who got what
        </button>

        @if (assignments().length > 0) {
          <div class="tbl__wrap">
            <table class="tbl">
              <thead>
                <tr>
                  <th scope="col">Resident</th>
                  <th scope="col">Bay</th>
                </tr>
              </thead>
              <tbody>
                @for (a of assignments(); track a.residentId) {
                  <tr>
                    <td data-label="Resident">{{ a.fullName }}</td>
                    <td class="code stencil" data-label="Bay">{{ a.spotCode }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    }

    <app-view-state
      [state]="facade.state()"
      [skeletonCount]="4"
      emptyTitle="No cycles yet"
      emptyBody="A cycle sets the quarter it covers, the registration window, and when the draw runs."
      emptyActionLabel="New cycle"
      (action)="openCreate()"
      (retry)="facade.refresh()"
    >
      <h2 class="sec__h">All cycles</h2>
      <div class="tbl__wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th scope="col">Cycle</th>
              <th scope="col">Status</th>
              <th scope="col">Quarter</th>
              <th scope="col">Registration</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            @for (c of facade.allCycles(); track c.id) {
              <tr>
                <td class="code stencil" data-label="Cycle">{{ c.label }}</td>
                <td data-label="Status">
                  @switch (c.state) {
                    @case ('DRAFT') {
                      <app-status-pill label="Draft" tone="idle" />
                    }
                    @case ('REGISTRATION_OPEN') {
                      <app-status-pill label="Registration open" tone="held" />
                    }
                    @case ('REGISTRATION_CLOSED') {
                      <app-status-pill label="Ready to draw" tone="attention" />
                    }
                    @case ('ACTIVE') {
                      <app-status-pill label="In effect" tone="held" />
                    }
                    @default {
                      <app-status-pill label="Closed" tone="idle" />
                    }
                  }
                </td>
                <td data-label="Quarter">
                  {{ c.startsOn | date: 'd MMM y' }} to {{ c.endsOn | date: 'd MMM y' }}
                </td>
                <td class="dim" data-label="Registration">
                  {{ c.registrationOpensAt | date: 'd MMM' }} to
                  {{ c.registrationClosesAt | date: 'd MMM' }}
                </td>
                <td>
                  @switch (c.state) {
                    @case ('DRAFT') {
                      <button
                        class="btn btn--bare"
                        type="button"
                        [disabled]="facade.busy()"
                        (click)="facade.openRegistration(c.id)"
                      >
                        Open registration
                      </button>
                    }
                    @case ('REGISTRATION_OPEN') {
                      <button
                        class="btn btn--bare"
                        type="button"
                        [disabled]="facade.busy()"
                        (click)="facade.closeRegistration(c.id)"
                      >
                        Close registration
                      </button>
                    }
                    @default {
                      <span class="dim">—</span>
                    }
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </app-view-state>

    <app-modal [open]="createOpen()" title="New cycle" (closed)="createOpen.set(false)">
      <div class="dates">
        <div class="field">
          <label class="field__label" for="nc-start">Quarter begins</label>
          <input class="input" id="nc-start" type="date" [(ngModel)]="form.startsOn" />
        </div>
        <div class="field">
          <label class="field__label" for="nc-end">Quarter ends</label>
          <input class="input" id="nc-end" type="date" [(ngModel)]="form.endsOn" />
        </div>
        <div class="field">
          <label class="field__label" for="nc-open">Registration opens</label>
          <input class="input" id="nc-open" type="date" [(ngModel)]="form.opensAt" />
        </div>
        <div class="field">
          <label class="field__label" for="nc-close">Registration closes</label>
          <input class="input" id="nc-close" type="date" [(ngModel)]="form.closesAt" />
        </div>
      </div>
      <p class="field__hint">
        The label, such as 2026-Q2, comes from the start date, so two administrators
        cannot spell it differently.
      </p>

      <div modalFoot>
        <button class="btn btn--quiet" type="button" (click)="createOpen.set(false)">Cancel</button>
        <button
          class="btn"
          type="button"
          [disabled]="!canSubmit() || facade.busy()"
          (click)="submitCreate()"
        >
          Create cycle
        </button>
      </div>
    </app-modal>
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
        margin-bottom: var(--sp-3);
      }

      /* The one thing on this page that should stop an administrator's eye. */
      .ready {
        display: flex;
        background: var(--steel);
        color: var(--stencil);
      }
      .ready__line {
        flex: 0 0 10px;
        background: var(--bay-line);
      }
      .ready__body {
        padding: var(--sp-5);
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: var(--sp-3);
      }
      .ready__h {
        font-size: var(--t-title);
      }
      .ready__p {
        color: #c3cbd6;
        max-width: 60ch;
      }

      .record {
        border-top: 2px solid var(--steel);
        padding-top: var(--sp-4);
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: var(--sp-4);
      }
      .record__nums {
        display: flex;
        gap: var(--sp-7);
        flex-wrap: wrap;
      }
      .record__nums > div {
        display: flex;
        flex-direction: column;
      }
      .record__n {
        font-size: 2.25rem;
      }
      .record__l {
        font-size: var(--t-fine);
        color: var(--steel-soft);
      }

      /* The audit record, set like a stamp rather than a statistic. */
      .seal {
        display: flex;
        gap: var(--sp-6);
        flex-wrap: wrap;
        margin: 0;
        padding: var(--sp-3) var(--sp-4);
        background: var(--concrete-deep);
        border-left: 3px solid var(--steel);
      }
      .seal dt {
        font-size: var(--t-fine);
        color: var(--steel-faint);
      }
      .seal dd {
        margin: 2px 0 0;
      }
      .seal code {
        user-select: all;
        font-size: var(--t-small);
      }
      .seal__p {
        font-size: var(--t-fine);
        color: var(--steel-soft);
        max-width: 64ch;
      }

      .code {
        font-size: 1.05rem;
      }
      .dim {
        color: var(--steel-faint);
      }

      .dates {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--sp-3);
      }

      @media (max-width: 40rem) {
        .head {
          flex-direction: column;
          align-items: stretch;
        }
        .record__nums,
        .seal {
          gap: var(--sp-5);
        }
      }
      @media (max-width: 26rem) {
        .dates {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export default class CyclesPage {
  readonly facade = inject(CyclesFacade);
  private readonly confirm = inject(ConfirmService);

  readonly assignments = signal<RunAssignment[]>([]);
  readonly createOpen = signal(false);

  /** Native date inputs speak `yyyy-MM-dd` strings, which is also what the API wants. */
  form = { startsOn: '', endsOn: '', opensAt: '', closesAt: '' };

  canSubmit(): boolean {
    const f = this.form;
    return Boolean(f.startsOn && f.endsOn && f.opensAt && f.closesAt);
  }

  openCreate(): void {
    this.form = { startsOn: '', endsOn: '', opensAt: '', closesAt: '' };
    this.facade.dismissError();
    this.createOpen.set(true);
  }

  async submitCreate(): Promise<void> {
    const f = this.form;
    if (!this.canSubmit()) return;
    const r = await this.facade.create({
      startsOn: f.startsOn,
      endsOn: f.endsOn,
      // The window is a timestamp in the contract; midnight UTC on the chosen day.
      registrationOpensAt: new Date(`${f.opensAt}T00:00:00Z`).toISOString(),
      registrationClosesAt: new Date(`${f.closesAt}T23:59:59Z`).toISOString(),
    });
    if (r) this.createOpen.set(false);
  }

  async runDraw(c: Cycle): Promise<void> {
    const ok = await this.confirm.ask({
      title: `Run the draw for ${c.label}?`,
      body:
        'Bays are assigned, the waitlist is built, and every score is updated. This ' +
        'cannot be undone, and it is recorded in the audit history.',
      confirmLabel: 'Run the draw',
      cancelLabel: 'Not yet',
    });
    if (!ok) return;

    this.assignments.set([]);
    await this.facade.executeRun(c.id);
    const run = this.facade.lastRun();
    if (run) await this.loadAssignments(run.runId);
  }

  async loadAssignments(runId: string): Promise<void> {
    this.assignments.set([...(await this.facade.assignmentsOf(runId))]);
  }
}
