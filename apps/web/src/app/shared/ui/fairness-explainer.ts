import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Fairness } from '../../domain/models';

/**
 * The number and the sentence that makes it mean something.
 *
 * §17's rule: "fairness score: 3" tells a resident nothing; "you have missed 3
 * quarters, so your name goes in the hat 4 times" tells them everything. The sentence
 * comes from the API next to the value, so the two cannot drift apart — this component
 * never composes it.
 *
 * Drawn as a row of entries rather than a progress bar, because the quantity really is
 * countable: each mark is one slip of paper with your name on it.
 */
@Component({
  selector: 'app-fairness-explainer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="fair" aria-labelledby="fair-h">
      <h2 class="fair__h" id="fair-h">Your odds in the next draw</h2>

      <div class="fair__count">
        <span class="fair__weight stencil">{{ fairness().drawWeight }}</span>
        <span class="fair__unit">{{ fairness().drawWeight === 1 ? 'entry' : 'entries' }}</span>
      </div>

      <div class="fair__marks" aria-hidden="true">
        @for (m of marks(); track m) {
          <span class="fair__mark"></span>
        }
        @if (overflow() > 0) {
          <span class="fair__more">+{{ overflow() }}</span>
        }
      </div>

      <p class="fair__sentence">{{ fairness().explanation }}</p>

      <dl class="fair__meta">
        <div>
          <dt>Missed cycles</dt>
          <dd>{{ fairness().consecutiveMisses }}</dd>
        </div>
        <div>
          <dt>Times you have won</dt>
          <dd>{{ fairness().totalWins }}</dd>
        </div>
      </dl>
    </section>
  `,
  styles: [
    `
      .fair {
        border-top: 2px solid var(--steel);
        padding-top: var(--sp-4);
      }

      .fair__h {
        font-size: var(--t-lead);
        margin-bottom: var(--sp-3);
      }

      .fair__count {
        display: flex;
        align-items: baseline;
        gap: var(--sp-2);
      }

      .fair__weight {
        font-size: 2.75rem;
        color: var(--steel);
      }

      .fair__unit {
        font-size: var(--t-body);
        color: var(--steel-soft);
      }

      /**
       * One mark per slip of paper in the hat. Countable, so it is counted.
       *
       * The marks stand on a ruled line: a single mark floating on its own read as a
       * rendering glitch rather than as the number one, and weight 1 is the commonest
       * case there is.
       */
      .fair__marks {
        display: flex;
        align-items: flex-end;
        gap: 5px;
        height: 2rem;
        margin-top: var(--sp-3);
        padding-bottom: 5px;
        border-bottom: 2px solid var(--steel);
        min-width: 7rem;
        width: fit-content;
      }

      .fair__mark {
        width: 9px;
        height: 100%;
        background: var(--bay-line);
      }

      .fair__more {
        font-size: var(--t-fine);
        color: var(--steel-soft);
        margin-left: var(--sp-1);
      }

      .fair__sentence {
        margin-top: var(--sp-3);
        font-size: var(--t-body);
        max-width: 60ch;
      }

      .fair__meta {
        display: flex;
        gap: var(--sp-6);
        margin: var(--sp-4) 0 0;
      }

      .fair__meta dt {
        font-size: var(--t-fine);
        color: var(--steel-faint);
      }

      .fair__meta dd {
        margin: 2px 0 0;
        font-size: var(--t-lead);
        font-weight: 600;
      }
    `,
  ],
})
export class FairnessExplainer {
  readonly fairness = input.required<Fairness>();

  /** Capped so a very unlucky resident does not produce a hundred marks. */
  readonly marks = computed(() =>
    Array.from({ length: Math.min(this.fairness().drawWeight, 24) }, (_, i) => i),
  );

  readonly overflow = computed(() => Math.max(0, this.fairness().drawWeight - 24));
}
