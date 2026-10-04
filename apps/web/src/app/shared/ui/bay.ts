import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { StatusPill, type PillTone } from './status-pill';

export type BayVariant = 'held' | 'waiting' | 'open' | 'closed';

/**
 * A parking bay, drawn as one.
 *
 * This is the only bold element in the product, and it carries the resident screen:
 * the answer to "do I have a spot?" should be legible from across the room. The form
 * encodes the state rather than decorating it —
 *
 *   held     painted steel with a yellow boundary line: the space is yours
 *   waiting  the same block, line dimmed to grey: a place in the queue, not a space
 *   open     unpainted concrete inside a dashed outline: a bay nobody has been given
 *   closed   flat and quiet: nothing is allocated right now
 *
 * Square corners throughout, because paint has square corners, and no shadow, because
 * concrete is matte. The code is set in the stencil treatment from styles.scss.
 */
@Component({
  selector: 'app-bay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusPill],
  template: `
    <section class="bay" [class]="'bay--' + variant()" [attr.aria-label]="label()">
      <span class="bay__line" aria-hidden="true"></span>

      <div class="bay__body">
        <div class="bay__top">
          <p class="bay__code stencil" [class.bay__code--small]="longCode()">{{ code() }}</p>
          @if (status()) {
            <app-status-pill
              [label]="status()!"
              [tone]="statusTone()"
              [onDark]="variant() === 'held' || variant() === 'waiting'"
            />
          }
        </div>

        @if (caption()) {
          <p class="bay__caption">{{ caption() }}</p>
        }
        @if (note()) {
          <p class="bay__note">{{ note() }}</p>
        }

        <div class="bay__actions"><ng-content /></div>
      </div>
    </section>
  `,
  styles: [
    `
      .bay {
        display: flex;
        align-items: stretch;
        min-height: 9.5rem;
        /* No radius: a painted line does not have rounded corners. */
        border-radius: 0;
      }

      .bay__line {
        flex: 0 0 10px;
      }

      .bay__body {
        flex: 1;
        padding: var(--sp-5) var(--sp-5) var(--sp-4);
        display: flex;
        flex-direction: column;
        gap: var(--sp-2);
      }

      .bay__top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--sp-4);
        flex-wrap: wrap;
      }

      .bay__code {
        margin: 0;
        font-size: clamp(2.6rem, 7vw, 4rem);
      }

      /* A waitlist line like "Position 6" needs to sit at body width, not bay-code width. */
      .bay__code--small {
        font-size: clamp(1.6rem, 4vw, 2.3rem);
      }

      .bay__caption,
      .bay__note {
        margin: 0;
        font-size: var(--t-body);
      }

      .bay__actions:not(:empty) {
        margin-top: var(--sp-3);
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        flex-wrap: wrap;
      }

      /* ------------------------------------------------------------------- held */
      .bay--held {
        background: var(--steel);
        color: var(--stencil);
      }
      .bay--held .bay__line {
        background: var(--bay-line);
      }
      .bay--held .bay__caption {
        color: #c3cbd6;
      }
      .bay--held .bay__note {
        color: #a9b4c1;
      }

      /* ---------------------------------------------------------------- waiting */
      .bay--waiting {
        background: var(--steel);
        color: var(--stencil);
      }
      /* Dimmed line: a queue position is not a space. */
      .bay--waiting .bay__line {
        background: #5a6675;
      }
      .bay--waiting .bay__caption {
        color: #c3cbd6;
      }
      .bay--waiting .bay__note {
        color: #a9b4c1;
      }

      /* ------------------------------------------------------------------- open */
      .bay--open {
        background: var(--concrete-deep);
        color: var(--steel);
        /* Dashed: marked out, not yet painted as anyone's. */
        outline: 3px dashed var(--bay-line-deep);
        outline-offset: -3px;
      }
      .bay--open .bay__line {
        background: transparent;
        flex-basis: 0;
      }
      .bay--open .bay__body {
        padding-left: var(--sp-5);
      }
      .bay--open .bay__caption,
      .bay--open .bay__note {
        color: var(--steel-soft);
      }

      /* ----------------------------------------------------------------- closed */
      .bay--closed {
        background: var(--concrete-deep);
        color: var(--steel-soft);
      }
      .bay--closed .bay__line {
        background: var(--rule);
      }
      .bay--closed .bay__code {
        font-variation-settings:
          'wdth' 110,
          'wght' 620;
      }
    `,
  ],
})
export class Bay {
  readonly variant = input.required<BayVariant>();
  /** The stencilled line: a spot code, a queue position, or a cycle label. */
  readonly code = input.required<string>();
  readonly caption = input<string | null>(null);
  readonly note = input<string | null>(null);
  /**
   * The status marker, as inputs rather than a projected slot. A slot cannot be filled
   * from inside an `@if` that has other content at its root (NG8011), and every caller
   * needs exactly that, so the pill is rendered here instead.
   */
  readonly status = input<string | null>(null);
  readonly statusTone = input<PillTone>('idle');
  /** Read by screen readers in place of the decorative geometry. */
  readonly label = input<string>('Parking status');

  readonly longCode = computed(() => this.code().length > 8);
}
