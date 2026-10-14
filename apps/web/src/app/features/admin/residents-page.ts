import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { ConfirmService } from '../../shared/ui/confirm';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSortModule, type Sort } from '@angular/material/sort';
import { MatTableModule } from '@angular/material/table';
import { MatMenuModule } from '@angular/material/menu';
import { MatIconModule } from '@angular/material/icon';
import { ResidentsFacade } from '../../application/admin.facades';
import type { Resident } from '../../domain/models';
import type { ResidentSortField } from '../../domain/repositories';
import { Pager } from '../../shared/ui/pager';
import { StatusPill } from '../../shared/ui/status-pill';
import { ViewStateHost } from '../../shared/ui/view-state';
import {
  AddResidentDialog,
  EditResidentDialog,
  EligibilityDialog,
  VehiclesDialog,
} from './residents-dialogs';
import { toastFacadeErrors } from '../../shared/ui/toast';

/**
 * Admin — the resident register. Sort, filter, page, edit, set eligibility (§17).
 *
 * Sorting and paging are server concerns here. `MatSort` and the shared pager are driven
 * from the facade rather than from a `MatTableDataSource`, because the client only ever
 * holds one page: sorting the fifteen rows in the browser would reorder fifteen rows out
 * of however many exist and call the list sorted.
 *
 * Eligibility is the sharp edge: FR-15 requires a reason, the change is audit-logged,
 * and it decides who the next draw even considers. So it gets a dialog with a mandatory
 * reason rather than an inline toggle that can be flipped by a stray click.
 */
@Component({
  selector: 'app-residents-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSortModule,
    MatTableModule,
    MatMenuModule,
    MatIconModule,
    StatusPill,
    ViewStateHost,
    Pager,
  ],
  template: `
    <header class="head">
      <div>
        <h1 class="head__h">Residents</h1>
        <p class="head__p">Who may enter the draw, and on what terms.</p>
      </div>
      <button matButton="filled" type="button" (click)="openCreate()">Add resident</button>
    </header>

    <div class="filters">
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Filter by unit</mat-label>
        <input
          matInput
          type="search"
          [ngModel]="facade.unit() ?? ''"
          (ngModelChange)="facade.setUnit($event || undefined)"
        />
      </mat-form-field>

      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Eligibility</mat-label>
        <mat-select [ngModel]="eligibleFilter()" (ngModelChange)="setEligibleFilter($event)">
          <mat-option value="">Any eligibility</mat-option>
          <mat-option value="yes">Eligible</mat-option>
          <mat-option value="no">Not eligible</mat-option>
        </mat-select>
      </mat-form-field>

      <button matButton type="button" (click)="facade.resetFilters()">Clear</button>
    </div>

    <app-view-state
      [state]="facade.state()"
      [skeletonCount]="6"
      [busy]="facade.busy()"
      loadingLabel="Loading residents"
      busyLabel="Saving the register"
      emptyTitle="No residents match"
      emptyBody="Clear the filters, or add the building's first resident to get started."
      emptyActionLabel="Add resident"
      (action)="openCreate()"
      (retry)="facade.refresh()"
    >
      <table
        mat-table
        [dataSource]="rows()"
        matSort
        matSortDisableClear
        [matSortActive]="facade.sort()"
        [matSortDirection]="facade.dir()"
        (matSortChange)="onSort($event)"
      >
        <!--
          The row number. It is a position in the list and nothing else - it keeps
          counting across pages through the facade's offset, and sorting or filtering
          renumbers it, which is what a reader of a sorted list expects. The header is
          hidden from screen readers rather than labelled, because "1" through "15" read
          aloud in front of every name is noise to someone who cannot see the column.
        -->
        <ng-container matColumnDef="num">
          <th mat-header-cell *matHeaderCellDef class="col-index" aria-hidden="true">#</th>
          <td mat-cell *matCellDef="let r; let i = index" class="col-index" aria-hidden="true">
            {{ facade.rowOffset() + i + 1 }}
          </td>
        </ng-container>

        <ng-container matColumnDef="name">
          <th mat-header-cell *matHeaderCellDef mat-sort-header>Name</th>
          <td mat-cell *matCellDef="let r" data-label="Name" class="name">{{ r.fullName }}</td>
        </ng-container>

        <ng-container matColumnDef="unit">
          <th mat-header-cell *matHeaderCellDef mat-sort-header>Unit</th>
          <td mat-cell *matCellDef="let r" data-label="Unit" class="unit">{{ r.unitNumber }}</td>
        </ng-container>

        <ng-container matColumnDef="email">
          <th mat-header-cell *matHeaderCellDef mat-sort-header>Email</th>
          <td mat-cell *matCellDef="let r" data-label="Email" class="dim">{{ r.email }}</td>
        </ng-container>

        <ng-container matColumnDef="eligibility">
          <th mat-header-cell *matHeaderCellDef mat-sort-header>Eligibility</th>
          <td mat-cell *matCellDef="let r" data-label="Eligibility">
            <!--
              No case for an administrator here: GET /residents does not return them.
              This is the register of the people the allocation is for, and the account
              that operates the raffle is not one of them - a row with a pill explaining
              that was still a row.
            -->
            @if (r.isEligible) {
              <app-status-pill label="Eligible" tone="held" />
            } @else {
              <app-status-pill label="Not eligible" tone="revoked" />
              @if (r.ineligibleReason) {
                <span class="reason">{{ r.ineligibleReason }}</span>
              }
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="accessible">
          <th mat-header-cell *matHeaderCellDef>Accessible bay</th>
          <td mat-cell *matCellDef="let r" data-label="Accessible bay">
            @if (r.needsAccessibleSpot) {
              <app-status-pill label="Required" tone="attention" />
            } @else {
              <span class="dim">No</span>
            }
          </td>
        </ng-container>

        <!--
          The bay a resident holds right now. It earns a column because it is the one
          fact that blocks a removal, and an administrator scanning the register for
          someone to take off it should see the blocker in the row rather than meet it
          in a dialog.
        -->
        <ng-container matColumnDef="bay">
          <th mat-header-cell *matHeaderCellDef>Bay held</th>
          <td mat-cell *matCellDef="let r" data-label="Bay held">
            @if (r.currentSpotCode) {
              <span class="code stencil">{{ r.currentSpotCode }}</span>
            } @else {
              <span class="dim">{{ dash }}</span>
            }
          </td>
        </ng-container>

        <!--
          The cars this resident may bring in, by the plate as it is painted - the string
          the gate reads against. The full record (make, model, colour) is one click away
          in Vehicles; the register only needs to say whether there is a car and which.
        -->
        <ng-container matColumnDef="vehicles">
          <th mat-header-cell *matHeaderCellDef>Vehicles</th>
          <td mat-cell *matCellDef="let r" data-label="Vehicles">
            @if (facade.vehiclesByResident(); as fleet) {
              @let cars = fleet.get(r.id) ?? [];
              @if (cars.length > 0) {
                <span class="plates">
                  @for (v of cars; track v.id) {
                    <span class="code plate">{{ v.plateDisplay }}</span>
                  }
                </span>
              } @else {
                <button type="button" class="add-car" (click)="openVehicles(r)">
                  Add a vehicle
                </button>
              }
            } @else {
              <span class="dim">Loading…</span>
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="signin">
          <th mat-header-cell *matHeaderCellDef>Sign-in</th>
          <td mat-cell *matCellDef="let r" data-label="Sign-in">
            @if (r.externalSubject) {
              <app-status-pill label="Linked" tone="held" />
            } @else {
              <app-status-pill label="Not signed in yet" tone="idle" />
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="actions">
          <th mat-header-cell *matHeaderCellDef><span class="sr-only">Actions</span></th>
          <td mat-cell *matCellDef="let r" class="acts">
            <!--
              One trigger per row instead of three buttons, so a wide register reads as
              rows of people rather than rows of controls. The menu carries the accessible
              name of the person it acts on, because "more options" twenty times over tells
              a screen-reader user nothing about which row they are on.
            -->
            <button
              matIconButton
              type="button"
              [matMenuTriggerFor]="rowMenu"
              [attr.aria-label]="'Actions for ' + r.fullName"
            >
<mat-icon>more_vert</mat-icon>
            </button>

            <mat-menu #rowMenu="matMenu">
              <button mat-menu-item type="button" (click)="openEdit(r)">Edit</button>
              <button mat-menu-item type="button" (click)="openEligibility(r)">
                Eligibility
              </button>
              <button mat-menu-item type="button" (click)="openVehicles(r)">Vehicles</button>
              <button mat-menu-item type="button" class="danger" (click)="remove(r)">
                Remove
              </button>
            </mat-menu>
          </td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="columns"></tr>
        <tr mat-row *matRowDef="let row; columns: columns"></tr>
      </table>

      @if (facade.hasPrevious() || facade.hasNext()) {
        <app-pager
          [page]="facade.pageNumber()"
          [pageSize]="facade.limit()"
          [count]="facade.residents().length"
          [hasPrevious]="facade.hasPrevious()"
          [hasNext]="facade.hasNext()"
          (previous)="facade.previousPage()"
          (next)="facade.nextPage()"
        />
      }
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

        /* A register needs columns, not a reading measure. */
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
        font-size: var(--t-head);
      }
      .head__p {
        color: var(--steel-soft);
        margin-top: var(--sp-1);
      }

      .filters {
        display: flex;
        gap: var(--sp-3);
        align-items: center;
        flex-wrap: wrap;
        border-bottom: 1px solid var(--rule);
        padding-bottom: var(--sp-4);
      }
      .filters mat-form-field {
        width: 13rem;
      }

      .msg__list {
        margin: var(--sp-2) 0 0;
        padding-left: var(--sp-4);
        font-size: var(--t-fine);
      }

      /* The table itself is the shared one in styles.scss; only this register's own
         cells are styled here. */
      .name {
        font-weight: 600;
      }
      .unit {
        font-variation-settings:
          'wdth' 112,
          'wght' 620;
      }
      /* Plates side by side, wrapping under each other on a narrow column. */
      .plates {
        display: flex;
        flex-wrap: wrap;
        gap: var(--sp-1) var(--sp-3);
      }
      .plate {
        font-size: var(--t-small);
        white-space: nowrap;
      }
      /* An empty register is an invitation, not a dash: it opens the vehicle register. */
      .add-car {
        font: inherit;
        font-size: var(--t-fine);
        padding: 0;
        border: 0;
        background: none;
        color: var(--steel-soft);
        text-decoration: underline;
        text-underline-offset: 3px;
        cursor: pointer;
      }
      .add-car:focus-visible {
        outline: 2px solid var(--signal);
        outline-offset: 2px;
      }
      .reason {
        display: block;
        color: var(--revoked);
        font-size: var(--t-fine);
        margin-top: var(--sp-1);
      }
      /* The same shape as .reason, but this one is a statement of a rule, not a refusal,
         so it does not borrow the colour that means something was revoked. */
      .note {
        display: block;
        color: var(--steel-faint);
        font-size: var(--t-fine);
        margin-top: var(--sp-1);
      }

      @media (max-width: 40rem) {
        .head,
        .filters {
          flex-direction: column;
          align-items: stretch;
        }
        .filters mat-form-field {
          width: 100%;
        }
      }
    `,
  ],
})
export default class ResidentsPage {
  readonly facade = inject(ResidentsFacade);
  /** A refused row action is answered by a toast; a dialog's error stays in the dialog. */
  private readonly errorToasts = toastFacadeErrors(this.facade);
  private readonly dialog = inject(MatDialog);
  private readonly confirm = inject(ConfirmService);

  /**
   * The rows the table draws.
   *
   * GET /residents already leaves administrators out - it has to, because the page limit
   * is applied in that query and filtering afterwards would hand this table fourteen
   * rows and call it a page of fifteen. This filter is the second line of the same
   * defence, and costs a pass over fifteen rows: an account that arrives flagged, from
   * an older deployment or a caller that asked differently, still does not get drawn
   * among the people waiting for a bay.
   */
  readonly rows = computed(() => this.facade.residents().filter((r) => !r.isAdmin));

  readonly columns = [
    'num',
    'name',
    'unit',
    'email',
    'eligibility',
    'bay',
    'accessible',
    'vehicles',
    'signin',
    'actions',
  ];

  /** Kept as an escape so the source file stays ASCII whatever opens it. */
  readonly dash = '\u2014';

  onSort(s: Sort): void {
    if (!s.direction) return;
    this.facade.setSort(s.active as ResidentSortField, s.direction);
  }

  /** The select speaks strings, so the tri-state is mapped at the boundary. */
  eligibleFilter(): string {
    const v = this.facade.eligible();
    return v === undefined ? '' : v ? 'yes' : 'no';
  }

  setEligibleFilter(v: string): void {
    this.facade.setEligible(v === '' ? undefined : v === 'yes');
  }

  openCreate(): void {
    this.dialog.open(AddResidentDialog, { width: '32rem', maxWidth: 'calc(100vw - 2rem)' });
  }

  openEdit(r: Resident): void {
    this.dialog.open(EditResidentDialog, {
      data: r,
      width: '32rem',
      maxWidth: 'calc(100vw - 2rem)',
    });
  }

  /**
   * UC: removing a resident from the register. The server does a soft delete, because
   * rule D says allocation history is never reset - a person who leaves the building
   * still has to appear in the record of past draws, or those draws stop being
   * explainable. So this takes them out of the register and out of every future draw,
   * and leaves what already happened alone. It is called Remove rather than Delete,
   * because Delete would promise something the system deliberately does not do.
   */
  async remove(r: Resident): Promise<void> {
    // A resident holding a bay cannot be removed - the server refuses it. Saying so here
    // turns a refusal the administrator would have met after pressing into one they meet
    // before, with the bay named and the fix stated.
    if (r.currentSpotCode) {
      await this.confirm.ask({
        title: `${r.fullName} holds bay ${r.currentSpotCode}`,
        body:
          'A resident holding a bay cannot be removed from the register, because the bay ' +
          'would stay assigned to nobody. Release the bay first, on The lot, and then ' +
          'remove them.',
        confirmLabel: 'Close',
        cancelLabel: '',
      });
      return;
    }

    const ok = await this.confirm.ask({
      title: `Remove ${r.fullName}?`,
      body:
        `Unit ${r.unitNumber} comes off the register and out of every future draw. ` +
        'Their past results are kept, because allocation history is never reset - a draw ' +
        'they were in has to stay explainable.',
      confirmLabel: 'Remove them',
      cancelLabel: 'Keep them',
      danger: true,
    });
    if (ok) await this.facade.deactivate(r.id);
  }

  openEligibility(r: Resident): void {
    this.dialog.open(EligibilityDialog, {
      data: r,
      width: '32rem',
      maxWidth: 'calc(100vw - 2rem)',
    });
  }

  /**
   * The resident's vehicles. Wider than the other dialogs because it holds a table as
   * well as a form, and a plate column that wraps is a plate column nobody can read
   * against what a camera produced.
   */
  openVehicles(r: Resident): void {
    this.dialog
      .open(VehiclesDialog, {
        data: r,
        width: '44rem',
        maxWidth: 'calc(100vw - 2rem)',
        autoFocus: 'first-tabbable',
      })
      // The dialog edits the register; the Vehicles column reads it, so it catches up.
      .afterClosed()
      .subscribe(() => this.facade.refreshVehicles());
  }
}
