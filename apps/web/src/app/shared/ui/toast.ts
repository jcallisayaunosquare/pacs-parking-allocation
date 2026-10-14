import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  effect,
  inject,
  signal,
  untracked,
  type EffectRef,
  type Signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import type { ApiError } from '../../domain/models';
import { dialogCovered } from './dialog-covered';

/*
 * How long a toast stays, unpaused: 5000 ms, long enough to read a two-line refusal
 * twice. It lives in the bar's CSS animation (.toast__bar), whose end dismisses it.
 */
/** More than this and the stack covers the page it is reporting on; the oldest go first. */
const MAX_VISIBLE = 4;

export interface Toast {
  readonly id: number;
  readonly tone: 'error' | 'info';
  readonly message: string;
  /** The server's trace id, which is what support asks for. */
  readonly reference: string | null;
}

/**
 * The notices that are not about a form.
 *
 * A refusal from a row action - removing a period the record still names, closing a bay
 * someone holds - used to land as a banner at the top of the page, above a table the
 * person had scrolled down to act on. They pressed a menu item in row 30 and the answer
 * appeared out of sight. A toast comes to where the eye can find it, the corner, and goes
 * by itself once read.
 *
 * Errors inside a dialog stay in the dialog: there the answer belongs beside the fields
 * that caused it.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly _toasts = signal<readonly Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();
  private next = 1;

  error(message: string, reference: string | null = null): void {
    this.push({ tone: 'error', message, reference });
  }

  info(message: string): void {
    this.push({ tone: 'info', message, reference: null });
  }

  dismiss(id: number): void {
    this._toasts.update((list) => list.filter((t) => t.id !== id));
  }

  private push(t: Omit<Toast, 'id'>): void {
    const toast: Toast = { ...t, id: this.next++ };
    this._toasts.update((list) => [...list, toast].slice(-MAX_VISIBLE));
  }
}

/**
 * Route a facade's error to a toast instead of a page banner. Call from an injection
 * context - a page's constructor or field initializer.
 *
 * Only while no dialog is open over the page: a dialog's error is its own and it shows
 * it inline. The facade's error is cleared once toasted, so it is not shown again the
 * next time something re-reads it.
 */
export function toastFacadeErrors(source: {
  readonly error: Signal<ApiError | null>;
  dismissError(): void;
}): EffectRef {
  const toasts = inject(ToastService);
  const covered = dialogCovered();
  return effect(() => {
    const e = source.error();
    if (!e || covered()) return;
    untracked(() => {
      toasts.error(e.message, e.traceId ?? null);
      source.dismissError();
    });
  });
}

/**
 * The stack, bottom right. One instance, in the shell.
 *
 * Newest at the bottom, nearest the corner, the way a stack grows. Each toast pauses its
 * countdown while it is pointed at or focused - WCAG 2.2.1: content that disappears on a
 * timer must let a person stop it - and the bar along its foot says how long is left.
 */
@Component({
  selector: 'app-toast-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  template: `
    <section class="stack" aria-label="Notifications">
      @for (t of service.toasts(); track t.id) {
        <div
          class="toast"
          [class.toast--error]="t.tone === 'error'"
          [attr.role]="t.tone === 'error' ? 'alert' : 'status'"
          animate.leave="toast--out"
          (mouseenter)="pause(t.id)"
          (mouseleave)="resume(t.id)"
          (focusin)="pause(t.id)"
          (focusout)="resume(t.id)"
        >
          <!-- The message alone. The trace id is kept on the toast, not printed on it. -->
          <p class="toast__m">{{ t.message }}</p>
          <button
            class="toast__x"
            type="button"
            aria-label="Dismiss notification"
            (click)="service.dismiss(t.id)"
          >
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
          <span
            class="toast__bar"
            aria-hidden="true"
            [class.toast__bar--paused]="paused().has(t.id)"
            (animationend)="service.dismiss(t.id)"
          ></span>
        </div>
      }
    </section>
  `,
  styles: [
    `
      .stack {
        position: fixed;
        right: var(--sp-5);
        bottom: var(--sp-5);
        z-index: 1100;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: var(--sp-2);
        width: min(24rem, calc(100vw - 2 * var(--sp-4)));
        pointer-events: none;
      }

      /*
       * A solid surface with a hairline frame. No shadow: depth in this world is by layer
       * and ground value, and the toast already sits on the top layer.
       */
      .toast {
        position: relative;
        width: 100%;
        padding: var(--sp-3) var(--sp-7) var(--sp-3) var(--sp-4);
        background: var(--surface-1);
        border: 1px solid var(--rule);
        border-radius: 3px;
        color: var(--ink-1);
        overflow: hidden;
        pointer-events: auto;
        animation: toast-in 260ms cubic-bezier(0.16, 1, 0.3, 1);
      }

      /* An error is told by its frame and its bar, in the colour that means refused. */
      .toast--error {
        border-color: var(--revoked);
      }

      .toast__m {
        margin: 0;
        font-size: var(--t-fine);
        line-height: 1.45;
      }

      .toast__x {
        position: absolute;
        top: var(--sp-1);
        right: var(--sp-1);
        display: inline-grid;
        place-items: center;
        width: 2.25rem;
        height: 2.25rem;
        padding: 0;
        border: 0;
        border-radius: 3px;
        background: transparent;
        color: var(--ink-3);
        cursor: pointer;
      }

      .toast__x mat-icon {
        width: 18px;
        height: 18px;
        font-size: 18px;
      }

      @media (hover: hover) and (pointer: fine) {
        .toast__x:hover {
          background: var(--surface-3);
          color: var(--ink-1);
        }
      }

      .toast__x:focus-visible {
        outline: 2px solid var(--signal);
        outline-offset: 1px;
      }

      /* Time left, as a bar that shrinks along the foot. Its end is what dismisses it. */
      .toast__bar {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 3px;
        background: var(--ink-3);
        transform-origin: left center;
        /* LIFETIME_MS. In CSS because the bar's end is the timer. */
        animation: toast-time 5000ms linear forwards;
      }

      .toast--error .toast__bar {
        background: var(--revoked);
      }

      .toast__bar--paused {
        animation-play-state: paused;
      }

      .toast--out {
        animation: toast-out 180ms ease-in forwards;
      }

      @keyframes toast-in {
        from {
          opacity: 0;
          transform: translateY(12px);
        }
      }

      @keyframes toast-out {
        to {
          opacity: 0;
          transform: translateX(16px);
        }
      }

      @keyframes toast-time {
        to {
          transform: scaleX(0);
        }
      }

      @media (max-width: 40rem) {
        .stack {
          right: var(--sp-4);
          bottom: var(--sp-4);
        }
      }

      /*
       * With motion reduced the entrance and exit go; the countdown does not, because it
       * is the timer itself. styles.scss shortens every animation to 0.01ms !important
       * under this preference, which would dismiss a toast the instant it appeared - so
       * the bar takes its five seconds back here, at a specificity that beats the
       * global '*', and is hidden rather than shown moving.
       */
      @media (prefers-reduced-motion: reduce) {
        .toast,
        .toast--out {
          animation: none;
        }
        .toast__bar {
          opacity: 0;
          animation-duration: 5000ms !important;
        }
      }
    `,
  ],
})
export class ToastHost {
  readonly service = inject(ToastService);
  readonly paused = signal<ReadonlySet<number>>(new Set());

  pause(id: number): void {
    this.paused.update((s) => new Set(s).add(id));
  }

  resume(id: number): void {
    this.paused.update((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }
}
