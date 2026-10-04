import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { MessageModule } from 'primeng/message';
import { TableModule } from 'primeng/table';
import { ConfirmationService } from 'primeng/api';
import { CyclesFacade } from '../../application/admin.facades';
import type { Cycle, RunAssignment } from '../../domain/models';
import { StatusPill } from '../../shared/ui/status-pill';
import { ViewStateHost } from '../../shared/ui/view-state';

/**
 * Admin — cycles and runs (UC-04, UC-05, §17).
 *
 * The run button is the most consequential control in the product, so it is guarded
 * three ways: it only appears for the one cycle in REGISTRATION_CLOSED (the only state
 * a run may start from, §11), it goes through a confirm dialog, and the request carries
 * an Idempotency-Key so a double click replays instead of drawing twice.
 *
 * The seed is shown after a run on purpose: it is what makes the result auditable, and
 * an admin who can quote it can answer "why did I lose?" with something checkable.
 */
@Component({
  selector: 'app-cycles-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    ButtonModule,
    ConfirmDialogModule,
    DatePickerModule,
    DialogModule,
    MessageModule,
    TableModule,
    StatusPill,
    ViewStateHost,
  ],
  providers: [ConfirmationService],
  template: `
    <p-confirm-dialog />

    <header class="head">
      <h1 class="title">Ciclos y sorteos</h1>
      <p-button label="Nuevo ciclo" icon="pi pi-plus" size="small" (onClick)="openCreate()" />
    </header>

    @if (facade.error(); as e) {
      <p-message severity="error" styleClass="w-full">
        <b>{{ e.code }}</b> — {{ e.message }}
      </p-message>
    }

    @if (facade.runnable(); as c) {
      <section class="runnable">
        <div>
          <h2 class="runnable__title">{{ c.label }} está listo para sortear</h2>
          <p class="runnable__body">
            La inscripción está cerrada. Ejecutar el sorteo asigna los lugares, arma la lista
            de espera y pone el ciclo en curso. No se puede deshacer.
          </p>
        </div>
        <p-button
          label="Ejecutar sorteo"
          icon="pi pi-play"
          [loading]="facade.busy()"
          (onClick)="confirmRun(c)"
        />
      </section>
    }

    @if (facade.lastRun(); as run) {
      <section class="result">
        <h2 class="card__title">Último sorteo</h2>
        <div class="result__grid">
          <div><b>{{ run.entrants }}</b><span>participantes</span></div>
          <div><b>{{ run.assigned }}</b><span>asignados</span></div>
          <div><b>{{ run.waitlisted }}</b><span>en espera</span></div>
          <div><b>{{ run.state }}</b><span>estado</span></div>
        </div>
        <p class="result__seed">
          Semilla <code>{{ run.randomSeed }}</code> · algoritmo
          <code>{{ run.algorithmVersion }}</code>
          <small>
            Con la misma semilla y los mismos participantes, el sorteo da exactamente el
            mismo resultado. Eso es lo que lo hace auditable.
          </small>
        </p>
        <p-button
          label="Ver asignaciones"
          severity="secondary"
          size="small"
          [text]="true"
          (onClick)="loadAssignments(run.runId)"
        />

        @if (assignments().length > 0) {
          <p-table
            [value]="assignments()"
            styleClass="p-datatable-sm mt-2"
            [tableStyle]="{ 'min-width': '24rem' }"
          >
            <ng-template #header>
              <tr>
                <th scope="col">Residente</th>
                <th scope="col">Lugar</th>
              </tr>
            </ng-template>
            <ng-template #body let-a>
              <tr>
                <td>{{ a.fullName }}</td>
                <td class="strong">{{ a.spotCode }}</td>
              </tr>
            </ng-template>
          </p-table>
        }
      </section>
    }

    <app-view-state
      [state]="facade.state()"
      [skeletonCount]="4"
      emptyTitle="Todavía no hay ciclos"
      emptyBody="Un ciclo define el trimestre, la ventana de inscripción y el momento del sorteo."
      emptyActionLabel="Nuevo ciclo"
      (action)="openCreate()"
      (retry)="facade.refresh()"
    >
      <p-table
        [value]="[...facade.allCycles()]"
        styleClass="p-datatable-sm"
        [tableStyle]="{ 'min-width': '48rem' }"
      >
        <ng-template #header>
          <tr>
            <th scope="col">Ciclo</th>
            <th scope="col">Estado</th>
            <th scope="col">Vigencia</th>
            <th scope="col">Inscripción</th>
            <th scope="col"></th>
          </tr>
        </ng-template>

        <ng-template #body let-c>
          <tr>
            <td class="strong">{{ c.label }}</td>
            <td>
              @switch (c.state) {
                @case ('DRAFT') {
                  <app-status-pill label="Borrador" tone="muted" />
                }
                @case ('REGISTRATION_OPEN') {
                  <app-status-pill label="Inscripción abierta" tone="ok" />
                }
                @case ('REGISTRATION_CLOSED') {
                  <app-status-pill label="Listo para sortear" tone="warn" />
                }
                @case ('ACTIVE') {
                  <app-status-pill label="En curso" tone="ok" />
                }
                @default {
                  <app-status-pill label="Cerrado" tone="muted" />
                }
              }
            </td>
            <td>{{ c.startsOn | date: 'd MMM y' }} – {{ c.endsOn | date: 'd MMM y' }}</td>
            <td class="muted">
              {{ c.registrationOpensAt | date: 'd MMM' }} –
              {{ c.registrationClosesAt | date: 'd MMM' }}
            </td>
            <td class="actions">
              @switch (c.state) {
                @case ('DRAFT') {
                  <p-button
                    label="Abrir inscripción"
                    size="small"
                    [text]="true"
                    [loading]="facade.busy()"
                    (onClick)="facade.openRegistration(c.id)"
                  />
                }
                @case ('REGISTRATION_OPEN') {
                  <p-button
                    label="Cerrar inscripción"
                    size="small"
                    [text]="true"
                    severity="secondary"
                    [loading]="facade.busy()"
                    (onClick)="facade.closeRegistration(c.id)"
                  />
                }
                @default {
                  <span class="muted">—</span>
                }
              }
            </td>
          </tr>
        </ng-template>
      </p-table>
    </app-view-state>

    <p-dialog
      header="Nuevo ciclo"
      [(visible)]="createOpen"
      [modal]="true"
      [style]="{ width: '30rem' }"
      [draggable]="false"
    >
      <div class="form">
        <label for="nc-start">Comienza</label>
        <p-datepicker inputId="nc-start" [(ngModel)]="form.startsOn" dateFormat="dd/mm/yy" />

        <label for="nc-end">Termina</label>
        <p-datepicker inputId="nc-end" [(ngModel)]="form.endsOn" dateFormat="dd/mm/yy" />

        <label for="nc-open">Inscripción abre</label>
        <p-datepicker inputId="nc-open" [(ngModel)]="form.opensAt" dateFormat="dd/mm/yy" />

        <label for="nc-close">Inscripción cierra</label>
        <p-datepicker inputId="nc-close" [(ngModel)]="form.closesAt" dateFormat="dd/mm/yy" />

        <p class="hint">
          La etiqueta (por ejemplo 2026-Q2) se deriva de la fecha de inicio, así que dos
          administradores no pueden escribirla distinto.
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
      .card__title {
        margin: 0;
        font-size: 0.8rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        font-weight: 700;
        color: #6a6a6a;
      }
      .runnable {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1.5rem;
        flex-wrap: wrap;
        border: 2px solid #ddbd7e;
        background: #fbf6ec;
        border-radius: 12px;
        padding: 1rem 1.15rem;
      }
      .runnable__title {
        margin: 0;
        font-size: 1.02rem;
        font-weight: 660;
      }
      .runnable__body {
        margin: 0.3rem 0 0;
        font-size: 0.88rem;
        color: #5d5d5d;
        max-width: 58ch;
      }
      .result {
        border: 1px solid #9ec9b1;
        background: #f4faf6;
        border-radius: 12px;
        padding: 1rem 1.15rem;
      }
      .result__grid {
        display: flex;
        gap: 1.75rem;
        margin-top: 0.6rem;
        flex-wrap: wrap;
      }
      .result__grid div {
        display: flex;
        flex-direction: column;
      }
      .result__grid b {
        font-size: 1.3rem;
        line-height: 1;
      }
      .result__grid span {
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #7a7a7a;
        margin-top: 0.2rem;
      }
      .result__seed {
        margin: 0.8rem 0 0.4rem;
        font-size: 0.85rem;
      }
      .result__seed code {
        background: #e7f1ea;
        padding: 0.1rem 0.35rem;
        border-radius: 4px;
        user-select: all;
      }
      .result__seed small {
        display: block;
        margin-top: 0.35rem;
        color: #5d5d5d;
        max-width: 64ch;
        line-height: 1.45;
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
      .hint {
        margin: 0.7rem 0 0;
        font-size: 0.8rem;
        color: #6a6a6a;
        line-height: 1.45;
      }
    `,
  ],
})
export default class CyclesPage {
  readonly facade = inject(CyclesFacade);
  private readonly confirm = inject(ConfirmationService);

  readonly assignments = signal<RunAssignment[]>([]);

  createOpen = false;
  form: { startsOn: Date | null; endsOn: Date | null; opensAt: Date | null; closesAt: Date | null } = {
    startsOn: null,
    endsOn: null,
    opensAt: null,
    closesAt: null,
  };

  canSubmit(): boolean {
    const f = this.form;
    return Boolean(f.startsOn && f.endsOn && f.opensAt && f.closesAt);
  }

  openCreate(): void {
    this.form = { startsOn: null, endsOn: null, opensAt: null, closesAt: null };
    this.facade.dismissError();
    this.createOpen = true;
  }

  async submitCreate(): Promise<void> {
    const f = this.form;
    if (!f.startsOn || !f.endsOn || !f.opensAt || !f.closesAt) return;
    const r = await this.facade.create({
      startsOn: f.startsOn.toISOString().slice(0, 10),
      endsOn: f.endsOn.toISOString().slice(0, 10),
      registrationOpensAt: f.opensAt.toISOString(),
      registrationClosesAt: f.closesAt.toISOString(),
    });
    if (r) this.createOpen = false;
  }

  confirmRun(c: Cycle): void {
    this.confirm.confirm({
      header: `¿Ejecutar el sorteo de ${c.label}?`,
      message:
        'Se asignan los lugares, se arma la lista de espera y se actualizan los puntajes ' +
        'de equidad. La operación no se puede deshacer y queda en el historial de auditoría.',
      acceptLabel: 'Sí, sortear',
      rejectLabel: 'Cancelar',
      accept: async () => {
        this.assignments.set([]);
        await this.facade.executeRun(c.id);
        const run = this.facade.lastRun();
        if (run) await this.loadAssignments(run.runId);
      },
    });
  }

  async loadAssignments(runId: string): Promise<void> {
    this.assignments.set([...(await this.facade.assignmentsOf(runId))]);
  }
}
