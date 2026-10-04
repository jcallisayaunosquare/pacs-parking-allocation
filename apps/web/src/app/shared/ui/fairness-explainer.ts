import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { Fairness } from '../../domain/models';

/**
 * The number and the sentence, together.
 *
 * §17's design rule, and the reason this component exists at all: "fairness score: 3"
 * means nothing to a resident; "you have missed 3 quarters, so your name goes in the
 * hat 4 times" means everything. The sentence comes from the API alongside the value so
 * the two can never drift apart — the frontend does not compose it and must not.
 */
@Component({
  selector: 'app-fairness-explainer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="fair" aria-labelledby="fairness-heading">
      <header class="fair__head">
        <h3 class="fair__title" id="fairness-heading">Tu puntaje de equidad</h3>
        <div class="fair__numbers">
          <span class="fair__score">{{ fairness().score }}</span>
          <span class="fair__arrow" aria-hidden="true">→</span>
          <span class="fair__weight">
            <span class="fair__weight-value">{{ fairness().drawWeight }}</span>
            <span class="fair__weight-unit">{{
              fairness().drawWeight === 1 ? 'entrada' : 'entradas'
            }}</span>
          </span>
        </div>
      </header>

      <p class="fair__sentence">{{ fairness().explanation }}</p>

      @if (fairness().totalWins > 0) {
        <p class="fair__meta">
          Ganaste {{ fairness().totalWins }}
          {{ fairness().totalWins === 1 ? 'vez' : 'veces' }} en total.
        </p>
      }
    </section>
  `,
  styles: [
    `
      .fair {
        border: 1px solid var(--p-content-border-color, #dcdcdc);
        border-radius: 12px;
        padding: 1rem 1.15rem;
        background: #fbfaf8;
      }
      .fair__head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .fair__title {
        margin: 0;
        font-size: 0.8rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        font-weight: 700;
        color: #6a6a6a;
      }
      .fair__numbers {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
      }
      .fair__score {
        font-size: 1.6rem;
        font-weight: 700;
        line-height: 1;
      }
      .fair__arrow {
        color: #9a9a9a;
      }
      .fair__weight {
        display: flex;
        align-items: baseline;
        gap: 0.3rem;
      }
      .fair__weight-value {
        font-size: 1.6rem;
        font-weight: 700;
        line-height: 1;
        color: #2c6b4a;
      }
      .fair__weight-unit {
        font-size: 0.82rem;
        color: #5d5d5d;
      }
      .fair__sentence {
        margin: 0.7rem 0 0;
        line-height: 1.55;
        font-size: 0.95rem;
      }
      .fair__meta {
        margin: 0.45rem 0 0;
        font-size: 0.82rem;
        color: #6a6a6a;
      }
    `,
  ],
})
export class FairnessExplainer {
  readonly fairness = input.required<Fairness>();
}
