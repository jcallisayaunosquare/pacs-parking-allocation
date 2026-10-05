import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatTableModule } from '@angular/material/table';
import { CyclesFacade } from '../../application/admin.facades';
import type { Cycle, RunAssignment } from '../../domain/models';
import { ConfirmService } from '../../shared/ui/confirm';
import { StatusPill } from '../../shared/ui/status-pill';
import { ViewStateHost } from '../../shared/ui/view-state';
import { NewCycleDialog } from './cycles-dialogs';

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
  imports: [DatePipe, MatButtonModule, MatTableModule, StatusPill, ViewStateHost],
  template: `
    <header class="head">
      <div>
        <h1 class="head__h">Cycles and draws</h1>
        <p class="head__p">One cycle per quarter: open registration, close it, run the draw.</p>
      </div>
      <button matButton="filled" type="button" (click)="openCreate()">New cycle</button>
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
          <button matButton="filled" class="go" type="button" [disabled]="facade.busy()" (click)="runDraw(c)">
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

        <button matButton="outlined" type="button" (click)="loadAssignments(run.runId)">
          Show who got what
        </button>

        @if (assignments().length > 0) {
          <table mat-table [dataSource]="assignments()">
            <ng-container matColumnDef="resident">
              <th mat-header-cell *matHeaderCellDef>Resident</th>
              <td mat-cell *matCellDef="let a" data-label="Resident">{{ a.fullName }}</td>
            </ng-container>

            <ng-container matColumnDef="bay">
              <th mat-header-cell *matHeaderCellDef>Bay</th>
              <td mat-cell *matCellDef="let a" data-label="Bay" class="code stencil">
                {{ a.spotCode }}
              </td>
            </ng-container>

            <tr mat-header-row *matHeaderRowDef="assignmentColumns"></tr>
            <tr mat-row *matRowDef="let row; columns: assignmentColumns"></tr>
          </table>
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
      <table mat-table [dataSource]="facade.allCycles()">
        <ng-container matColumnDef="label">
          <th mat-header-cell *matHeaderCellDef>Cycle</th>
          <td mat-cell *matCellDef="let c" data-label="Cycle" class="code stencil">
            {{ c.label }}
          </td>
        </ng-container>

        <ng-container matColumnDef="status">
          <th mat-header-cell *matHeaderCellDef>Status</th>
          <td mat-cell *matCellDef="let c" data-label="Status">
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
        </ng-container>

        <ng-container matColumnDef="quarter">
          <th mat-header-cell *matHeaderCellDef>Quarter</th>
          <td mat-cell *matCellDef="let c" data-label="Quarter">
            {{ c.startsOn | date: 'd MMM y' }} to {{ c.endsOn | date: 'd MMM y' }}
          </td>
        </ng-container>

        <ng-container matColumnDef="registration">
          <th mat-header-cell *matHeaderCellDef>Registration</th>
          <td mat-cell *matCellDef="let c" data-label="Registration" class="dim">
            {{ c.registrationOpensAt | date: 'd MMM' }} to
            {{ c.registrationClosesAt | date: 'd MMM' }}
          </td>
        </ng-container>

        <ng-container matColumnDef="actions">
          <th mat-header-cell *matHeaderCellDef><span class="sr-only">Actions</span></th>
          <td mat-cell *matCellDef="let c">
            @switch (c.state) {
              @case ('DRAFT') {
                <button
                  matButton
                  type="button"
                  [disabled]="facade.busy()"
                  (click)="facade.openRegistration(c.id)"
                >
                  Open registration
                </button>
              }
              @case ('REGISTRATION_OPEN') {
                <button
                  matButton
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
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="columns"></tr>
        <tr mat-row *matRowDef="let row; columns: columns"></tr>
      </table>
    </app-view-state>

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

      table {
        width: 100%;
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
    `,
  ],
})
export default class CyclesPage {
  readonly facade = inject(CyclesFacade);
  private readonly confirm = inject(ConfirmService);
  private readonly dialog = inject(MatDialog);

  readonly assignments = signal<RunAssignment[]>([]);

  readonly columns = ['label', 'status', 'quarter', 'registration', 'actions'];
  readonly assignmentColumns = ['resident', 'bay'];

  openCreate(): void {
    this.dialog.open(NewCycleDialog, { width: '34rem', maxWidth: 'calc(100vw - 2rem)' });
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
