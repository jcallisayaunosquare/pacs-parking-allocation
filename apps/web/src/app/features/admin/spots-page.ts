import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { SpotsFacade } from '../../application/admin.facades';
import type { ParkingSpot, SpotType } from '../../domain/models';
import { StatusPill } from '../../shared/ui/status-pill';
import { ViewStateHost } from '../../shared/ui/view-state';

/**
 * Admin — parking inventory (FR-16, §17).
 *
 * Deactivation is the interesting case: the server refuses it with 409 while the spot
 * is assigned for the current cycle, because taking a bay out from under someone who
 * is parked in it is an operational problem, not a data one. The UI surfaces that
 * refusal as it is, rather than hiding the control and leaving the admin guessing.
 */
@Component({
  selector: 'app-spots-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ButtonModule,
    DialogModule,
    InputTextModule,
    MessageModule,
    SelectModule,
    TableModule,
    ToggleSwitchModule,
    StatusPill,
    ViewStateHost,
  ],
  template: `
    <header class="head">
      <h1 class="title">Inventario de lugares</h1>
      <p-button label="Nuevo lugar" icon="pi pi-plus" size="small" (onClick)="openCreate()" />
    </header>

    @if (facade.counts(); as c) {
      <div class="stats">
        <div><b>{{ c.total }}</b><span>totales</span></div>
        <div><b>{{ c.active }}</b><span>activos</span></div>
        <div><b>{{ c.accessible }}</b><span>accesibles</span></div>
        <div><b>{{ c.ev }}</b><span>eléctricos</span></div>
      </div>
    }

    <div class="filters">
      <p-select
        [options]="typeOptions"
        optionLabel="label"
        optionValue="value"
        placeholder="Todos los tipos"
        [ngModel]="facade.type()"
        (ngModelChange)="facade.type.set($event ?? undefined)"
        [showClear]="true"
        ariaLabel="Filtrar por tipo"
      />
      <label class="only-active">
        <p-toggle-switch
          [ngModel]="facade.activeOnly()"
          (ngModelChange)="facade.activeOnly.set($event)"
          inputId="only-active"
        />
        <span>Solo activos</span>
      </label>
    </div>

    @if (facade.error(); as e) {
      <p-message severity="error" styleClass="w-full">{{ e.message }}</p-message>
    }

    <app-view-state
      [state]="facade.state()"
      [skeletonCount]="5"
      emptyTitle="Sin lugares en el inventario"
      emptyBody="Un sorteo necesita al menos un lugar activo. Creá el primero para poder ejecutar un ciclo."
      emptyActionLabel="Nuevo lugar"
      (action)="openCreate()"
      (retry)="facade.refresh()"
    >
      <p-table
        [value]="[...facade.spots()]"
        styleClass="p-datatable-sm"
        [tableStyle]="{ 'min-width': '40rem' }"
      >
        <ng-template #header>
          <tr>
            <th scope="col">Código</th>
            <th scope="col">Nivel</th>
            <th scope="col">Tipo</th>
            <th scope="col">Estado</th>
            <th scope="col">Notas</th>
            <th scope="col"></th>
          </tr>
        </ng-template>

        <ng-template #body let-s>
          <tr>
            <td class="strong">{{ s.spotCode }}</td>
            <td>{{ s.level }}</td>
            <td>
              @switch (s.type) {
                @case ('ACCESSIBLE') {
                  <app-status-pill label="Accesible" tone="warn" />
                }
                @case ('EV') {
                  <app-status-pill label="Eléctrico" tone="wait" />
                }
                @default {
                  <app-status-pill label="Estándar" tone="muted" />
                }
              }
            </td>
            <td>
              @if (s.isActive) {
                <app-status-pill label="Activo" tone="ok" />
              } @else {
                <app-status-pill label="Fuera de servicio" tone="bad" />
              }
            </td>
            <td class="muted">{{ s.notes ?? '—' }}</td>
            <td class="actions">
              <p-button
                [label]="s.isActive ? 'Dar de baja' : 'Reactivar'"
                severity="secondary"
                [text]="true"
                size="small"
                [loading]="facade.busy()"
                (onClick)="toggle(s)"
              />
            </td>
          </tr>
        </ng-template>
      </p-table>
    </app-view-state>

    <p-dialog
      header="Nuevo lugar"
      [(visible)]="createOpen"
      [modal]="true"
      [style]="{ width: '28rem' }"
      [draggable]="false"
    >
      <div class="form">
        <label for="ns-code">Código</label>
        <input pInputText id="ns-code" [(ngModel)]="form.spotCode" placeholder="B2-14" />

        <label for="ns-level">Nivel</label>
        <input pInputText id="ns-level" [(ngModel)]="form.level" placeholder="B2" />

        <label for="ns-type">Tipo</label>
        <p-select
          inputId="ns-type"
          [options]="typeOptions"
          optionLabel="label"
          optionValue="value"
          [(ngModel)]="form.type"
        />

        <label for="ns-notes">Notas</label>
        <input pInputText id="ns-notes" [(ngModel)]="form.notes" />
      </div>

      <ng-template #footer>
        <p-button label="Cancelar" severity="secondary" [text]="true" (onClick)="createOpen = false" />
        <p-button
          label="Crear"
          [loading]="facade.busy()"
          [disabled]="!form.spotCode.trim() || !form.level.trim()"
          (onClick)="submitCreate()"
        />
      </ng-template>
    </p-dialog>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
      }
      .title {
        margin: 0;
        font-size: 1.35rem;
        font-weight: 680;
      }
      .stats {
        display: flex;
        gap: 1.75rem;
        flex-wrap: wrap;
      }
      .stats div {
        display: flex;
        flex-direction: column;
      }
      .stats b {
        font-size: 1.35rem;
        line-height: 1;
      }
      .stats span {
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #7a7a7a;
        margin-top: 0.2rem;
      }
      .filters {
        display: flex;
        gap: 1rem;
        align-items: center;
        flex-wrap: wrap;
      }
      .only-active {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.88rem;
      }
      .strong {
        font-weight: 620;
      }
      .muted {
        color: #7a7a7a;
      }
      .actions {
        text-align: right;
      }
      .form {
        display: flex;
        flex-direction: column;
        gap: 0.45rem;
      }
      .form label {
        font-size: 0.82rem;
        font-weight: 600;
        margin-top: 0.4rem;
      }
    `,
  ],
})
export default class SpotsPage {
  readonly facade = inject(SpotsFacade);

  readonly typeOptions: { label: string; value: SpotType }[] = [
    { label: 'Estándar', value: 'STANDARD' },
    { label: 'Accesible', value: 'ACCESSIBLE' },
    { label: 'Eléctrico', value: 'EV' },
  ];

  createOpen = false;
  form: { spotCode: string; level: string; type: SpotType; notes: string } = {
    spotCode: '',
    level: '',
    type: 'STANDARD',
    notes: '',
  };

  openCreate(): void {
    this.form = { spotCode: '', level: '', type: 'STANDARD', notes: '' };
    this.facade.dismissError();
    this.createOpen = true;
  }

  async submitCreate(): Promise<void> {
    const r = await this.facade.create({
      spotCode: this.form.spotCode.trim().toUpperCase(),
      level: this.form.level.trim(),
      type: this.form.type,
      notes: this.form.notes.trim() || null,
    });
    if (r) this.createOpen = false;
  }

  toggle(s: ParkingSpot): void {
    this.facade.dismissError();
    void this.facade.setActive(s, !s.isActive);
  }
}
