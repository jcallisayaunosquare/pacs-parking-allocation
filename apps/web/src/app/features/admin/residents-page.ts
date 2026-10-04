import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TextareaModule } from 'primeng/textarea';
import { ResidentsFacade } from '../../application/admin.facades';
import type { Resident } from '../../domain/models';
import { StatusPill } from '../../shared/ui/status-pill';
import { ViewStateHost } from '../../shared/ui/view-state';

/**
 * Admin — residents. Search, edit, set eligibility (§17).
 *
 * Eligibility is the screen's sharp edge: FR-15 requires a reason, it is audit-logged,
 * and it changes who the next draw even considers. So it gets its own dialog with a
 * mandatory reason rather than an inline toggle that can be flipped by accident.
 */
@Component({
  selector: 'app-residents-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ButtonModule,
    CheckboxModule,
    DialogModule,
    InputTextModule,
    MessageModule,
    SelectModule,
    TableModule,
    TextareaModule,
    StatusPill,
    ViewStateHost,
  ],
  template: `
    <header class="head">
      <h1 class="title">Residentes</h1>
      <p-button label="Nuevo residente" icon="pi pi-plus" size="small" (onClick)="openCreate()" />
    </header>

    <div class="filters">
      <input
        pInputText
        type="text"
        placeholder="Filtrar por unidad"
        [ngModel]="facade.unit() ?? ''"
        (ngModelChange)="facade.unit.set($event || undefined)"
        aria-label="Filtrar por unidad"
      />
      <p-select
        [options]="eligibilityOptions"
        optionLabel="label"
        optionValue="value"
        placeholder="Elegibilidad"
        [ngModel]="facade.eligible()"
        (ngModelChange)="facade.eligible.set($event ?? undefined)"
        [showClear]="true"
        ariaLabel="Filtrar por elegibilidad"
      />
      <p-button
        label="Limpiar"
        severity="secondary"
        [text]="true"
        size="small"
        (onClick)="facade.resetFilters()"
      />
    </div>

    @if (facade.error(); as e) {
      <p-message severity="error" styleClass="w-full">
        {{ e.message }}
        @if (e.details?.length) {
          <ul class="details">
            @for (d of e.details; track d.field) {
              <li>{{ d.field }}: {{ d.issue }}</li>
            }
          </ul>
        }
      </p-message>
    }

    <app-view-state
      [state]="facade.state()"
      [skeletonCount]="5"
      emptyTitle="No hay residentes que coincidan"
      emptyBody="Probá limpiar los filtros, o creá el primer residente del edificio."
      emptyActionLabel="Nuevo residente"
      (action)="openCreate()"
      (retry)="facade.refresh()"
    >
      <p-table
        [value]="[...facade.residents()]"
        styleClass="p-datatable-sm"
        [tableStyle]="{ 'min-width': '52rem' }"
      >
        <ng-template #header>
          <tr>
            <th scope="col">Nombre</th>
            <th scope="col">Unidad</th>
            <th scope="col">Email</th>
            <th scope="col">Elegibilidad</th>
            <th scope="col">Accesible</th>
            <th scope="col">Cognito</th>
            <th scope="col"></th>
          </tr>
        </ng-template>

        <ng-template #body let-r>
          <tr>
            <td class="strong">{{ r.fullName }}</td>
            <td>{{ r.unitNumber }}</td>
            <td class="muted">{{ r.email }}</td>
            <td>
              @if (r.isEligible) {
                <app-status-pill label="Elegible" tone="ok" />
              } @else {
                <app-status-pill label="No elegible" tone="bad" />
                @if (r.ineligibleReason) {
                  <small class="reason">{{ r.ineligibleReason }}</small>
                }
              }
            </td>
            <td>
              @if (r.needsAccessibleSpot) {
                <app-status-pill label="Requiere" tone="warn" />
              } @else {
                <span class="muted">—</span>
              }
            </td>
            <td>
              @if (r.externalSubject) {
                <app-status-pill label="Vinculado" tone="ok" />
              } @else {
                <app-status-pill label="Pendiente" tone="wait" />
              }
            </td>
            <td class="actions">
              <p-button
                icon="pi pi-shield"
                severity="secondary"
                [text]="true"
                size="small"
                ariaLabel="Cambiar elegibilidad"
                (onClick)="openEligibility(r)"
              />
            </td>
          </tr>
        </ng-template>
      </p-table>

      @if (facade.nextCursor()) {
        <div class="more">
          <p-button
            label="Cargar más"
            severity="secondary"
            size="small"
            [loading]="facade.busy()"
            (onClick)="facade.nextPage()"
          />
        </div>
      }
    </app-view-state>

    <!-- Create -->
    <p-dialog
      header="Nuevo residente"
      [(visible)]="createOpen"
      [modal]="true"
      [style]="{ width: '30rem' }"
      [draggable]="false"
    >
      <div class="form">
        <label for="nr-name">Nombre completo</label>
        <input pInputText id="nr-name" [(ngModel)]="form.fullName" autocomplete="off" />

        <label for="nr-unit">Unidad</label>
        <input pInputText id="nr-unit" [(ngModel)]="form.unitNumber" autocomplete="off" />

        <label for="nr-email">Email</label>
        <input pInputText id="nr-email" type="email" [(ngModel)]="form.email" autocomplete="off" />

        <div class="check">
          <p-checkbox [(ngModel)]="form.needsAccessibleSpot" [binary]="true" inputId="nr-acc" />
          <label for="nr-acc">Requiere lugar accesible</label>
        </div>

        <p class="hint">
          El usuario de Cognito se crea de forma asincrónica y el residente recibe la
          invitación por email. La columna "Cognito" pasa a "Vinculado" en el primer ingreso.
        </p>
      </div>

      <ng-template #footer>
        <p-button label="Cancelar" severity="secondary" [text]="true" (onClick)="createOpen = false" />
        <p-button
          label="Crear"
          [loading]="facade.busy()"
          [disabled]="!canSubmit()"
          (onClick)="submitCreate()"
        />
      </ng-template>
    </p-dialog>

    <!-- Eligibility -->
    <p-dialog
      [header]="'Elegibilidad · ' + (editing()?.fullName ?? '')"
      [(visible)]="eligibilityOpen"
      [modal]="true"
      [style]="{ width: '30rem' }"
      [draggable]="false"
    >
      <div class="form">
        <div class="check">
          <p-checkbox [(ngModel)]="eligibleDraft" [binary]="true" inputId="el-flag" />
          <label for="el-flag">Es elegible para el sorteo</label>
        </div>

        @if (!eligibleDraft) {
          <label for="el-reason">Motivo (obligatorio)</label>
          <textarea
            pTextarea
            id="el-reason"
            rows="3"
            [(ngModel)]="reasonDraft"
            placeholder="Ej.: expensas impagas"
          ></textarea>
          <p class="hint">
            El motivo queda en el registro de auditoría y se le muestra al residente.
          </p>
        }
      </div>

      <ng-template #footer>
        <p-button
          label="Cancelar"
          severity="secondary"
          [text]="true"
          (onClick)="eligibilityOpen = false"
        />
        <p-button
          label="Guardar"
          [loading]="facade.busy()"
          [disabled]="!eligibleDraft && !reasonDraft.trim()"
          (onClick)="submitEligibility()"
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
      .filters {
        display: flex;
        gap: 0.6rem;
        align-items: center;
        flex-wrap: wrap;
      }
      .strong {
        font-weight: 620;
      }
      .muted {
        color: #7a7a7a;
      }
      .reason {
        display: block;
        color: #7c2d14;
        margin-top: 0.2rem;
      }
      .actions {
        text-align: right;
      }
      .more {
        margin-top: 0.8rem;
        text-align: center;
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
      .check {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-top: 0.7rem;
      }
      .check label {
        margin: 0;
        font-weight: 500;
      }
      .hint {
        margin: 0.6rem 0 0;
        font-size: 0.8rem;
        color: #6a6a6a;
        line-height: 1.45;
      }
      .details {
        margin: 0.35rem 0 0;
        padding-left: 1.1rem;
        font-size: 0.82rem;
      }
    `,
  ],
})
export default class ResidentsPage {
  readonly facade = inject(ResidentsFacade);

  readonly eligibilityOptions = [
    { label: 'Elegibles', value: true },
    { label: 'No elegibles', value: false },
  ];

  createOpen = false;
  eligibilityOpen = false;
  eligibleDraft = true;
  reasonDraft = '';

  readonly editing = signal<Resident | null>(null);

  form = { fullName: '', unitNumber: '', email: '', needsAccessibleSpot: false };

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
    this.createOpen = true;
  }

  async submitCreate(): Promise<void> {
    const r = await this.facade.create({
      email: this.form.email.trim(),
      fullName: this.form.fullName.trim(),
      unitNumber: this.form.unitNumber.trim(),
      needsAccessibleSpot: this.form.needsAccessibleSpot,
    });
    if (r) this.createOpen = false;
  }

  openEligibility(r: Resident): void {
    this.editing.set(r);
    this.eligibleDraft = r.isEligible;
    this.reasonDraft = r.ineligibleReason ?? '';
    this.facade.dismissError();
    this.eligibilityOpen = true;
  }

  async submitEligibility(): Promise<void> {
    const r = this.editing();
    if (!r) return;
    const done = await this.facade.setEligibility(
      r.id,
      this.eligibleDraft,
      this.eligibleDraft ? null : this.reasonDraft.trim(),
    );
    if (done) this.eligibilityOpen = false;
  }
}
