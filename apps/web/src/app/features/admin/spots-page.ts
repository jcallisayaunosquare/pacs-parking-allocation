import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { MatSortModule, type Sort } from '@angular/material/sort';
import { MatTableModule } from '@angular/material/table';
import { SpotsFacade } from '../../application/admin.facades';
import type { ParkingSpot, SpotType } from '../../domain/models';
import { StatusPill } from '../../shared/ui/status-pill';
import { ViewStateHost } from '../../shared/ui/view-state';
import { AddBayDialog, EditBayDialog } from './spots-dialogs';

/**
 * Admin — the bay inventory (FR-16, §17).
 *
 * Taking a bay out of service is refused by the server with a 409 while it is assigned
 * for the current quarter, because removing a bay from under someone parked in it is an
 * operational problem rather than a data one. The control stays visible and the refusal
 * is shown, instead of hiding the button and leaving the administrator guessing.
 */
@Component({
  selector: 'app-spots-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatMenuModule,
    MatSelectModule,
    MatSortModule,
    MatTableModule,
    StatusPill,
    ViewStateHost,
  ],
  template: `
    <header class="head">
      <div>
        <h1 class="head__h">Bays</h1>
        <p class="head__p">What the draw has to hand out.</p>
      </div>
      <button matButton="filled" type="button" (click)="openCreate()">Add bay</button>
    </header>

    @if (facade.counts(); as c) {
      <div class="tally">
        <div class="tally__item">
          <span class="tally__n stencil">{{ c.active }}</span>
          <span class="tally__l">in service</span>
        </div>
        <div class="tally__item">
          <span class="tally__n stencil">{{ c.total - c.active }}</span>
          <span class="tally__l">out of service</span>
        </div>
        <div class="tally__item">
          <span class="tally__n stencil">{{ c.accessible }}</span>
          <span class="tally__l">accessible</span>
        </div>
        <div class="tally__item">
          <span class="tally__n stencil">{{ c.ev }}</span>
          <span class="tally__l">EV</span>
        </div>
      </div>
    }

    <div class="filters">
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Type</mat-label>
        <mat-select
          [ngModel]="facade.type() ?? ''"
          (ngModelChange)="facade.type.set($event || undefined)"
        >
          <mat-option value="">Any type</mat-option>
          @for (o of typeOptions; track o.value) {
            <mat-option [value]="o.value">{{ o.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <mat-checkbox
        [ngModel]="facade.activeOnly()"
        (ngModelChange)="facade.activeOnly.set($event)"
      >
        In service only
      </mat-checkbox>
    </div>

    @if (facade.error(); as e) {
      <div class="msg msg--bad" role="alert">{{ e.message }}</div>
    }

    <app-view-state
      [state]="facade.state()"
      [skeletonCount]="6"
      emptyTitle="No bays in the inventory"
      emptyBody="A draw needs at least one bay in service. Add the first one before opening a cycle."
      emptyActionLabel="Add bay"
      (action)="openCreate()"
      (retry)="facade.refresh()"
    >
      <!--
        Sorting is client-side here, unlike the resident register: the whole inventory
        arrives in one response, so sorting it on the server would be a round trip to
        reorder a list the browser already holds.
      -->
      <table
        mat-table
        [dataSource]="rows()"
        matSort
        matSortDisableClear
        (matSortChange)="sort.set($event)"
      >
        <ng-container matColumnDef="code">
          <th mat-header-cell *matHeaderCellDef mat-sort-header>Bay</th>
          <td mat-cell *matCellDef="let s" data-label="Bay" class="code stencil">
            {{ s.spotCode }}
          </td>
        </ng-container>

        <ng-container matColumnDef="level">
          <th mat-header-cell *matHeaderCellDef mat-sort-header>Level</th>
          <td mat-cell *matCellDef="let s" data-label="Level">{{ s.level }}</td>
        </ng-container>

        <ng-container matColumnDef="type">
          <th mat-header-cell *matHeaderCellDef mat-sort-header>Type</th>
          <td mat-cell *matCellDef="let s" data-label="Type">
            @switch (s.type) {
              @case ('ACCESSIBLE') {
                <app-status-pill label="Accessible" tone="attention" />
              }
              @case ('EV') {
                <app-status-pill label="EV" tone="waiting" />
              }
              @default {
                <span class="dim">Standard</span>
              }
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="status">
          <th mat-header-cell *matHeaderCellDef mat-sort-header>Status</th>
          <td mat-cell *matCellDef="let s" data-label="Status">
            @if (s.isActive) {
              <app-status-pill label="In service" tone="held" />
            } @else {
              <app-status-pill label="Out of service" tone="revoked" />
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="notes">
          <th mat-header-cell *matHeaderCellDef>Notes</th>
          <td mat-cell *matCellDef="let s" data-label="Notes" class="dim">{{ s.notes || '—' }}</td>
        </ng-container>

        <!--
          One trigger per row rather than a button whose label changes with the row's
          state. A column of "Take out of service" / "Put back in service" set the row's
          width from its longest verb and read as the table's loudest element, which a
          maintenance action is not. The menu also leaves room for Edit without adding a
          second column.
        -->
        <ng-container matColumnDef="actions">
          <th mat-header-cell *matHeaderCellDef><span class="sr-only">Actions</span></th>
          <td mat-cell *matCellDef="let s">
            <button
              matIconButton
              type="button"
              [disabled]="facade.busy()"
              [matMenuTriggerFor]="rowMenu"
              [attr.aria-label]="'Actions for bay ' + s.spotCode"
            >
              <mat-icon>more_vert</mat-icon>
            </button>
            <mat-menu #rowMenu="matMenu">
              <button mat-menu-item type="button" (click)="openEdit(s)">Edit</button>
              <button mat-menu-item type="button" (click)="toggle(s)">
                {{ s.isActive ? 'Take out of service' : 'Put back in service' }}
              </button>
            </mat-menu>
          </td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="columns"></tr>
        <tr mat-row *matRowDef="let row; columns: columns" [class.row--out]="!row.isActive"></tr>
      </table>
    </app-view-state>
  `,
  styles: [
    `
      :host {
        /* This screen's measure. The shell is full-bleed; pages own their width. */
        width: 100%;
        max-width: 88rem;
        margin: 0 auto;
        padding: var(--sp-6) var(--sp-5) var(--sp-8);
        /* A register needs columns, not a reading measure. */        display: flex;
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
        font-size: var(--t-head);
      }
      .head__p {
        color: var(--steel-soft);
        margin-top: var(--sp-1);
      }

      .tally {
        display: flex;
        gap: var(--sp-7);
        flex-wrap: wrap;
      }
      .tally__item {
        display: flex;
        flex-direction: column;
        border-top: 3px solid var(--steel);
        padding-top: var(--sp-2);
        min-width: 7rem;
      }
      .tally__n {
        font-size: 2rem;
      }
      .tally__l {
        font-size: var(--t-fine);
        color: var(--steel-soft);
      }

      .filters {
        display: flex;
        gap: var(--sp-5);
        align-items: center;
        flex-wrap: wrap;
        border-bottom: 1px solid var(--rule);
        padding-bottom: var(--sp-4);
      }
      .filters mat-form-field {
        width: 13rem;
      }

      table {
        width: 100%;
      }
      .code {
        font-size: 1.05rem;
      }
      .row--out .code {
        color: var(--steel-faint);
        text-decoration: line-through;
      }
      .dim {
        color: var(--steel-faint);
      }

      @media (max-width: 40rem) {
        .head {
          flex-direction: column;
          align-items: stretch;
        }
        .tally {
          gap: var(--sp-5);
        }
        .filters mat-form-field {
          width: 100%;
        }
      }
    `,
  ],
})
export default class SpotsPage {
  readonly facade = inject(SpotsFacade);
  private readonly dialog = inject(MatDialog);

  readonly columns = ['code', 'level', 'type', 'status', 'notes', 'actions'];

  /** The column and direction the table is sorted by. Null is the server's own order. */
  readonly sort = signal<Sort | null>(null);

  /**
   * The inventory in the order the header asked for. Bay codes sort as text on purpose:
   * they are labels painted on concrete (B1-A07), not numbers, and a numeric sort would
   * put B1-A10 before B1-A2 on a floor that has both.
   */
  readonly rows = computed(() => {
    const all = [...this.facade.spots()];
    const s = this.sort();
    if (!s || !s.direction) return all;

    const key = (b: ParkingSpot): string => {
      switch (s.active) {
        case 'level':
          return b.level;
        case 'type':
          return b.type;
        case 'status':
          return b.isActive ? 'in service' : 'out of service';
        default:
          return b.spotCode;
      }
    };

    const sign = s.direction === 'asc' ? 1 : -1;
    // Ties fall back to the code, so a sort by level or status is still stable to read.
    return all.sort(
      (a, b) =>
        sign * key(a).localeCompare(key(b)) || a.spotCode.localeCompare(b.spotCode),
    );
  });

  readonly typeOptions: { label: string; value: SpotType }[] = [
    { label: 'Standard', value: 'STANDARD' },
    { label: 'Accessible', value: 'ACCESSIBLE' },
    { label: 'EV', value: 'EV' },
  ];

  openCreate(): void {
    this.dialog.open(AddBayDialog, { width: '32rem', maxWidth: 'calc(100vw - 2rem)' });
  }

  openEdit(s: ParkingSpot): void {
    this.dialog.open(EditBayDialog, {
      data: s,
      width: '30rem',
      maxWidth: 'calc(100vw - 2rem)',
    });
  }

  toggle(s: ParkingSpot): void {
    this.facade.dismissError();
    void this.facade.setActive(s, !s.isActive);
  }
}
