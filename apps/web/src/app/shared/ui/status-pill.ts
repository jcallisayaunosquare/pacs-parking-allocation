import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type PillTone = 'held' | 'waiting' | 'attention' | 'revoked' | 'idle';

/**
 * A status marker that reads as a painted tag, not a rounded chip.
 *
 * Colour never carries the meaning on its own (NFR-13, WCAG 2.1 AA): the word is the
 * information and the tone reinforces it, so the state survives greyscale and
 * colour-blind vision. A left rule rather than a full outline, so a row of these does
 * not turn into a row of identical bubbles.
 *
 * `onDark` is for use inside the steel bay, where the washes would disappear.
 */
@Component({
  selector: 'app-status-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="tag" [class]="classes()" role="status">{{ label() }}</span>
  `,
  styles: [
    `
      .tag {
        display: inline-block;
        padding: 0.18rem 0.55rem;
        border-left: 3px solid currentColor;
        font-size: var(--t-fine);
        font-weight: 600;
        letter-spacing: 0.005em;
        white-space: nowrap;
      }

      .tag--held {
        color: var(--held);
        background: var(--held-wash);
      }
      .tag--waiting {
        color: var(--waiting-ink);
        background: var(--waiting-wash);
      }
      .tag--attention {
        color: var(--attention);
        background: var(--attention-wash);
      }
      .tag--revoked {
        color: var(--revoked);
        background: var(--revoked-wash);
      }
      .tag--idle {
        color: var(--idle);
        background: var(--idle-wash);
      }

      /* Inside the bay the washes vanish, so invert to the painted-line colour. */
      .tag--on-dark {
        background: transparent;
        color: var(--bay-line);
      }
      .tag--on-dark.tag--idle,
      .tag--on-dark.tag--waiting {
        color: var(--ink-2);
      }
    `,
  ],
})
export class StatusPill {
  readonly label = input.required<string>();
  readonly tone = input<PillTone>('idle');
  readonly onDark = input(false);

  readonly classes = computed(() =>
    `tag--${this.tone()}${this.onDark() ? ' tag--on-dark' : ''}`,
  );
}
