import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';

/**
 * A modal built on the native `<dialog>` element.
 *
 * `showModal()` gives us the things a hand-rolled overlay usually gets wrong, for free
 * and correctly: the rest of the page becomes inert, focus is trapped inside, Esc
 * closes, and `::backdrop` is a real pseudo-element rather than a stacked div. That is
 * the whole reason not to pull in a component library for this.
 *
 * The caller owns the content and the footer; this owns opening, closing and the
 * accessible wiring.
 */
@Component({
  selector: 'app-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dlg class="modal" [attr.aria-labelledby]="titleId" (close)="closed.emit()">
      <div class="modal__head">
        <h2 class="modal__title" [id]="titleId">{{ title() }}</h2>
      </div>

      <div class="modal__body">
        <ng-content />
      </div>

      <div class="modal__foot">
        <ng-content select="[modalFoot]" />
      </div>
    </dialog>
  `,
})
export class Modal {
  readonly open = input(false);
  readonly title = input.required<string>();
  readonly closed = output<void>();

  /** Unique per instance, so two modals on a page cannot share a label id. */
  readonly titleId = `modal-${Math.random().toString(36).slice(2, 9)}`;

  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    effect(() => {
      const el = this.dlg().nativeElement;
      if (this.open()) {
        if (!el.open) el.showModal();
      } else if (el.open) {
        el.close();
      }
    });
  }
}
