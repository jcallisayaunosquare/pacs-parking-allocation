import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { dialogCovered } from './dialog-covered';
import type { ViewState } from '../../domain/models';
import { LoadingOverlay } from './loading-overlay';

/**
 * One component for the five states §17 requires of every screen, so no page has to
 * remember all five and none of them drifts apart from the others.
 *
 *   loading    bars shaped like the content under the spinner, so nothing jumps when
 *              it resolves
 *   empty      says what will appear here and what to do about it
 *   error      names what failed and offers the trace id support will ask for
 *   forbidden  a product state, not a crash
 *   ready      projects the content, under the spinner while it revalidates or while a
 *              change to it is being written
 *
 * Revalidating used to dim the content to half opacity. That was the only loading cue
 * on a reload, and it failed twice: half-opacity text is under the 4.5:1 floor WCAG 2.2
 * AA sets and PRODUCT.md makes non-negotiable, and a dimmed table does not say anything
 * is happening - it looks broken. The overlay keeps the rows recognisable underneath and
 * says what is being loaded.
 *
 * No boxes: these states are set off by a rule and whitespace, so a screen does not
 * become a grid of identical panels.
 */
@Component({
  selector: 'app-view-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, LoadingOverlay],
  template: `
    @switch (state().kind) {
      @case ('loading') {
        <app-loading-overlay [active]="true" [label]="loadingLabel()">
          <div class="bars" aria-hidden="true">
            @for (row of rows(); track row) {
              <span class="bars__row" [style.width.%]="80 - row * 9"></span>
            }
          </div>
        </app-loading-overlay>
      }

      @case ('empty') {
        <div class="note">
          <h3 class="note__h">{{ emptyTitle() }}</h3>
          <p class="note__p">{{ emptyBody() }}</p>
          @if (emptyActionLabel()) {
            <button matButton="outlined" type="button" (click)="action.emit()">
              {{ emptyActionLabel() }}
            </button>
          }
        </div>
      }

      @case ('forbidden') {
        <div class="note note--stop" role="alert">
          <h3 class="note__h">This page is for building administrators</h3>
          <p class="note__p">
            Your account does not have that permission. If it should, ask the building
            administration to grant it.
          </p>
        </div>
      }

      @case ('error') {
        <div class="note note--stop" role="alert">
          <h3 class="note__h">{{ errorTitle() }}</h3>
          <p class="note__p">{{ errorMessage() }}</p>
          <div class="note__row">
            <button matButton="filled" type="button" (click)="retry.emit()">Try again</button>
            @if (traceId()) {
              <button class="trace" type="button" (click)="copyTrace()">
                <span class="trace__label">Reference</span>
                <code>{{ traceId() }}</code>
                <span class="trace__hint">{{ copied() ? 'copied' : 'copy' }}</span>
              </button>
            }
          </div>
        </div>
      }

      @default {
        <app-loading-overlay
          [active]="(isStale() || busy()) && !covered()"
          [label]="activeLabel()"
        >
          <ng-content />
        </app-loading-overlay>
      }
    }
  `,
  styles: [
    `
      .bars {
        display: flex;
        flex-direction: column;
        gap: var(--sp-3);
        padding: var(--sp-2) 0;
      }
      .bars__row {
        height: 1.15rem;
        min-width: 6rem;
        background: var(--concrete-deep);
      }

      .note {
        border-left: 3px solid var(--rule);
        padding: var(--sp-1) 0 var(--sp-1) var(--sp-4);
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: var(--sp-2);
      }
      .note--stop {
        border-left-color: var(--revoked);
      }
      .note__h {
        font-size: var(--t-lead);
      }
      .note__p {
        color: var(--steel-soft);
        max-width: 56ch;
      }
      .note__row {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        flex-wrap: wrap;
        margin-top: var(--sp-1);
      }

      .trace {
        display: inline-flex;
        align-items: center;
        gap: var(--sp-2);
        background: var(--concrete-deep);
        border: 1px solid var(--rule);
        border-radius: 4px;
        padding: 0.3rem 0.5rem;
        cursor: pointer;
        color: var(--steel-soft);
        font-size: var(--t-fine);
      }
      .trace:hover {
        border-color: var(--steel-faint);
      }
      .trace code {
        color: var(--steel);
        user-select: all;
      }
      .trace__hint {
        color: var(--steel-faint);
      }
    `,
  ],
})
export class ViewStateHost {
  readonly state = input.required<ViewState>();
  readonly emptyTitle = input('Nothing here yet');
  readonly emptyBody = input('This section fills in once there is something to show.');
  readonly emptyActionLabel = input<string | null>(null);
  readonly skeletonCount = input(3);

  /**
   * A write to what this region shows is in flight - a save, a removal, a draw. Pass the
   * facade's `busy()`. The overlay covers the region so the rows a change is about to
   * alter cannot be acted on again until it has landed.
   */
  readonly busy = input(false);
  /** What the first load is fetching, in the screen's words. */
  readonly loadingLabel = input('Loading');
  /** What a write is doing, in the screen's words. */
  readonly busyLabel = input('Saving');

  /**
   * A dialog is open over this region.
   *
   * Then the write in flight is the dialog's, and the dialog's pressed button is already
   * showing it. A veil on the table behind the backdrop added a second loader nobody can
   * see - and, held for its minimum, one that was still there when the dialog closed,
   * which read as the form vanishing and a loader appearing in its place. The table is
   * reloaded inside the write, so by the time the dialog closes it is already current.
   */
  readonly covered = dialogCovered();

  /** A write outranks a revalidation: the reload that follows a save is part of it. */
  readonly activeLabel = computed(() => (this.busy() ? this.busyLabel() : 'Updating'));

  readonly retry = output<void>();
  readonly action = output<void>();

  /** A signal, not a field: a plain property would never re-render the label. */
  private readonly copiedAt = signal(0);

  readonly rows = computed(() => Array.from({ length: this.skeletonCount() }, (_, i) => i));

  readonly isStale = computed(() => {
    const s = this.state();
    return s.kind === 'ready' && s.stale;
  });

  readonly errorTitle = computed(() => {
    const s = this.state();
    if (s.kind !== 'error') return '';
    return s.error.status === 0 ? 'Cannot reach the server' : 'That did not load';
  });

  readonly errorMessage = computed(() => {
    const s = this.state();
    return s.kind === 'error' ? s.error.message : '';
  });

  readonly traceId = computed(() => {
    const s = this.state();
    return s.kind === 'error' ? s.error.traceId : null;
  });

  readonly copied = computed(() => Date.now() - this.copiedAt() < 2000);

  copyTrace(): void {
    const id = this.traceId();
    if (!id) return;
    void navigator.clipboard?.writeText(id);
    this.copiedAt.set(Date.now());
  }
}
