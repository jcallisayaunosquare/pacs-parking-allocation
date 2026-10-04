import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ResidentsFacade } from '../../application/admin.facades';
import type { Resident } from '../../domain/models';
import type { ResidentSortField } from '../../domain/repositories';
import { Modal } from '../../shared/ui/modal';
import { StatusPill } from '../../shared/ui/status-pill';
import { ViewStateHost } from '../../shared/ui/view-state';

/**
 * Admin — the resident register. Search, edit, set eligibility (§17).
 *
 * Eligibility is the sharp edge: FR-15 requires a reason, the change is audit-logged,
 * and it decides who the next draw even considers. So it gets a dialog with a mandatory
 * reason rather than an inline toggle that can be flipped by a stray click.
 */
@Component({
  selector: 'app-residents-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, Modal, StatusPill, ViewStateHost],
  template: `
    <header class="head">
      <div>
        <h1 class="head__h">Residents</h1>
        <p class="head__p">Who may enter the draw, and on what terms.</p>
      </div>
      <button class="btn" type="button" (click)="openCreate()">Add resident</button>
    </header>

    <div class="filters">
      <input
        class="input"
        type="search"
        placeholder="Filter by unit"
        [ngModel]="facade.unit() ?? ''"
        (ngModelChange)="facade.setUnit($event || undefined)"
        aria-label="Filter by unit"
      />
      <select
        class="select"
        [ngModel]="eligibleFilter()"
        (ngModelChange)="setEligibleFilter($event)"
        aria-label="Filter by eligibility"
      >
        <option value="">Any eligibility</option>
        <option value="yes">Eligible</option>
        <option value="no">Not eligible</option>
      </select>
      <button class="btn btn--bare" type="button" (click)="clearFilters()">Clear</button>
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
      <div class="tbl__wrap">
        <table class="tbl">
          <thead>
            <tr>
              @for (col of sortableColumns; track col.field) {
                <th scope="col" [attr.aria-sort]="ariaSort(col.field)">
                  <button
                    class="tbl__sort"
                    type="button"
                    [attr.aria-sort]="ariaSort(col.field)"
                    (click)="facade.sortBy(col.field)"
                  >
                    {{ col.label }}
                    <span class="tbl__arrow" [class]="arrowClass(col.field)" aria-hidden="true"></span>
                  </button>
                </th>
              }
              <th scope="col">Accessible bay</th>
              <th scope="col">Sign-in</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            @for (r of facade.residents(); track r.id) {
              <tr>
                <td class="name" data-label="Name">{{ r.fullName }}</td>
                <td class="unit" data-label="Unit">{{ r.unitNumber }}</td>
                <td class="dim" data-label="Email">{{ r.email }}</td>
                <td data-label="Eligibility">
                  @if (r.isEligible) {
                    <app-status-pill label="Eligible" tone="held" />
                  } @else {
                    <app-status-pill label="Not eligible" tone="revoked" />
                    @if (r.ineligibleReason) {
                      <span class="reason">{{ r.ineligibleReason }}</span>
                    }
                  }
                </td>
                <td data-label="Accessible bay">
                  @if (r.needsAccessibleSpot) {
                    <app-status-pill label="Required" tone="attention" />
                  } @else {
                    <span class="dim">No</span>
                  }
                </td>
                <td data-label="Sign-in">
                  @if (r.externalSubject) {
                    <app-status-pill label="Linked" tone="held" />
                  } @else {
                    <app-status-pill label="Not signed in yet" tone="waiting" />
                  }
                </td>
                <td>
                  <div class="acts">
                    <button class="btn btn--bare" type="button" (click)="openEdit(r)">Edit</button>
                    <button class="btn btn--bare" type="button" (click)="openEligibility(r)">
                      Eligibility
                    </button>
                  </div>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <nav class="pager" aria-label="Pages">
        <button
          class="btn btn--quiet btn--sm"
          type="button"
          [disabled]="!facade.hasPrevious()"
          (click)="facade.previousPage()"
        >
          Previous
        </button>
        <span class="pager__at">
          Page {{ facade.pageNumber() }} · {{ facade.residents().length }} shown
        </span>
        <button
          class="btn btn--quiet btn--sm"
          type="button"
          [disabled]="!facade.hasNext()"
          (click)="facade.nextPage()"
        >
          Next
        </button>
      </nav>
    </app-view-state>

    <app-modal [open]="createOpen()" title="Add resident" (closed)="createOpen.set(false)">
      <div class="field">
        <label class="field__label" for="nr-name">Full name</label>
        <input class="input" id="nr-name" [(ngModel)]="form.fullName" autocomplete="off" />
      </div>
      <div class="field">
        <label class="field__label" for="nr-unit">Unit</label>
        <input class="input" id="nr-unit" [(ngModel)]="form.unitNumber" autocomplete="off" />
      </div>
      <div class="field">
        <label class="field__label" for="nr-email">Email</label>
        <input
          class="input"
          id="nr-email"
          type="email"
          [(ngModel)]="form.email"
          autocomplete="off"
        />
      </div>
      <label class="check">
        <input type="checkbox" [(ngModel)]="form.needsAccessibleSpot" />
        <span>Needs an accessible bay</span>
      </label>
      <p class="field__hint">
        The resident gets an invitation by email. Their sign-in links itself to this
        record the first time they use it, which is when "Sign-in" turns to "Linked".
      </p>

      <div modalFoot>
        <button class="btn btn--quiet" type="button" (click)="createOpen.set(false)">Cancel</button>
        <button
          class="btn"
          type="button"
          [disabled]="!canSubmit() || facade.busy()"
          (click)="submitCreate()"
        >
          Add resident
        </button>
      </div>
    </app-modal>

    <app-modal
      [open]="editOpen()"
      [title]="'Edit — ' + (editing()?.fullName ?? '')"
      (closed)="editOpen.set(false)"
    >
      <div class="field">
        <label class="field__label" for="er-name">Full name</label>
        <input class="input" id="er-name" [(ngModel)]="editForm.fullName" autocomplete="off" />
      </div>
      <div class="field">
        <label class="field__label" for="er-unit">Unit</label>
        <input class="input" id="er-unit" [(ngModel)]="editForm.unitNumber" autocomplete="off" />
      </div>
      <label class="check">
        <input type="checkbox" [(ngModel)]="editForm.needsAccessibleSpot" />
        <span>Needs an accessible bay</span>
      </label>

      <div class="field">
        <label class="field__label">Email</label>
        <p class="field__fixed">{{ editing()?.email }}</p>
        <p class="field__hint">
          The email cannot be changed here. It is what a resident's sign-in matches itself
          against, so editing it would detach the account from this record. Add the resident
          again under the new address instead.
        </p>
      </div>

      <div modalFoot>
        <button class="btn btn--quiet" type="button" (click)="editOpen.set(false)">Cancel</button>
        <button
          class="btn"
          type="button"
          [disabled]="!editChanged() || facade.busy()"
          (click)="submitEdit()"
        >
          Save changes
        </button>
      </div>
    </app-modal>

    <app-modal
      [open]="eligibilityOpen()"
      [title]="'Eligibility — ' + (editing()?.fullName ?? '')"
      (closed)="eligibilityOpen.set(false)"
    >
      <label class="check">
        <input type="checkbox" [(ngModel)]="eligibleDraft" />
        <span>May enter the draw</span>
      </label>

      @if (!eligibleDraft) {
        <div class="field">
          <label class="field__label" for="el-reason">Reason</label>
          <textarea
            class="input"
            id="el-reason"
            rows="3"
            [(ngModel)]="reasonDraft"
            placeholder="For example: unpaid dues"
          ></textarea>
        </div>
        <p class="field__hint">
          The reason is recorded in the audit log and shown to the resident, so write it
          as you would say it to them.
        </p>
      }

      <div modalFoot>
        <button class="btn btn--quiet" type="button" (click)="eligibilityOpen.set(false)">
          Cancel
        </button>
        <button
          class="btn"
          type="button"
          [disabled]="(!eligibleDraft && !reasonDraft.trim()) || facade.busy()"
          (click)="submitEligibility()"
        >
          Save
        </button>
      </div>
    </app-modal>
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

      .msg__list {
        margin: var(--sp-2) 0 0;
        padding-left: var(--sp-4);
        font-size: var(--t-fine);
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
      .acts {
        display: flex;
        gap: var(--sp-4);
        flex-wrap: wrap;
      }
      .field__fixed {
        font-weight: 600;
        word-break: break-all;
      }
      .reason {
        display: block;
        color: var(--revoked);
        font-size: var(--t-fine);
        margin-top: var(--sp-1);
      }
      .pager {
        margin-top: var(--sp-4);
        display: flex;
        align-items: center;
        gap: var(--sp-4);
        flex-wrap: wrap;
      }
      .pager__at {
        font-size: var(--t-fine);
        color: var(--steel-faint);
      }

      @media (max-width: 40rem) {
        .head,
        .filters {
          flex-direction: column;
          align-items: stretch;
        }
        .filters .input,
        .filters .select {
          width: 100%;
        }
      }
    `,
  ],
})
export default class ResidentsPage {
  readonly facade = inject(ResidentsFacade);

  readonly sortableColumns: { field: ResidentSortField; label: string }[] = [
    { field: 'name', label: 'Name' },
    { field: 'unit', label: 'Unit' },
    { field: 'email', label: 'Email' },
    { field: 'eligibility', label: 'Eligibility' },
  ];

  /** Announced to screen readers, and what the arrow is drawn from. */
  ariaSort(field: ResidentSortField): 'ascending' | 'descending' | 'none' {
    if (this.facade.sort() !== field) return 'none';
    return this.facade.dir() === 'asc' ? 'ascending' : 'descending';
  }

  arrowClass(field: ResidentSortField): string {
    const s = this.ariaSort(field);
    return s === 'ascending' ? 'tbl__arrow--asc' : s === 'descending' ? 'tbl__arrow--desc' : '';
  }

  readonly createOpen = signal(false);
  readonly editOpen = signal(false);
  readonly eligibilityOpen = signal(false);
  readonly editing = signal<Resident | null>(null);

  editForm = { fullName: '', unitNumber: '', needsAccessibleSpot: false };

  eligibleDraft = true;
  reasonDraft = '';

  form = { fullName: '', unitNumber: '', email: '', needsAccessibleSpot: false };

  /** The native select speaks strings, so the tri-state is mapped at the boundary. */
  eligibleFilter(): string {
    const v = this.facade.eligible();
    return v === undefined ? '' : v ? 'yes' : 'no';
  }

  setEligibleFilter(v: string): void {
    this.facade.setEligible(v === '' ? undefined : v === 'yes');
  }

  clearFilters(): void {
    this.facade.resetFilters();
  }

  canSubmit(): boolean {
    return (
      this.form.fullName.trim().length > 0 &&
      this.form.unitNumber.trim().length > 0 &&
      /.+@.+\..+/.test(this.form.email)
    );
  }

  openCreate(): void {
    this.form = { fullName: '', unitNumber: '', email: '', needsAccessibleSpot: false };
    this.facade.dismissError();
    this.createOpen.set(true);
  }

  async submitCreate(): Promise<void> {
    const r = await this.facade.create({
      email: this.form.email.trim(),
      fullName: this.form.fullName.trim(),
      unitNumber: this.form.unitNumber.trim(),
      needsAccessibleSpot: this.form.needsAccessibleSpot,
    });
    if (r) this.createOpen.set(false);
  }

  openEdit(r: Resident): void {
    this.editing.set(r);
    this.editForm = {
      fullName: r.fullName,
      unitNumber: r.unitNumber,
      needsAccessibleSpot: r.needsAccessibleSpot,
    };
    this.facade.dismissError();
    this.editOpen.set(true);
  }

  /**
   * Only what actually changed is sent, and Save stays disabled until something does.
   * The server rejects an empty patch, and sending a field back unchanged would still
   * write an audit entry claiming it was edited.
   */
  private editPatch(): { fullName?: string; unitNumber?: string; needsAccessibleSpot?: boolean } {
    const r = this.editing();
    if (!r) return {};
    const name = this.editForm.fullName.trim();
    const unit = this.editForm.unitNumber.trim();
    return {
      ...(name && name !== r.fullName ? { fullName: name } : {}),
      ...(unit && unit !== r.unitNumber ? { unitNumber: unit } : {}),
      ...(this.editForm.needsAccessibleSpot !== r.needsAccessibleSpot
        ? { needsAccessibleSpot: this.editForm.needsAccessibleSpot }
        : {}),
    };
  }

  editChanged(): boolean {
    return Object.keys(this.editPatch()).length > 0;
  }

  async submitEdit(): Promise<void> {
    const r = this.editing();
    const patch = this.editPatch();
    if (!r || Object.keys(patch).length === 0) return;
    const done = await this.facade.update(r.id, patch);
    if (done) this.editOpen.set(false);
  }

  openEligibility(r: Resident): void {
    this.editing.set(r);
    this.eligibleDraft = r.isEligible;
    this.reasonDraft = r.ineligibleReason ?? '';
    this.facade.dismissError();
    this.eligibilityOpen.set(true);
  }

  async submitEligibility(): Promise<void> {
    const r = this.editing();
    if (!r) return;
    const done = await this.facade.setEligibility(
      r.id,
      this.eligibleDraft,
      this.eligibleDraft ? null : this.reasonDraft.trim(),
    );
    if (done) this.eligibilityOpen.set(false);
  }
}
