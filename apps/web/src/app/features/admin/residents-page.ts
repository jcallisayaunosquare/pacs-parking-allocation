import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorIntl, MatPaginatorModule, type PageEvent } from '@angular/material/paginator';
import { MatSelectModule } from '@angular/material/select';
import { MatSortModule, type Sort } from '@angular/material/sort';
import { MatTableModule } from '@angular/material/table';
import { ResidentsFacade } from '../../application/admin.facades';
import type { Resident } from '../../domain/models';
import type { ResidentSortField } from '../../domain/repositories';
import { KeysetPaginatorIntl } from '../../shared/ui/keyset-paginator-intl';
import { StatusPill } from '../../shared/ui/status-pill';
import { ViewStateHost } from '../../shared/ui/view-state';
import { AddResidentDialog, EditResidentDialog, EligibilityDialog } from './residents-dialogs';

/**
 * Admin — the resident register. Sort, filter, page, edit, set eligibility (§17).
 *
 * Sorting and paging are server concerns here. `MatSort` and `MatPaginator` are driven
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
  providers: [{ provide: MatPaginatorIntl, useClass: KeysetPaginatorIntl }],
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatPaginatorModule,
    MatSelectModule,
    MatSortModule,
    MatTableModule,
    StatusPill,
    ViewStateHost,
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

    @if (facade.error(); as e) {
      <div class="msg msg--bad" role="alert">
        {{ e.message }}
        @if (e.details?.length) {
          <ul class="msg__list">
            @for (d of e.details; track d.field) {
              <li>{{ d.field }}: {{ d.issue }}</li>
            }
          </ul>
        }
      </div>
    }

    <app-view-state
      [state]="facade.state()"
      [skeletonCount]="6"
      emptyTitle="No residents match"
      emptyBody="Clear the filters, or add the building's first resident to get started."
      emptyActionLabel="Add resident"
      (action)="openCreate()"
      (retry)="facade.refresh()"
    >
      <table
        mat-table
        [dataSource]="facade.residents()"
        matSort
        matSortDisableClear
        [matSortActive]="facade.sort()"
        [matSortDirection]="facade.dir()"
        (matSortChange)="onSort($event)"
      >
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

        <ng-container matColumnDef="signin">
          <th mat-header-cell *matHeaderCellDef>Sign-in</th>
          <td mat-cell *matCellDef="let r" data-label="Sign-in">
            @if (r.externalSubject) {
              <app-status-pill label="Linked" tone="held" />
            } @else {
              <app-status-pill label="Not signed in yet" tone="waiting" />
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="actions">
          <th mat-header-cell *matHeaderCellDef><span class="sr-only">Actions</span></th>
          <td mat-cell *matCellDef="let r" class="acts">
            <button matButton type="button" (click)="openEdit(r)">Edit</button>
            <button matButton type="button" (click)="openEligibility(r)">Eligibility</button>
          </td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="columns"></tr>
        <tr mat-row *matRowDef="let row; columns: columns"></tr>
      </table>

      <mat-paginator
        [length]="pagerLength()"
        [pageSize]="facade.limit()"
        [pageIndex]="facade.pageNumber() - 1"
        [hidePageSize]="true"
        (page)="onPage($event)"
      />
    </app-view-state>
  `,
  styles: [
    `
      :host {
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

      table {
        width: 100%;
      }
      .name {
        font-weight: 600;
      }
      .unit {
        font-variation-settings:
          'wdth' 112,
          'wght' 620;
      }
      .dim {
        color: var(--steel-faint);
      }
      .reason {
        display: block;
        color: var(--revoked);
        font-size: var(--t-fine);
        margin-top: var(--sp-1);
      }
      .acts {
        white-space: nowrap;
        text-align: right;
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
  private readonly dialog = inject(MatDialog);

  readonly columns = ['name', 'unit', 'email', 'eligibility', 'accessible', 'signin', 'actions'];

  /**
   * What `MatPaginator` is told instead of a row count.
   *
   * It disables Next when the current page is the last one it can work out from
   * `length`, so the number only has to put the boundary in the right place: one row
   * past the end of this page while a cursor remains, and exactly the end of this page
   * once the server stops sending one.
   */
  readonly pagerLength = computed(() => {
    const size = this.facade.limit();
    const index = this.facade.pageNumber() - 1;
    return this.facade.hasNext()
      ? (index + 1) * size + 1
      : index * size + this.facade.residents().length;
  });

  onSort(s: Sort): void {
    if (!s.direction) return;
    this.facade.setSort(s.active as ResidentSortField, s.direction);
  }

  onPage(e: PageEvent): void {
    if (e.pageIndex > (e.previousPageIndex ?? 0)) this.facade.nextPage();
    else this.facade.previousPage();
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

  openEligibility(r: Resident): void {
    this.dialog.open(EligibilityDialog, {
      data: r,
      width: '32rem',
      maxWidth: 'calc(100vw - 2rem)',
    });
  }
}
