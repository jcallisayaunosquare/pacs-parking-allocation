import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type PillTone = 'ok' | 'wait' | 'warn' | 'bad' | 'muted';

/**
 * A status pill that pairs colour with a word.
 *
 * §17's accessibility rule: no meaning is carried by colour alone (NFR-13, WCAG 2.1
 * AA). The label is the information; the tone only reinforces it. An icon is included
 * so the distinction also survives greyscale printing and colour-blind vision.
 */
@Component({
  selector: 'app-status-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="pill" [class]="'pill--' + tone()" role="status">
      <i class="pill__icon" [class]="icon()" aria-hidden="true"></i>
      <span class="pill__label">{{ label() }}</span>
    </span>
  `,
  styles: [
    `
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.2rem 0.65rem;
        border-radius: 999px;
        font-size: 0.78rem;
        font-weight: 600;
        letter-spacing: 0.02em;
        border: 1px solid transparent;
        white-space: nowrap;
      }
      .pill__icon {
        font-size: 0.7rem;
      }
      /* Contrast ratios here are all >= 4.5:1 against their background. */
      .pill--ok {
        background: #e2f0e8;
        color: #1d5438;
        border-color: #9ec9b1;
      }
      .pill--wait {
        background: #e7eef8;
        color: #22456f;
        border-color: #a8c0dd;
      }
      .pill--warn {
        background: #fbf0dc;
        color: #6b4708;
        border-color: #ddbd7e;
      }
      .pill--bad {
        background: #f8e2db;
        color: #7c2d14;
        border-color: #dba694;
      }
      .pill--muted {
        background: #ececec;
        color: #4a4a4a;
        border-color: #c8c8c8;
      }
    `,
  ],
})
export class StatusPill {
  readonly label = input.required<string>();
  readonly tone = input<PillTone>('muted');

  readonly icon = computed(() => {
    switch (this.tone()) {
      case 'ok':
        return 'pi pi-check-circle';
      case 'wait':
        return 'pi pi-clock';
      case 'warn':
        return 'pi pi-exclamation-triangle';
      case 'bad':
        return 'pi pi-times-circle';
      default:
        return 'pi pi-minus-circle';
    }
  });
}
