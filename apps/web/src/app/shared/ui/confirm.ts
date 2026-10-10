import { ChangeDetectionStrategy, Component, Injectable, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import {
  MAT_DIALOG_DATA,
  MatDialog,
  MatDialogModule,
  type MatDialogRef,
} from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';

export interface ConfirmRequest {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly danger?: boolean;
  /**
   * A statement rather than a question: one button, and nothing to decline.
   *
   * Used where an action is refused outright - a blocked removal is not a choice the
   * administrator is being offered, and a Cancel beside it would imply there is a way
   * through if they press the other one.
   */
  readonly notice?: boolean;
}

@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      <p>{{ data.body }}</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      @if (!data.notice) {
        <button matButton [mat-dialog-close]="false">{{ data.cancelLabel ?? 'Cancel' }}</button>
      }
      <button
        matButton="filled"
        [class.act--danger]="data.danger"
        [mat-dialog-close]="true"
        cdkFocusInitial
      >
        {{ data.confirmLabel }}
      </button>
    </mat-dialog-actions>
  `,
})
export class ConfirmDialog {
  readonly data = inject<ConfirmRequest>(MAT_DIALOG_DATA);
}

/**
 * Confirmation for the irreversible actions (§17: every one of them goes through a
 * dialog).
 *
 * The promise resolves true or false rather than taking callbacks, so a caller reads
 * as a sentence: `if (await confirm.ask(...)) { ... }`. That shape survived the move to
 * MatDialog — the callers did not change — while the host component this used to need
 * at the shell went away, because MatDialog brings its own overlay.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly dialog = inject(MatDialog);
  private openRef: MatDialogRef<ConfirmDialog, boolean> | null = null;

  async ask(request: ConfirmRequest): Promise<boolean> {
    // A second ask while one is open cancels the first rather than stacking dialogs.
    this.openRef?.close(false);

    const ref = this.dialog.open<ConfirmDialog, ConfirmRequest, boolean>(ConfirmDialog, {
      data: request,
      width: '30rem',
      maxWidth: 'calc(100vw - 2rem)',
      // Esc and the backdrop both mean "no", which is the safe answer for every caller.
      restoreFocus: true,
    });
    this.openRef = ref;

    const ok = await firstValueFrom(ref.afterClosed());
    if (this.openRef === ref) this.openRef = null;
    return ok === true;
  }
}
