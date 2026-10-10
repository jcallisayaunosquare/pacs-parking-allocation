import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import type { Fairness } from '../../domain/models';

/**
 * Where you stand, and the rule that puts you there.
 *
 * This screen used to show a draw weight and a row of marks - one slip of paper per
 * entry - because the allocation used to be a weighted lottery. It is not one any more:
 * the order is deterministic, longest wait first, fewest past allocations breaking the
 * tie, and the raffle only separating candidates who are still exactly level. A row of
 * tickets drawn under that rule tells a resident something untrue about how they are
 * ranked, which is worse than telling them nothing.
 *
 * So the subject is the wait, set at display scale because it is the quantity that
 * decides, and the two tie-breaks are stated under it in the order they are applied.
 * §17's rule still holds: no number without the sentence that makes it mean something,
 * and the sentence comes from the API beside the value so the two cannot drift apart.
 */
@Component({
  selector: 'app-fairness-explainer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <section class="fair" aria-labelledby="fair-h">
      <h2 class="fair__h" id="fair-h">Where you stand</h2>

      <!--
        With no figure there is no figure: a dash at display scale in the stencil
        treatment is a black slab, which reads as a rendering fault rather than as
        "unknown". The line states the absence in words instead.
      -->
      @if (waited(); as w) {
        <p class="fair__wait">
          <span class="fair__n stencil">{{ w.value }}</span>
          <span class="fair__u">{{ w.unit }} waiting</span>
        </p>
      } @else {
        <p class="fair__none">
          Your waiting time is not available right now. The rule below is still the rule.
        </p>
      }

      <!--
        The ordering, written out, with the step that actually decides this resident's
        place marked. Three lines rather than a diagram: the rule is three clauses long
        and a reader can hold it.
      -->
      <ol class="rule">
        <li class="rule__step" [class.rule__step--on]="deciding() === 'wait'">
          <span class="rule__n">1</span>
          <span>
            Longest wait goes first.
            @if (deciding() === 'wait') {
              <span class="rule__tag">decides your place</span>
            }
          </span>
        </li>
        <li class="rule__step" [class.rule__step--on]="deciding() === 'history'">
          <span class="rule__n">2</span>
          <span>
            A tie goes to whoever has held a bay least often.
            @if (fairness().servedCount !== null) {
              You have held one {{ fairness().servedCount }}
              {{ fairness().servedCount === 1 ? 'time' : 'times' }}.
            }
            @if (deciding() === 'history') {
              <span class="rule__tag">decides your place</span>
            }
          </span>
        </li>
        <li class="rule__step">
          <span class="rule__n">3</span>
          <span>Still exactly level, and a seeded raffle decides. You can check its token.</span>
        </li>
      </ol>

      <p class="fair__sentence">{{ fairness().explanation }}</p>

      @if (fairness().biasApplied && fairness().effectiveWaitHours !== null) {
        <p class="fair__flag msg msg--warn">
          The early-waiting window is open on your last bay, so your wait counts as
          {{ fairness().effectiveWaitHours }} hours until it closes.
        </p>
      }

      @if (fairness().anchorAt; as since) {
        <p class="fair__since">Counting from {{ since | date: 'd MMMM y, HH:mm' }}</p>
      }
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

      .fair__wait {
        display: flex;
        align-items: baseline;
        gap: var(--sp-3);
        margin: 0;
      }

      /* The quantity that decides, at the scale that says so. */
      .fair__n {
        font-size: var(--t-display);
        color: var(--ink-1);
      }

      /* A figure the server did not send is absent, not zero, and is said in words. */
      .fair__none {
        margin: 0;
        color: var(--steel-soft);
        max-width: 60ch;
      }

      .fair__u {
        font-size: var(--t-body);
        color: var(--steel-soft);
      }

      /* ------------------------------------------------------------- the rule */

      .rule {
        list-style: none;
        margin: var(--sp-5) 0 0;
        padding: 0;
        max-width: 62ch;
        border-top: 1px solid var(--rule-soft);
      }

      .rule__step {
        display: grid;
        grid-template-columns: 2.5ch minmax(0, 1fr);
        gap: var(--sp-3);
        align-items: baseline;
        padding: var(--sp-3) 0;
        border-bottom: 1px solid var(--rule-soft);
        font-size: var(--t-small);
        color: var(--steel-soft);
      }

      .rule__n {
        color: var(--steel-faint);
        font-variant-numeric: tabular-nums;
      }

      /*
       * The step that decides this resident's place. The second channel is the tag in
       * the markup, not a bar down the left: a 3px signal rule on one row of a
       * hairline-ruled table shouts over the table, and colouring the number as well
       * would have been two colour channels dressed up as two channels.
       */
      .rule__step--on {
        color: var(--ink-1);
      }

      .rule__step--on .rule__n {
        color: var(--signal);
      }

      .rule__tag {
        display: inline-block;
        margin-left: var(--sp-2);
        font-size: var(--t-fine);
        letter-spacing: 0.08em;
        color: var(--signal);
      }

      .fair__sentence {
        margin-top: var(--sp-4);
        font-size: var(--t-body);
        max-width: 60ch;
      }

      /* The warning treatment is .msg--warn from the stylesheet, not a copy of it. */
      .fair__flag {
        margin-top: var(--sp-3);
        max-width: 60ch;
      }

      .fair__since {
        margin-top: var(--sp-3);
        font-size: var(--t-fine);
        color: var(--steel-faint);
      }
    `,
  ],
})
export class FairnessExplainer {
  readonly fairness = input.required<Fairness>();

  /**
   * Hours up to two days, then days. A resident who has waited four months does not
   * want to read 2,904, and one who joined this morning does not want to read 0.
   */
  readonly waited = computed(() => {
    const raw = this.fairness().waitingHours;
    if (raw === null) return null;
    const h = Math.max(0, Math.round(raw));
    if (h < 48) return { value: h, unit: h === 1 ? 'hour' : 'hours' };
    return { value: Math.floor(h / 24), unit: 'days' };
  });

  /**
   * Which clause of the rule is doing the work for this resident. The bias is a
   * modification of the wait, so it is still the wait that decides; history only takes
   * over once someone has never held a bay, which is the case the tie-break exists for.
   */
  readonly deciding = computed<'wait' | 'history' | null>(() => {
    const f = this.fairness();
    if (f.waitingHours === null) return null;
    return f.servedCount === 0 && !f.biasApplied ? 'history' : 'wait';
  });
}
