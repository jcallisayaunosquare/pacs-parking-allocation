import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageModule } from 'primeng/message';
import { ConfirmationService } from 'primeng/api';
import { DashboardFacade } from '../../application/dashboard.facade';
import { StatusPill } from '../../shared/ui/status-pill';
import { ViewStateHost } from '../../shared/ui/view-state';
import { FairnessExplainer } from '../../shared/ui/fairness-explainer';

/**
 * The resident dashboard — §17's three states in one layout:
 * holds a spot, on the waitlist, registration open.
 *
 * One page-level query feeds presentational children; no child fetches on its own.
 * The status card is `aria-live="polite"` so a screen reader announces a changed
 * allocation, and every irreversible action goes through a confirm dialog.
 */
@Component({
  selector: 'app-dashboard-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    RouterLink,
    ButtonModule,
    ConfirmDialogModule,
    MessageModule,
    StatusPill,
    ViewStateHost,
    FairnessExplainer,
  ],
  providers: [ConfirmationService],
  template: `
    <p-confirm-dialog />

    <header class="page__head">
      <div>
        <h1 class="page__title">Tu estacionamiento</h1>
        @if (facade.resident(); as r) {
          <p class="page__sub">{{ r.fullName }} · unidad {{ r.unit }}</p>
        }
      </div>
      <p-button
        icon="pi pi-refresh"
        severity="secondary"
        [text]="true"
        ariaLabel="Actualizar"
        [disabled]="facade.busy()"
        (onClick)="facade.refresh()"
      />
    </header>

    @if (facade.mutationError(); as err) {
      <p-message severity="error" styleClass="w-full mb-3">
        {{ err.message }}
        @if (err.traceId) {
          <small class="trace"> ({{ err.traceId }})</small>
        }
      </p-message>
    }

    <app-view-state
      [state]="facade.state()"
      [skeletonCount]="3"
      emptyTitle="Todavía no tenés actividad"
      emptyBody="Cuando se abra la inscripción del próximo trimestre vas a poder anotarte desde acá."
      (retry)="facade.refresh()"
    >
      <!-- Status card: switches on assignment | waitlist | open | closed -->
      <section class="card status" aria-live="polite" aria-atomic="true">
        @switch (facade.situation()) {
          @case ('holds-spot') {
            @if (facade.assignment(); as a) {
              <div class="status__row">
                <span class="status__spot">{{ a.spotCode }}</span>
                <span class="status__meta">
                  Nivel {{ a.level }} · {{ typeLabel(a.type) }}
                </span>
                <app-status-pill label="Activo" tone="ok" />
              </div>
              <p class="status__line">
                Tuyo hasta el {{ a.validUntil | date: 'd MMMM y' }}
              </p>
              <div class="status__actions">
                <p-button
                  label="Liberar este lugar"
                  icon="pi pi-sign-out"
                  severity="danger"
                  [outlined]="true"
                  size="small"
                  [loading]="facade.busy()"
                  (onClick)="confirmRelease()"
                />
              </div>
            }
          }

          @case ('waitlisted') {
            @if (facade.waitlist(); as w) {
              <div class="status__row">
                <span class="status__spot">#{{ w.position }}</span>
                <span class="status__meta">en la lista de espera</span>
                <app-status-pill label="Esperando" tone="wait" />
              </div>
              <p class="status__line">
                Te avisamos en cuanto se libere un lugar. No hace falta hacer nada.
              </p>
            }
          }

          @case ('registration-open') {
            @if (facade.nextCycle(); as c) {
              <div class="status__row">
                <span class="status__spot">{{ c.label }}</span>
                <span class="status__meta">inscripción abierta</span>
                <app-status-pill label="Abierta" tone="ok" />
              </div>
              <p class="status__line">
                Cierra el {{ c.registrationClosesAt | date: 'd MMMM' }}
                @if (daysLeft(c.registrationClosesAt) !== null) {
                  · faltan {{ daysLeft(c.registrationClosesAt) }}
                  {{ daysLeft(c.registrationClosesAt) === 1 ? 'día' : 'días' }}
                }
              </p>
              <div class="status__actions">
                @if (facade.registered()) {
                  <app-status-pill label="Ya estás anotado" tone="ok" />
                  <p-button
                    label="Retirarme"
                    severity="secondary"
                    [text]="true"
                    size="small"
                    [loading]="facade.busy()"
                    (onClick)="confirmWithdraw()"
                  />
                } @else if (facade.canRegister()) {
                  <p-button
                    label="Entrar al sorteo"
                    icon="pi pi-ticket"
                    [loading]="facade.busy()"
                    (onClick)="facade.register()"
                  />
                } @else {
                  <app-status-pill label="No elegible" tone="bad" />
                  <small class="status__note">
                    Hablá con la administración para resolverlo.
                  </small>
                }
              </div>
            }
          }

          @default {
            <div class="status__row">
              <span class="status__meta">Sin ciclo abierto en este momento</span>
              <app-status-pill label="Inactivo" tone="muted" />
            </div>
            <p class="status__line">
              Cuando la administración abra el próximo trimestre vas a verlo acá.
            </p>
          }
        }
      </section>

      @if (facade.nextCycle(); as c) {
        <section class="card next">
          <h2 class="card__title">Próximo ciclo · {{ c.label }}</h2>
          <dl class="next__grid">
            <div>
              <dt>Abre</dt>
              <dd>{{ c.registrationOpensAt | date: 'd MMM' }}</dd>
            </div>
            <div>
              <dt>Cierra</dt>
              <dd>{{ c.registrationClosesAt | date: 'd MMM' }}</dd>
            </div>
            <div>
              <dt>Vigencia</dt>
              <dd>{{ c.startsOn | date: 'd MMM' }} – {{ c.endsOn | date: 'd MMM' }}</dd>
            </div>
          </dl>
        </section>
      }

      @if (facade.fairness(); as f) {
        <app-fairness-explainer [fairness]="f" />
      }

      <section class="card recent">
        <div class="recent__head">
          <h2 class="card__title">Historial reciente</h2>
          <a routerLink="/history" class="recent__all">Ver todo</a>
        </div>
        @if (recent().length === 0) {
          <p class="recent__empty">
            Todavía no participaste en un sorteo. Tu primer resultado va a aparecer acá.
          </p>
        } @else {
          <ul class="recent__list">
            @for (h of recent(); track h.cycle + h.recordedAt.toISOString()) {
              <li class="recent__item">
                <span class="recent__cycle">{{ h.cycle }}</span>
                @switch (h.result) {
                  @case ('ASSIGNED') {
                    <app-status-pill [label]="'Ganaste ' + h.spotCode" tone="ok" />
                  }
                  @case ('WAITLISTED') {
                    <app-status-pill [label]="'Lista de espera #' + h.position" tone="wait" />
                  }
                  @default {
                    <app-status-pill label="No participaste" tone="muted" />
                  }
                }
                <span class="recent__score">puntaje {{ h.scoreAtDraw }}</span>
              </li>
            }
          </ul>
        }
      </section>
    </app-view-state>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .page__head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
      }
      .page__title {
        margin: 0;
        font-size: 1.35rem;
        font-weight: 680;
      }
      .page__sub {
        margin: 0.2rem 0 0;
        color: #5d5d5d;
        font-size: 0.88rem;
      }
      .card {
        border: 1px solid var(--p-content-border-color, #dcdcdc);
        border-radius: 12px;
        padding: 1.05rem 1.15rem;
        background: #fff;
      }
      .card__title {
        margin: 0;
        font-size: 0.8rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        font-weight: 700;
        color: #6a6a6a;
      }
      .status {
        border-width: 2px;
        border-color: #c9c3b8;
      }
      .status__row {
        display: flex;
        align-items: baseline;
        gap: 0.75rem;
        flex-wrap: wrap;
      }
      .status__spot {
        font-size: 1.7rem;
        font-weight: 720;
        letter-spacing: -0.01em;
        line-height: 1;
      }
      .status__meta {
        color: #5d5d5d;
        font-size: 0.9rem;
      }
      .status__line {
        margin: 0.6rem 0 0;
        font-size: 0.95rem;
      }
      .status__actions {
        margin-top: 0.9rem;
        display: flex;
        align-items: center;
        gap: 0.65rem;
        flex-wrap: wrap;
      }
      .status__note {
        color: #6a6a6a;
      }
      .next__grid {
        display: flex;
        gap: 2rem;
        margin: 0.7rem 0 0;
        flex-wrap: wrap;
      }
      .next__grid dt {
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #7a7a7a;
      }
      .next__grid dd {
        margin: 0.15rem 0 0;
        font-weight: 600;
      }
      .recent__head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
      }
      .recent__all {
        font-size: 0.82rem;
      }
      .recent__list {
        list-style: none;
        margin: 0.7rem 0 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .recent__item {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        flex-wrap: wrap;
      }
      .recent__cycle {
        font-weight: 650;
        min-width: 4.5rem;
      }
      .recent__score {
        color: #7a7a7a;
        font-size: 0.8rem;
      }
      .recent__empty {
        margin: 0.7rem 0 0;
        color: #6a6a6a;
        font-size: 0.9rem;
      }
      .trace {
        opacity: 0.7;
      }
    `,
  ],
})
export default class DashboardPage {
  readonly facade = inject(DashboardFacade);
  private readonly confirm = inject(ConfirmationService);

  readonly recent = computed(() => this.facade.value()?.recentHistory ?? []);

  typeLabel(t: string): string {
    return t === 'ACCESSIBLE' ? 'Accesible' : t === 'EV' ? 'Eléctrico' : 'Estándar';
  }

  /** Null rather than a negative number once the date has passed. */
  daysLeft(at: Date): number | null {
    const ms = at.getTime() - Date.now();
    return ms <= 0 ? null : Math.ceil(ms / 86_400_000);
  }

  confirmRelease(): void {
    this.confirm.confirm({
      header: '¿Liberar tu lugar?',
      message:
        'El lugar pasa a la primera persona de la lista de espera y no podés recuperarlo ' +
        'hasta el próximo sorteo. Tu puntaje de equidad no cambia.',
      acceptLabel: 'Sí, liberarlo',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => void this.facade.releaseSpot(),
    });
  }

  confirmWithdraw(): void {
    this.confirm.confirm({
      header: '¿Retirarte del sorteo?',
      message: 'Podés volver a anotarte mientras la inscripción siga abierta.',
      acceptLabel: 'Sí, retirarme',
      rejectLabel: 'Cancelar',
      accept: () => void this.facade.withdraw(),
    });
  }
}
