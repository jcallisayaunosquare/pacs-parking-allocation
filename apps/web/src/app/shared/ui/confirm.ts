import { ChangeDetectionStrategy, Component, Injectable, computed, inject, signal } from '@angular/core';
import { Modal } from './modal';

export interface ConfirmRequest {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly danger?: boolean;
}

/**
 * Confirmation for the irreversible actions (§17: every one of them goes through a
 * dialog). One host component at the shell, one service to ask.
 *
 * The promise resolves true or false rather than taking callbacks, so a caller reads
 * as a sentence: `if (await confirm.ask(...)) { ... }`.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly _request = signal<ConfirmRequest | null>(null);
  private resolver: ((ok: boolean) => void) | null = null;

  readonly request = this._request.asReadonly();

  ask(request: ConfirmRequest): Promise<boolean> {
    // A second ask while one is open cancels the first rather than stacking dialogs.
    this.resolver?.(false);
    this._request.set(request);
    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
    });
  }

  settle(ok: boolean): void {
    this._request.set(null);
    const r = this.resolver;
    this.resolver = null;
    r?.(ok);
  }
}

@Component({
  selector: 'app-confirm-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal],
  template: `
    @if (service.request(); as r) {
      <app-modal [open]="true" [title]="r.title" (closed)="service.settle(false)">
        <p>{{ r.body }}</p>

        <div modalFoot>
          <button class="btn btn--quiet" type="button" (click)="service.settle(false)">
            {{ r.cancelLabel ?? 'Cancel' }}
          </button>
          <button
            class="btn"
            [class.btn--danger]="r.danger"
            type="button"
            (click)="service.settle(true)"
          >
            {{ r.confirmLabel }}
          </button>
        </div>
      </app-modal>
    }
  `,
})
export class ConfirmHost {
  readonly service = inject(ConfirmService);
}
