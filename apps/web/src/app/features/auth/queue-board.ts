import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Illustrative, and the only invented content on either surface: no real unit is named. */
const BOARD_ROWS = [
  { pos: 1, unit: 'Unit 1104', wait: '214 d', bay: 'A04', on: false, past: false, cut: false },
  { pos: 2, unit: 'Unit 503', wait: '186 d', bay: 'A11', on: false, past: false, cut: false },
  { pos: 3, unit: 'Unit 211', wait: '173 d', bay: 'B02', on: true, past: false, cut: false },
  { pos: 4, unit: 'Unit 902', wait: '168 d', bay: 'B07', on: false, past: false, cut: false },
  { pos: 5, unit: 'Unit 406', wait: '91 d', bay: '', on: false, past: true, cut: true },
  { pos: 6, unit: 'Unit 308', wait: '77 d', bay: '', on: false, past: true, cut: false },
];

/**
 * The call board beside the way in: the product's thesis shown before a word is read.
 *
 * Each row turns over like a split-flap as it arrives, the cut is drawn across where the
 * bays run out, and the marked row is lit last - the order a resident will watch their
 * own row rise in. Decorative, so hidden from assistive technology; the welcome page and
 * the sign-in share it.
 */
@Component({
  selector: 'app-queue-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true' },
  template: `
    <div class="board__head">
      <p class="gate__now">Period 2026-02 <span class="gate__sep">/</span> closes in 11 days</p>
      <p class="board__serving">
        <span class="board__servingL">Now serving</span>
        <span class="board__servingN">
          <span class="flap" style="--f: 0">0</span><span class="flap" style="--f: 1">3</span>
        </span>
      </p>
    </div>
    <ol class="gate__rows">
      @for (row of rows; track row.pos; let i = $index) {
        @if (row.cut) {
          <li class="gate__cut" [style.--r]="i"><span>Bays run out here</span></li>
        }
        <li
          class="gate__row"
          [class.gate__row--on]="row.on"
          [class.gate__row--past]="row.past"
          [style.--r]="i"
        >
          <span class="gate__pos">{{ row.pos }}</span>
          <span class="gate__unit">{{ row.unit }}</span>
          <span class="gate__wait">{{ row.wait }}</span>
          <span class="gate__bay">{{ row.bay }}</span>
        </li>
      }
    </ol>
  `,
  styles: [
    `
      :host {
        --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
        background: var(--board);
        color: var(--board-ink);
        padding: var(--sp-7);
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: var(--sp-5);
        overflow: hidden;
        perspective: 900px;
        animation: board-in 700ms var(--ease-out) both;
      }

      @keyframes board-in {
        from {
          opacity: 0;
        }
      }

      .board__head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: var(--sp-5);
        flex-wrap: wrap;
      }

      .gate__now {
        margin: 0;
        font-size: var(--t-fine);
        letter-spacing: 0.2em;
        color: var(--board-ink-dim);
      }

      .gate__sep {
        color: var(--board-rule);
        padding: 0 0.4em;
      }

      .board__serving {
        margin: 0;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: var(--sp-1);
      }

      .board__servingL {
        font-size: var(--t-fine);
        letter-spacing: 0.2em;
        text-transform: uppercase;
        color: var(--board-ink-dim);
      }

      .board__servingN {
        display: flex;
        gap: 4px;
      }

      /* Split-flap digits: each tile turns over on its own, one after the other. */
      .flap {
        display: inline-grid;
        place-items: center;
        width: 2.6rem;
        height: 3.4rem;
        background: color-mix(in srgb, var(--board-rule) 70%, transparent);
        border-radius: 3px;
        color: var(--signal-on-board);
        font-size: 2.25rem;
        font-variation-settings:
          'wdth' 112,
          'wght' 700;
        background-image: linear-gradient(
          to bottom,
          transparent calc(50% - 0.5px),
          var(--board) calc(50% - 0.5px) calc(50% + 0.5px),
          transparent calc(50% + 0.5px)
        );
        transform-origin: 50% 50%;
        animation: flip 720ms var(--ease-out) both;
        animation-delay: calc(var(--f) * 140ms + 1250ms);
      }

      .gate__rows {
        list-style: none;
        margin: 0;
        padding: 0;
        border-top: 1px solid var(--board-rule);
      }

      /* Columns never move, whatever a row says. */
      .gate__row {
        display: grid;
        grid-template-columns: 3.5ch 1fr 7ch 5ch;
        gap: var(--sp-4);
        align-items: baseline;
        padding: var(--sp-3) var(--sp-2);
        border-bottom: 1px solid var(--board-rule);
        font-size: var(--t-small);
        transform-origin: 50% 0;
        animation: flip 560ms var(--ease-out) both;
        animation-delay: calc(var(--r) * 90ms + 380ms);
      }

      @keyframes flip {
        from {
          opacity: 0;
          transform: rotateX(-88deg);
        }
        60% {
          opacity: 1;
        }
      }

      .gate__pos {
        font-size: var(--t-body);
        font-variation-settings:
          'wdth' 112,
          'wght' 620;
        color: var(--board-ink-dim);
        text-align: right;
      }

      .gate__unit {
        color: var(--board-ink);
      }

      .gate__wait,
      .gate__bay {
        color: var(--board-ink-dim);
        text-align: right;
      }

      .gate__row--on,
      .gate__row--on .gate__pos,
      .gate__row--on .gate__unit,
      .gate__row--on .gate__wait,
      .gate__row--on .gate__bay {
        color: var(--signal-on-board);
      }

      /* The viewer's row lights once the board has turned over: a sweep, then a hold. */
      .gate__row--on {
        position: relative;
        background: linear-gradient(
            to right,
            color-mix(in srgb, var(--signal-on-board) 16%, transparent),
            color-mix(in srgb, var(--signal-on-board) 6%, transparent)
          )
          no-repeat 0 0 / 0% 100%;
        animation:
          flip 560ms var(--ease-out) both,
          light 700ms var(--ease-out) forwards;
        animation-delay:
          calc(var(--r) * 90ms + 380ms),
          1500ms;
      }

      @keyframes light {
        to {
          background-size: 100% 100%;
        }
      }

      .gate__row--past {
        opacity: 0.55;
      }

      .gate__row--past {
        animation-name: flip-past;
      }

      @keyframes flip-past {
        from {
          opacity: 0;
          transform: rotateX(-88deg);
        }
        to {
          opacity: 0.55;
        }
      }

      .gate__cut {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        padding: var(--sp-4) var(--sp-2) var(--sp-3);
        font-size: var(--t-fine);
        letter-spacing: 0.18em;
        color: var(--board-ink-dim);
        animation: rise 500ms var(--ease-out) both;
        animation-delay: calc(var(--r) * 90ms + 380ms);
      }

      /* The cut is drawn across, left to right, after the rows above it have landed. */
      .gate__cut::after {
        content: '';
        flex: 1;
        height: 1px;
        background: repeating-linear-gradient(
          to right,
          var(--board-rule) 0 6px,
          transparent 6px 12px
        );
        transform-origin: 0 50%;
        animation: draw 700ms var(--ease-out) both;
        animation-delay: calc(var(--r) * 90ms + 520ms);
      }

      @keyframes draw {
        from {
          transform: scaleX(0);
        }
      }

      @keyframes rise {
        from {
          opacity: 0;
          transform: translateY(14px);
        }
      }

      @media (max-width: 62rem) {
        /* A short band above the way in: the thesis, then the form. */
        :host {
          order: -1;
          padding: var(--sp-5);
          gap: var(--sp-4);
        }

        .gate__row:nth-child(n + 6),
        .gate__cut {
          display: none;
        }
      }

      @media (max-width: 30rem) {
        /* On a phone the way in comes first and the board follows it, so the ticket is
           in the first screen rather than under three rows of illustration. */
        :host {
          order: 0;
          padding: var(--sp-5) var(--sp-4);
        }

        .board__serving {
          align-items: flex-start;
        }

        .gate__row {
          grid-template-columns: 3ch 1fr 6ch 4ch;
          gap: var(--sp-3);
          font-size: var(--t-fine);
        }

        .gate__row:nth-child(n + 4) {
          display: none;
        }

        .flap {
          width: 2rem;
          height: 2.6rem;
          font-size: 1.6rem;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        :host,
        .gate__row,
        .gate__row--on,
        .gate__cut,
        .gate__cut::after,
        .flap {
          animation: none;
        }
        .gate__row--on {
          background-size: 100% 100%;
        }
      }
    `,
  ],
})
export class QueueBoard {
  readonly rows = BOARD_ROWS;
}
