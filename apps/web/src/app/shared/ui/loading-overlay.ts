import {
  ChangeDetectionStrategy,
  Component,
  effect,
  input,
  signal,
  untracked,
} from '@angular/core';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

/**
 * How long a call has to run before the overlay is drawn.
 *
 * Most reads against the API come back in well under this, and an overlay that flashes on
 * for 80 ms and off again reads as a glitch rather than as feedback - worse than nothing.
 * Below this the person sees the result arrive; above it they see that it is coming.
 */
const SHOW_AFTER_MS = 200;
/**
 * Once drawn, how long it stays at least.
 *
 * The other half of the same problem: a call that finishes 210 ms in would otherwise show
 * the spinner for ten milliseconds. Holding it briefly makes "it was working" legible.
 */
const MIN_VISIBLE_MS = 400;

/**
 * A spinner over the content it is loading, for every API call a person waits on.
 *
 * Wraps the thing being loaded - a table, a dialog's form - rather than sitting anywhere
 * on the page, so it is always clear WHAT is busy: the register is reloading, this form is
 * saving. Projected content stays in the DOM and keeps its size while the overlay is up,
 * so nothing moves when it lifts: the board's columns never move, and a loader that
 * collapsed the table to draw itself would break that every time somebody saved.
 *
 * While it is up the content underneath is `inert`. That is the transaction guard, not
 * decoration: a second click on Save while the first is in flight is the double write
 * the idempotency keys exist to absorb, and it is better never sent.
 *
 * In the world's own materials: the veil is the ground at partial strength, not a grey
 * wash; the spinner is the signal colour, which is the colour this product spends on
 * action and nowhere else; no radius and no shadow on the veil. The label is printed,
 * not only announced - a spinner alone says "something" and the person needs "what".
 */
@Component({
  selector: 'app-loading-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatProgressSpinnerModule],
  template: `
    <div class="body" [attr.inert]="shown() ? '' : null" [attr.aria-busy]="active()">
      <ng-content />
    </div>

    @if (shown() && veil()) {
      <div class="veil">
        <div class="veil__in">
          <mat-progress-spinner mode="indeterminate" [diameter]="28" [strokeWidth]="3" />
          <p class="veil__l">{{ label() }}</p>
        </div>
      </div>
    }

    <!-- Announced whether or not the veil is drawn yet: the delay is visual only. -->
    <span class="sr-only" role="status">{{ active() ? label() : '' }}</span>
  `,
  styles: [
    `
      :host {
        display: block;
        position: relative;
        /* The spinner's colour, through Material's own token rather than an override
           of its internals. */
        --mat-progress-spinner-active-indicator-color: var(--signal);
      }

      /*
       * Over the content, never instead of it. The ground colour at partial strength, so
       * the rows underneath are still recognisably the rows - the person can see what is
       * being refreshed - while plainly not the thing to read right now.
       */
      .veil {
        position: absolute;
        inset: 0;
        z-index: 2;
        display: flex;
        justify-content: center;
        align-items: flex-start;
        background: color-mix(in srgb, var(--surface-2) 78%, transparent);
        animation: veil-in 140ms cubic-bezier(0.16, 1, 0.3, 1);
      }

      /*
       * Near the top rather than dead centre. A register can run to fifty rows; centred,
       * the spinner sits below the fold of a table nobody has scrolled, and the screen
       * looks idle while it is working. Sticky, so it follows a long scroll.
       */
      .veil__in {
        position: sticky;
        top: var(--sp-7);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--sp-3);
        padding: var(--sp-6) var(--sp-5);
      }

      .veil__l {
        margin: 0;
        font-size: var(--t-small);
        color: var(--ink-2);
      }

      @keyframes veil-in {
        from {
          opacity: 0;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .veil {
          animation: none;
        }
      }
    `,
  ],
})
export class LoadingOverlay {
  /** True while the call is in flight. The overlay itself is drawn on a delay. */
  readonly active = input(false);
  /** What is happening, in the product's words: "Saving the bay", "Loading residents". */
  readonly label = input('Loading');
  /**
   * Whether to draw the veil and spinner, or only to lock and announce.
   *
   * Off in a form. A short form under a veil puts a slab over the fields the person just
   * filled in and a spinner beside the button that is already saying "Adding…" - two
   * loaders for one action, neither where the eye is. In a form the pressed button
   * carries the spinner (`.is-pending`) and this only keeps the fields from being edited
   * mid-save.
   */
  readonly veil = input(true);

  /** Whether the veil is on screen - `active` with the delay and the minimum applied. */
  readonly shown = signal(false);

  private shownAt = 0;

  constructor() {
    effect((onCleanup) => {
      const on = this.active();
      untracked(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        if (on && !this.shown()) {
          timer = setTimeout(() => {
            this.shownAt = Date.now();
            this.shown.set(true);
          }, SHOW_AFTER_MS);
        } else if (!on && this.shown()) {
          const left = MIN_VISIBLE_MS - (Date.now() - this.shownAt);
          timer = setTimeout(() => this.shown.set(false), Math.max(0, left));
        }
        onCleanup(() => {
          if (timer !== null) clearTimeout(timer);
        });
      });
    });
  }
}
