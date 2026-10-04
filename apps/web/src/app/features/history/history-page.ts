import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TableModule } from 'primeng/table';
import { DashboardFacade } from '../../application/dashboard.facade';
import { StatusPill } from '../../shared/ui/status-pill';
import { ViewStateHost } from '../../shared/ui/view-state';

/**
 * UC-10 — every past outcome and the score that produced it.
 *
 * The score column is the point of the screen: it is the snapshot taken at draw time
 * (§11), never recalculated, which is what lets a resident see why a past run went the
 * way it did instead of being told to trust it.
 */
@Component({
  selector: 'app-history-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, TableModule, StatusPill, ViewStateHost],
  template: `
    <header class="page__head">
      <h1 class="page__title">Tu historial</h1>
      <p class="page__sub">
        El puntaje mostrado es el que tenías en el momento del sorteo, no el actual.
      </p>
    </header>

    <app-view-state
      [state]="facade.historyState()"
      [skeletonCount]="4"
      emptyTitle="Todavía no participaste en un sorteo"
      emptyBody="En cuanto se ejecute el primer sorteo en el que estés anotado, el resultado va a aparecer acá con el puntaje que tenías."
      (retry)="facade.refresh()"
    >
      <p-table
        [value]="[...facade.history()]"
        [paginator]="facade.history().length > 10"
        [rows]="10"
        styleClass="p-datatable-sm"
        [tableStyle]="{ 'min-width': '34rem' }"
      >
        <ng-template #header>
          <tr>
            <th scope="col">Ciclo</th>
            <th scope="col">Resultado</th>
            <th scope="col">Lugar</th>
            <th scope="col" class="num">Puntaje al sortear</th>
            <th scope="col">Fecha</th>
          </tr>
        </ng-template>

        <ng-template #body let-h>
          <tr>
            <td class="cycle">{{ h.cycle }}</td>
            <td>
              @switch (h.result) {
                @case ('ASSIGNED') {
                  <app-status-pill label="Asignado" tone="ok" />
                }
                @case ('WAITLISTED') {
                  <app-status-pill [label]="'Lista de espera #' + h.position" tone="wait" />
                }
                @default {
                  <app-status-pill label="No participó" tone="muted" />
                }
              }
            </td>
            <td>{{ h.spotCode ?? '—' }}</td>
            <td class="num">{{ h.scoreAtDraw }}</td>
            <td>{{ h.recordedAt | date: 'd MMM y' }}</td>
          </tr>
        </ng-template>
      </p-table>
    </app-view-state>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .page__title {
        margin: 0;
        font-size: 1.35rem;
        font-weight: 680;
      }
      .page__sub {
        margin: 0.25rem 0 0;
        color: #5d5d5d;
        font-size: 0.88rem;
        max-width: 60ch;
      }
      .cycle {
        font-weight: 650;
      }
      .num {
        text-align: right;
      }
    `,
  ],
})
export default class HistoryPage {
  readonly facade = inject(DashboardFacade);
}
