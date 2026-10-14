import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

/**
 * The one pager under every paged table.
 *
 * There were two: Material's paginator under the register, pushed to the right and set in
 * its own type, and a hand-built one under the gate log on the left. Same job, two
 * placements, two voices - so the eye had to find the control again on every screen.
 * This is the only one now, and it sits where a table's rows end: on the left, under the
 * first column, in the fine size the rest of the table furniture uses.
 *
 * Built for keyset paging, which is what the API does. A cursor knows "after this row",
 * not "page 7 of 12", so there is no total and no jump-to-page; Material's paginator
 * wanted a row count and had to be fed an invented one. What this shows is what is
 * actually known: the rows on screen, the page reached, and whether there is more.
 */
@Component({
  selector: 'app-pager',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule],
  template: `
    <nav class="pager" aria-label="Pages">
      <button
        matButton
        type="button"
        [disabled]="!hasPrevious()"
        (click)="previous.emit()"
      >
        <mat-icon aria-hidden="true">arrow_back</mat-icon>
        Previous
      </button>
      <span class="pager__n num" aria-live="polite">{{ range() }}</span>
      <button matButton type="button" [disabled]="!hasNext()" (click)="next.emit()">
        Next
        <mat-icon iconPositionEnd aria-hidden="true">arrow_forward</mat-icon>
      </button>
    </nav>
  `,
  styles: [
    `
      .pager {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: var(--sp-3);
        padding-top: var(--sp-3);
        margin-top: var(--sp-2);
        border-top: 1px solid var(--rule);
        font-size: var(--t-fine);
      }
      .pager button {
        font-size: var(--t-fine);
      }
      .pager__n {
        color: var(--steel-soft);
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
})
export class Pager {
  /** 1-based. */
  readonly page = input.required<number>();
  readonly pageSize = input.required<number>();
  /** How many rows the current page actually holds. */
  readonly count = input.required<number>();
  readonly hasPrevious = input.required<boolean>();
  readonly hasNext = input.required<boolean>();

  readonly previous = output<void>();
  readonly next = output<void>();

  /** "Rows 16–30 · page 2" - only what keyset paging can know, so no "of N". */
  readonly range = computed(() => {
    const n = this.count();
    if (n === 0) return `Page ${this.page()}`;
    const first = (this.page() - 1) * this.pageSize() + 1;
    return `Rows ${first}–${first + n - 1} · page ${this.page()}`;
  });
}
