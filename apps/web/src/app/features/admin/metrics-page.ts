import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { FormsModule } from '@angular/forms';
import { signal } from '@angular/core';
import { CyclesFacade, MetricsFacade } from '../../application/admin.facades';
import { ViewStateHost } from '../../shared/ui/view-state';

/**
 * Admin — fairness dashboard (FR-22, §17).
 *
 * The distribution is the honest picture of whether the raffle is working: a healthy
 * building has most residents at a low score and a short tail. A long tail means
 * someone has been losing for years, which is exactly what the weighting is supposed
 * to prevent — so the maximum score and the never-won count are called out separately
 * rather than averaged away.
 */
@Component({
  selector: 'app-metrics-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule, SelectModule, FormsModule, ViewStateHost],
  template: `
    <header class="head">
      <h1 class="title">Equidad</h1>
      <p-button
        icon="pi pi-refresh"
        severity="secondary"
        [text]="true"
        ariaLabel="Actualizar"
        (onClick)="facade.refresh()"
      />
    </header>

    <app-view-state
      [state]="facade.state()"
      [skeletonCount]="3"
      emptyTitle="Sin datos de equidad todavía"
      emptyBody="Los puntajes aparecen después del primer sorteo. Hasta entonces todos los residentes empiezan en 0."
      (retry)="facade.refresh()"
    >
      @if (facade.value(); as m) {
        <section class="stats">
          <div class="stat">
            <b>{{ m.residents }}</b>
            <span>residentes activos</span>
          </div>
          <div class="stat">
            <b>{{ m.averageScore }}</b>
            <span>puntaje promedio</span>
          </div>
          <div class="stat" [class.stat--alert]="m.maxScore >= 8">
            <b>{{ m.maxScore }}</b>
            <span>puntaje máximo</span>
          </div>
          <div class="stat">
            <b>{{ m.neverWon }}</b>
            <span>nunca ganaron</span>
          </div>
        </section>

        @if (m.maxScore >= 8) {
          <p class="alert">
            Alguien acumula {{ m.maxScore }} ciclos sin ganar. Con peso
            {{ m.maxScore + 1 }} ya tiene {{ m.maxScore + 1 }}× las probabilidades de
            quien ganó recién, pero vale revisar si la cantidad de lugares alcanza para
            el edificio.
          </p>
        }

        <section class="dist">
          <h2 class="card__title">Distribución de puntajes</h2>
          <p class="dist__hint">
            Cada barra es la cantidad de residentes con ese puntaje. El peso en el sorteo
            es el puntaje más uno.
          </p>
          <ul class="dist__list">
            @for (d of facade.distribution(); track d.score) {
              <li class="dist__row">
                <span class="dist__score">{{ d.score }}</span>
                <span class="dist__bar" [style.width.%]="d.percent" aria-hidden="true"></span>
                <span class="dist__count">
                  {{ d.residents }}
                  {{ d.residents === 1 ? 'residente' : 'residentes' }}
                  <small>· peso {{ d.score + 1 }}</small>
                </span>
              </li>
            }
          </ul>
        </section>
      }
    </app-view-state>

    <section class="export">
      <h2 class="card__title">Exportar reporte trimestral</h2>
      <p class="dist__hint">UC-07 — una fila por participante del ciclo, en CSV.</p>
      <div class="export__row">
        <p-select
          [options]="cycleOptions()"
          optionLabel="label"
          optionValue="value"
          placeholder="Elegí un ciclo"
          [(ngModel)]="selectedCycle"
          ariaLabel="Ciclo a exportar"
        />
        <p-button
          label="Descargar CSV"
          icon="pi pi-download"
          severity="secondary"
          size="small"
          [disabled]="!selectedCycle()"
          (onClick)="download()"
        />
      </div>
    </section>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
      }
      .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
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
      .stats {
        display: flex;
        gap: 2rem;
        flex-wrap: wrap;
      }
      .stat {
        display: flex;
        flex-direction: column;
      }
      .stat b {
        font-size: 1.75rem;
        line-height: 1;
      }
      .stat span {
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #7a7a7a;
        margin-top: 0.25rem;
      }
      .stat--alert b {
        color: #7c2d14;
      }
      .alert {
        margin: 0;
        padding: 0.75rem 1rem;
        border-radius: 10px;
        background: #fbf0dc;
        border: 1px solid #ddbd7e;
        color: #6b4708;
        font-size: 0.88rem;
        line-height: 1.5;
        max-width: 76ch;
      }
      .dist__hint {
        margin: 0.3rem 0 0;
        font-size: 0.82rem;
        color: #6a6a6a;
        max-width: 64ch;
      }
      .dist__list {
        list-style: none;
        margin: 0.9rem 0 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }
      .dist__row {
        display: grid;
        grid-template-columns: 2rem 1fr auto;
        align-items: center;
        gap: 0.75rem;
      }
      .dist__score {
        text-align: right;
        font-variant-numeric: tabular-nums;
        font-weight: 650;
      }
      .dist__bar {
        height: 0.85rem;
        min-width: 2px;
        background: linear-gradient(90deg, #2c6b4a, #5d9b78);
        border-radius: 3px;
      }
      .dist__count {
        font-size: 0.82rem;
        color: #5d5d5d;
        white-space: nowrap;
      }
      .dist__count small {
        color: #8a8a8a;
      }
      .export {
        border-top: 1px solid #e3e3e3;
        padding-top: 1.1rem;
      }
      .export__row {
        display: flex;
        gap: 0.7rem;
        align-items: center;
        margin-top: 0.7rem;
        flex-wrap: wrap;
      }
    `,
  ],
})
export default class MetricsPage {
  readonly facade = inject(MetricsFacade);
  private readonly cycles = inject(CyclesFacade);

  readonly selectedCycle = signal<string | null>(null);

  readonly cycleOptions = computed(() =>
    this.cycles.allCycles().map((c) => ({ label: c.label, value: c.id })),
  );

  async download(): Promise<void> {
    const id = this.selectedCycle();
    if (!id) return;
    const label = this.cycles.allCycles().find((c) => c.id === id)?.label ?? id;
    await this.facade.downloadQuarterlyCsv(id, label);
  }
}
