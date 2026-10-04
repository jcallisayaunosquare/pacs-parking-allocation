import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SpotsFacade } from '../../application/admin.facades';
import type { ParkingSpot, SpotType } from '../../domain/models';
import { Modal } from '../../shared/ui/modal';
import { StatusPill } from '../../shared/ui/status-pill';
import { ViewStateHost } from '../../shared/ui/view-state';

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
  imports: [FormsModule, Modal, StatusPill, ViewStateHost],
  template: `
    <header class="head">
      <div>
        <h1 class="head__h">Bays</h1>
        <p class="head__p">What the draw has to hand out.</p>
      </div>
      <button class="btn" type="button" (click)="openCreate()">Add bay</button>
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
      <select
        class="select"
        [ngModel]="facade.type() ?? ''"
        (ngModelChange)="facade.type.set($event || undefined)"
        aria-label="Filter by type"
      >
        <option value="">Any type</option>
        @for (o of typeOptions; track o.value) {
          <option [value]="o.value">{{ o.label }}</option>
        }
      </select>
      <label class="check">
        <input
          type="checkbox"
          [ngModel]="facade.activeOnly()"
          (ngModelChange)="facade.activeOnly.set($event)"
        />
        <span>In service only</span>
      </label>
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
      <div class="tbl__wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th scope="col">Bay</th>
              <th scope="col">Level</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col">Notes</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            @for (s of facade.spots(); track s.id) {
              <tr [class.row--out]="!s.isActive">
                <td class="code stencil">{{ s.spotCode }}</td>
                <td>{{ s.level }}</td>
                <td>
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
                <td>
                  @if (s.isActive) {
                    <app-status-pill label="In service" tone="held" />
                  } @else {
                    <app-status-pill label="Out of service" tone="revoked" />
                  }
                </td>
                <td class="dim">{{ s.notes || '—' }}</td>
                <td>
                  <button
                    class="btn btn--bare"
                    type="button"
                    [disabled]="facade.busy()"
                    (click)="toggle(s)"
                  >
                    {{ s.isActive ? 'Take out of service' : 'Put back in service' }}
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </app-view-state>

    <app-modal [open]="createOpen()" title="Add bay" (closed)="createOpen.set(false)">
      <div class="field">
        <label class="field__label" for="ns-code">Bay code</label>
        <input class="input" id="ns-code" [(ngModel)]="form.spotCode" placeholder="B2-14" />
      </div>
      <div class="field">
        <label class="field__label" for="ns-level">Level</label>
        <input class="input" id="ns-level" [(ngModel)]="form.level" placeholder="B2" />
      </div>
      <div class="field">
        <label class="field__label" for="ns-type">Type</label>
        <select class="select" id="ns-type" [(ngModel)]="form.type">
          @for (o of typeOptions; track o.value) {
            <option [value]="o.value">{{ o.label }}</option>
          }
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="ns-notes">Notes</label>
        <input class="input" id="ns-notes" [(ngModel)]="form.notes" placeholder="Optional" />
      </div>
      <p class="field__hint">
        Bay codes are what residents read on the floor, so use the code painted there.
      </p>

      <div modalFoot>
        <button class="btn btn--quiet" type="button" (click)="createOpen.set(false)">Cancel</button>
        <button
          class="btn"
          type="button"
          [disabled]="!form.spotCode.trim() || !form.level.trim() || facade.busy()"
          (click)="submitCreate()"
        >
          Add bay
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
    `,
  ],
})
export default class SpotsPage {
  readonly facade = inject(SpotsFacade);

  readonly typeOptions: { label: string; value: SpotType }[] = [
    { label: 'Standard', value: 'STANDARD' },
    { label: 'Accessible', value: 'ACCESSIBLE' },
    { label: 'EV', value: 'EV' },
  ];

  readonly createOpen = signal(false);

  form: { spotCode: string; level: string; type: SpotType; notes: string } = {
    spotCode: '',
    level: '',
    type: 'STANDARD',
    notes: '',
  };

  openCreate(): void {
    this.form = { spotCode: '', level: '', type: 'STANDARD', notes: '' };
    this.facade.dismissError();
    this.createOpen.set(true);
  }

  async submitCreate(): Promise<void> {
    const r = await this.facade.create({
      spotCode: this.form.spotCode.trim().toUpperCase(),
      level: this.form.level.trim(),
      type: this.form.type,
      notes: this.form.notes.trim() || null,
    });
    if (r) this.createOpen.set(false);
  }

  toggle(s: ParkingSpot): void {
    this.facade.dismissError();
    void this.facade.setActive(s, !s.isActive);
  }
}
