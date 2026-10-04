import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import type { ViewState } from '../../domain/models';

/**
 * One component for the five states §17 requires of every screen, so no page has to
 * remember all five and none of them drifts.
 *
 *   loading    skeletons shaped like the content, never a centred spinner that shifts
 *              the layout when it resolves
 *   empty      says what will appear here and when
 *   error      names what failed and what to do, with a copyable trace id
 *   forbidden  a product state, not a crash
 *   ready      projects the content; when `stale` it dims rather than flashing empty
 *
 * The ready content is projected, so the page keeps owning its own markup.
 */
@Component({
  selector: 'app-view-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule, SkeletonModule],
  template: `
    @switch (state().kind) {
      @case ('loading') {
        <div class="skeletons" [attr.aria-busy]="true" aria-live="polite">
          @for (row of skeletonRows(); track row) {
            <p-skeleton height="3.25rem" styleClass="mb-2" />
          }
          <span class="sr-only">Cargando…</span>
        </div>
      }

      @case ('empty') {
        <div class="state state--empty">
          <i class="pi pi-inbox state__icon" aria-hidden="true"></i>
          <h3 class="state__title">{{ emptyTitle() }}</h3>
          <p class="state__body">{{ emptyBody() }}</p>
          @if (emptyActionLabel()) {
            <p-button
              [label]="emptyActionLabel()!"
              severity="secondary"
              size="small"
              (onClick)="action.emit()"
            />
          }
        </div>
      }

      @case ('forbidden') {
        <div class="state state--forbidden" role="alert">
          <i class="pi pi-lock state__icon" aria-hidden="true"></i>
          <h3 class="state__title">Esta sección es solo para administradores</h3>
          <p class="state__body">
            Tu cuenta no tiene ese permiso. Si creés que debería, hablá con la administración
            del edificio.
          </p>
        </div>
      }

      @case ('error') {
        <div class="state state--error" role="alert">
          <i class="pi pi-exclamation-triangle state__icon" aria-hidden="true"></i>
          <h3 class="state__title">{{ errorTitle() }}</h3>
          <p class="state__body">{{ errorMessage() }}</p>
          @if (traceId()) {
            <p class="state__trace">
              Código de seguimiento:
              <code>{{ traceId() }}</code>
              <p-button
                icon="pi pi-copy"
                severity="secondary"
                [text]="true"
                size="small"
                ariaLabel="Copiar código de seguimiento"
                (onClick)="copyTrace()"
              />
            </p>
          }
          <p-button label="Reintentar" icon="pi pi-refresh" size="small" (onClick)="retry.emit()" />
        </div>
      }

      @default {
        <div [class.stale]="isStale()" [attr.aria-busy]="isStale()">
          <ng-content />
        </div>
      }
    }
  `,
  styles: [
    `
      .state {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.6rem;
        padding: 2.5rem 1.25rem;
        text-align: center;
        border: 1px dashed var(--p-content-border-color, #d7d7d7);
        border-radius: 12px;
        background: var(--p-content-background, #fff);
      }
      .state__icon {
        font-size: 1.75rem;
        opacity: 0.55;
      }
      .state__title {
        margin: 0;
        font-size: 1.02rem;
        font-weight: 650;
      }
      .state__body {
        margin: 0;
        max-width: 46ch;
        color: var(--p-text-muted-color, #5d5d5d);
        font-size: 0.9rem;
        line-height: 1.5;
      }
      .state__trace {
        margin: 0;
        font-size: 0.8rem;
        display: flex;
        align-items: center;
        gap: 0.35rem;
      }
      .state__trace code {
        background: #f1f1f1;
        padding: 0.1rem 0.35rem;
        border-radius: 4px;
        user-select: all;
      }
      .state--error {
        border-style: solid;
        border-color: #dba694;
      }
      /* Revalidating: keep the old value, dimmed. Never a flash of empty content. */
      .stale {
        opacity: 0.55;
        transition: opacity 120ms ease-out;
      }
      .skeletons {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
      }
    `,
  ],
})
export class ViewStateHost {
  readonly state = input.required<ViewState>();
  readonly emptyTitle = input('Todavía no hay nada acá');
  readonly emptyBody = input('Cuando haya información para mostrar, va a aparecer en esta sección.');
  readonly emptyActionLabel = input<string | null>(null);
  readonly skeletonCount = input(3);

  readonly retry = output<void>();
  readonly action = output<void>();

  readonly skeletonRows = computed(() => Array.from({ length: this.skeletonCount() }, (_, i) => i));
  readonly isStale = computed(() => {
    const s = this.state();
    return s.kind === 'ready' && s.stale;
  });

  readonly errorTitle = computed(() => {
    const s = this.state();
    if (s.kind !== 'error') return '';
    return s.error.status === 0 ? 'Sin conexión con el servidor' : 'No se pudo cargar';
  });

  readonly errorMessage = computed(() => {
    const s = this.state();
    return s.kind === 'error' ? s.error.message : '';
  });

  readonly traceId = computed(() => {
    const s = this.state();
    return s.kind === 'error' ? s.error.traceId : null;
  });

  copyTrace(): void {
    const id = this.traceId();
    if (id) void navigator.clipboard?.writeText(id);
  }
}
