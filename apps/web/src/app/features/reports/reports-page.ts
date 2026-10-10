import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatTableModule } from '@angular/material/table';
import { ReportsFacade, type ReportKind } from '../../application/reports.facade';
import { ViewStateHost } from '../../shared/ui/view-state';
import { StatusPill } from '../../shared/ui/status-pill';

/** One row of a report, flattened to strings, which is what a CSV is. */
type Row = Readonly<Record<string, string>>;

/**
 * RFC 4180 quoting. Not optional here: a resident's name can contain a comma, a bay's
 * note can contain a quote, and either one silently shifts every later column in a
 * spreadsheet - a corruption nobody notices until the figures are already wrong.
 */
const csvCell = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

const toCsv = (columns: readonly string[], rows: readonly Row[]): string =>
  [columns, ...rows.map((r) => columns.map((c) => r[c] ?? ''))]
    .map((line) => line.map(csvCell).join(','))
    .join('\r\n');

/**
 * Reports.
 *
 * Four read-only lists, each on screen before it is downloaded. Showing it first is the
 * point: a report you cannot read until it is in a spreadsheet is a file you have to
 * trust, and this product's whole argument is that its numbers can be checked. The table
 * and the file are built from one definition of the columns, so the thing exported is
 * provably the thing that was read.
 */
@Component({
  selector: 'app-reports-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, MatTableModule, StatusPill, ViewStateHost],
  providers: [ReportsFacade],
  template: `
    <header class="head">
      <div>
        <h1 class="head__h">Reports</h1>
        <p class="head__p">
          What the building can show for itself: who is on the register, what it has to
          hand out, the periods it has run, and every draw it has committed.
        </p>
      </div>

      <button
        type="button"
        class="go"
        [disabled]="facade.rowCount() === 0"
        (click)="download()"
      >
        Download CSV
      </button>
    </header>

    <!--
      A row of choices, not tabs. The direction contract keeps tabs off, and these are
      four separate reports rather than four faces of one thing.
    -->
    <div class="pick" role="group" aria-label="Report">
      @for (r of reports; track r.kind) {
        <button
          type="button"
          [class.on]="facade.kind() === r.kind"
          [attr.aria-pressed]="facade.kind() === r.kind"
          (click)="facade.kind.set(r.kind)"
        >
          {{ r.label }}
        </button>
      }
    </div>

    <p class="count">
      {{ facade.rowCount() }} {{ facade.rowCount() === 1 ? 'row' : 'rows' }}
      &middot; {{ caption() }}
    </p>

    <app-view-state
      [state]="facade.state()"
      [skeletonCount]="6"
      [emptyTitle]="'Nothing to report yet'"
      [emptyBody]="emptyBody()"
      (retry)="facade.refresh()"
    >
      @switch (facade.kind()) {
        @case ('residents') {
          <table mat-table [dataSource]="facade.residents()">
            <ng-container matColumnDef="name">
              <th mat-header-cell *matHeaderCellDef>Name</th>
              <td mat-cell *matCellDef="let r" data-label="Name">{{ r.fullName }}</td>
            </ng-container>
            <ng-container matColumnDef="unit">
              <th mat-header-cell *matHeaderCellDef>Unit</th>
              <td mat-cell *matCellDef="let r" data-label="Unit">{{ r.unitNumber }}</td>
            </ng-container>
            <ng-container matColumnDef="email">
              <th mat-header-cell *matHeaderCellDef>Email</th>
              <td mat-cell *matCellDef="let r" data-label="Email" class="dim">{{ r.email }}</td>
            </ng-container>
            <ng-container matColumnDef="eligibility">
              <th mat-header-cell *matHeaderCellDef>Eligibility</th>
              <td mat-cell *matCellDef="let r" data-label="Eligibility">
                @if (r.isEligible) {
                  <app-status-pill label="Eligible" tone="held" />
                } @else {
                  <app-status-pill label="Not eligible" tone="revoked" />
                }
              </td>
            </ng-container>
            <ng-container matColumnDef="bay">
              <th mat-header-cell *matHeaderCellDef>Bay held</th>
              <td mat-cell *matCellDef="let r" data-label="Bay held">
                {{ r.currentSpotCode ?? dash }}
              </td>
            </ng-container>
            <tr mat-header-row *matHeaderRowDef="residentColumns"></tr>
            <tr mat-row *matRowDef="let row; columns: residentColumns"></tr>
          </table>
        }

        @case ('bays') {
          <table mat-table [dataSource]="facade.bays()">
            <ng-container matColumnDef="code">
              <th mat-header-cell *matHeaderCellDef>Bay</th>
              <td mat-cell *matCellDef="let b" data-label="Bay" class="code stencil">
                {{ b.spotCode }}
              </td>
            </ng-container>
            <ng-container matColumnDef="level">
              <th mat-header-cell *matHeaderCellDef>Level</th>
              <td mat-cell *matCellDef="let b" data-label="Level">{{ b.level }}</td>
            </ng-container>
            <ng-container matColumnDef="type">
              <th mat-header-cell *matHeaderCellDef>Type</th>
              <td mat-cell *matCellDef="let b" data-label="Type">{{ typeWord(b.type) }}</td>
            </ng-container>
            <ng-container matColumnDef="status">
              <th mat-header-cell *matHeaderCellDef>Status</th>
              <td mat-cell *matCellDef="let b" data-label="Status">
                @if (b.isActive) {
                  <app-status-pill label="In service" tone="held" />
                } @else {
                  <app-status-pill label="Out of service" tone="revoked" />
                }
              </td>
            </ng-container>
            <ng-container matColumnDef="notes">
              <th mat-header-cell *matHeaderCellDef>Notes</th>
              <td mat-cell *matCellDef="let b" data-label="Notes" class="dim">
                {{ b.notes ?? dash }}
              </td>
            </ng-container>
            <tr mat-header-row *matHeaderRowDef="bayColumns"></tr>
            <tr mat-row *matRowDef="let row; columns: bayColumns"></tr>
          </table>
        }

        @case ('periods') {
          <table mat-table [dataSource]="facade.periods()">
            <ng-container matColumnDef="label">
              <th mat-header-cell *matHeaderCellDef>Period</th>
              <td mat-cell *matCellDef="let c" data-label="Period" class="code stencil">
                {{ c.label }}
              </td>
            </ng-container>
            <ng-container matColumnDef="state">
              <th mat-header-cell *matHeaderCellDef>Status</th>
              <td mat-cell *matCellDef="let c" data-label="Status">{{ stateWord(c.state) }}</td>
            </ng-container>
            <ng-container matColumnDef="runs">
              <th mat-header-cell *matHeaderCellDef>Runs</th>
              <td mat-cell *matCellDef="let c" data-label="Runs">
                {{ c.startsOn | date: 'd MMM y' }} to {{ c.endsOn | date: 'd MMM y' }}
              </td>
            </ng-container>
            <ng-container matColumnDef="registration">
              <th mat-header-cell *matHeaderCellDef>Registration</th>
              <td mat-cell *matCellDef="let c" data-label="Registration" class="dim">
                {{ c.registrationOpensAt | date: 'd MMM y' }} to
                {{ c.registrationClosesAt | date: 'd MMM y' }}
              </td>
            </ng-container>
            <tr mat-header-row *matHeaderRowDef="periodColumns"></tr>
            <tr mat-row *matRowDef="let row; columns: periodColumns"></tr>
          </table>
        }

        @case ('draws') {
          <table mat-table [dataSource]="facade.draws()">
            <ng-container matColumnDef="period">
              <th mat-header-cell *matHeaderCellDef>Period</th>
              <td mat-cell *matCellDef="let d" data-label="Period" class="code stencil">
                {{ d.cycleLabel ?? dash }}
              </td>
            </ng-container>
            <ng-container matColumnDef="decided">
              <th mat-header-cell *matHeaderCellDef>Decided</th>
              <td mat-cell *matCellDef="let d" data-label="Decided">
                {{ d.decidedAt ? (d.decidedAt | date: 'd MMM y, HH:mm') : dash }}
              </td>
            </ng-container>
            <ng-container matColumnDef="counts">
              <th mat-header-cell *matHeaderCellDef>Result</th>
              <td mat-cell *matCellDef="let d" data-label="Result">
                {{ d.assigned ?? dash }} of {{ d.spots ?? dash }} bays,
                {{ d.entrants ?? dash }} entrants
              </td>
            </ng-container>
            <!--
              The seed is in the report on purpose: it is the artefact that makes a past
              result checkable, and a draws report without it is a claim rather than a
              record.
            -->
            <ng-container matColumnDef="seed">
              <th mat-header-cell *matHeaderCellDef>Seed</th>
              <td mat-cell *matCellDef="let d" data-label="Seed" class="dim seed">
                {{ shortSeed(d.randomSeedHex) }}
              </td>
            </ng-container>
            <tr mat-header-row *matHeaderRowDef="drawColumns"></tr>
            <tr mat-row *matRowDef="let row; columns: drawColumns"></tr>
          </table>
        }
      }
    </app-view-state>
  `,
  styles: [
    `
      :host {
        width: 100%;
        max-width: 88rem;
        margin: 0 auto;
        padding: var(--sp-6) var(--sp-5) var(--sp-8);
        display: flex;
        flex-direction: column;
        gap: var(--sp-4);
      }

      .head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--sp-5);
        flex-wrap: wrap;
      }
      .head__h {
        margin: 0;
        font-size: var(--t-head);
      }
      .head__p {
        margin: var(--sp-2) 0 0;
        color: var(--steel-soft);
        max-width: 58ch;
      }

      .go {
        font: inherit;
        font-size: var(--t-small);
        font-weight: 600;
        min-height: 2.75rem;
        padding: 0 var(--sp-5);
        border: 0;
        border-radius: 3px;
        background: var(--signal);
        color: var(--on-primary);
        cursor: pointer;
      }
      .go:disabled {
        opacity: 0.5;
        cursor: default;
      }

      .pick {
        display: flex;
        gap: 2px;
        flex-wrap: wrap;
      }
      .pick button {
        font: inherit;
        font-size: var(--t-small);
        min-height: 2.5rem;
        padding: 0 var(--sp-4);
        border: 1px solid var(--rule);
        border-radius: 3px;
        background: transparent;
        color: var(--steel-soft);
        cursor: pointer;
      }
      .pick button.on {
        background: var(--signal);
        border-color: var(--signal);
        color: var(--on-primary);
      }
      @media (hover: hover) and (pointer: fine) {
        .pick button:not(.on):hover {
          border-color: var(--steel-faint);
          color: var(--steel);
        }
      }

      .count {
        margin: 0;
        font-size: var(--t-small);
        color: var(--steel-faint);
        font-variant-numeric: tabular-nums;
      }

      .dim {
        color: var(--steel-faint);
      }
      .seed {
        font-size: var(--t-fine);
        word-break: break-all;
      }
    `,
  ],
})
export default class ReportsPage {
  readonly facade = inject(ReportsFacade);

  readonly dash = '—';

  readonly reports: { kind: ReportKind; label: string }[] = [
    { kind: 'residents', label: 'Residents' },
    { kind: 'bays', label: 'Bays' },
    { kind: 'periods', label: 'Periods' },
    { kind: 'draws', label: 'Draws' },
  ];

  readonly residentColumns = ['name', 'unit', 'email', 'eligibility', 'bay'];
  readonly bayColumns = ['code', 'level', 'type', 'status', 'notes'];
  readonly periodColumns = ['label', 'state', 'runs', 'registration'];
  readonly drawColumns = ['period', 'decided', 'counts', 'seed'];

  readonly caption = computed(() => {
    switch (this.facade.kind()) {
      case 'residents':
        return 'everyone on the register, and the bay they hold';
      case 'bays':
        return 'the whole inventory, in service or not';
      case 'periods':
        return 'every period and its registration window';
      case 'draws':
        return 'every committed draw, with the seed that made it checkable';
    }
  });

  readonly emptyBody = computed(() => {
    switch (this.facade.kind()) {
      case 'residents':
        return 'Add the first resident on Residents, and they appear here.';
      case 'bays':
        return 'Add the first bay on Bays, and the inventory appears here.';
      case 'periods':
        return 'Create the first period on Periods, and it appears here.';
      case 'draws':
        return 'Run the first draw, and the record of it appears here.';
    }
  });

  typeWord(t: string): string {
    return t === 'ACCESSIBLE' ? 'Accessible' : t === 'EV' ? 'EV' : 'Standard';
  }

  stateWord(s: string): string {
    switch (s) {
      case 'DRAFT':
        return 'Draft';
      case 'REGISTRATION_OPEN':
        return 'Registration open';
      case 'REGISTRATION_CLOSED':
        return 'Registration closed';
      case 'ACTIVE':
        return 'In effect';
      default:
        return 'Closed';
    }
  }

  /** The head of the seed, enough to recognise a run by. The file carries all of it. */
  shortSeed(hex: string | null): string {
    if (!hex) return this.dash;
    return hex.length > 16 ? `${hex.slice(0, 16)}...` : hex;
  }

  // ------------------------------------------------------------------ the file

  /**
   * The same columns the table shows, in the same order.
   *
   * Built from the rendered values rather than from the raw records, so what lands in a
   * spreadsheet is what was on screen - a report that exports different numbers from the
   * ones it displayed is worse than no report.
   */
  private sheet(): { name: string; columns: string[]; rows: Row[] } {
    const iso = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : '');

    switch (this.facade.kind()) {
      case 'residents':
        return {
          name: 'residents',
          columns: ['Name', 'Unit', 'Email', 'Eligibility', 'Reason', 'Bay held'],
          rows: this.facade.residents().map((r) => ({
            Name: r.fullName,
            Unit: r.unitNumber,
            Email: r.email,
            Eligibility: r.isEligible ? 'Eligible' : 'Not eligible',
            Reason: r.ineligibleReason ?? '',
            'Bay held': r.currentSpotCode ?? '',
          })),
        };
      case 'bays':
        return {
          name: 'bays',
          columns: ['Bay', 'Level', 'Type', 'Status', 'Notes'],
          rows: this.facade.bays().map((b) => ({
            Bay: b.spotCode,
            Level: b.level,
            Type: this.typeWord(b.type),
            Status: b.isActive ? 'In service' : 'Out of service',
            Notes: b.notes ?? '',
          })),
        };
      case 'periods':
        return {
          name: 'periods',
          columns: ['Period', 'Status', 'Begins', 'Ends', 'Registration opens', 'Registration closes'],
          rows: this.facade.periods().map((c) => ({
            Period: c.label,
            Status: this.stateWord(c.state),
            Begins: iso(c.startsOn),
            Ends: iso(c.endsOn),
            'Registration opens': iso(c.registrationOpensAt),
            'Registration closes': iso(c.registrationClosesAt),
          })),
        };
      case 'draws':
        return {
          name: 'draws',
          columns: ['Period', 'Decided', 'Entrants', 'Bays offered', 'Assigned', 'Seed', 'Run'],
          rows: this.facade.draws().map((d) => ({
            Period: d.cycleLabel ?? '',
            Decided: d.decidedAt ? d.decidedAt.toISOString() : '',
            Entrants: String(d.entrants ?? ''),
            'Bays offered': String(d.spots ?? ''),
            Assigned: String(d.assigned ?? ''),
            // The whole seed, not the shortened one: the file is the auditable artefact.
            Seed: d.randomSeedHex,
            Run: d.runId,
          })),
        };
    }
  }

  download(): void {
    const { name, columns, rows } = this.sheet();
    if (rows.length === 0) return;

    // A BOM, because Excel reads a CSV without one as the system codepage and turns an
    // accented name into mojibake - which is the commonest way a correct export is
    // reported as a bug.
    const blob = new Blob([`﻿${toCsv(columns, rows)}`], {
      type: 'text/csv;charset=utf-8',
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pacs-${name}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
