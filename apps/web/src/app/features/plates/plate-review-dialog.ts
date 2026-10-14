import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import {
  FormField,
  form,
  maxLength,
  pattern,
  required,
  submit as submitForm,
} from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { PlatesFacade } from '../../application/plates.facade';
import type { PlateRead } from '../../domain/models';
import { REASON_LABEL } from './reason-label';
import { LoadingOverlay } from '../../shared/ui/loading-overlay';
import { LIMITS, PLATE_CHARACTER, fieldError } from '../../shared/forms/limits';

/**
 * Correcting a doubtful read.
 *
 * The three numbers are shown separately rather than only their product, because they
 * are three different faults: a low OCR confidence is a hard plate, a low quality is a
 * camera problem, and a high confidence over a low quality is the dangerous read - the
 * engine certain about pixels it could not see. An administrator deciding whether to
 * trust the machine needs to know which one they are looking at.
 *
 * The candidates are offered as one-click answers, and so is the raw line. Typing a plate
 * is the fallback, not the main path: a reviewer looking at a frame of a known car wants
 * to point, and every keystroke here is a chance to introduce a label that is wrong - and
 * a wrong label is worse than no label, because it goes into the evaluation set.
 */
@Component({
  selector: 'app-plate-review-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormField,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    LoadingOverlay,
  ],
  template: `
    <h2 mat-dialog-title>Review read</h2>

    <app-loading-overlay [active]="facade.busy()" [veil]="false" label="Saving the review">
      <mat-dialog-content class="form">
        <dl class="facts">
          <div class="facts__row">
            <dt>Read as</dt>
            <dd class="num">{{ read.rawText || read.plate || '—' }}</dd>
          </div>
          <div class="facts__row">
            <dt>Canonical</dt>
            <dd class="num">{{ read.plate || '—' }}</dd>
          </div>
          <div class="facts__row">
            <dt>OCR confidence</dt>
            <dd class="num">{{ pct(read.confidence) }}</dd>
          </div>
          <div class="facts__row">
            <dt>Crop quality</dt>
            <dd class="num">{{ pct(read.quality) }}</dd>
          </div>
          <div class="facts__row">
            <dt>Fused</dt>
            <dd class="num">{{ pct(read.fused) }}</dd>
          </div>
          <div class="facts__row">
            <dt>Why it is here</dt>
            <dd>{{ reasonLabel }}</dd>
          </div>
          <div class="facts__row">
            <dt>Camera</dt>
            <dd class="num">{{ read.cameraId }}</dd>
          </div>
          <div class="facts__row">
            <dt>Capture</dt>
            <dd class="num ref">{{ read.captureId }}</dd>
          </div>
        </dl>

        @if (read.candidates.length > 0) {
          <section class="pick">
            <h3 class="pick__h">What the engine considered</h3>
            <p class="pick__p">
              Highest score first. Picking one fills the plate below; it is not submitted
              until you choose an outcome.
            </p>
            <ul class="pick__list">
              @for (c of read.candidates; track c.plate) {
                <li>
                  <button
                    type="button"
                    class="cand"
                    [class.cand--on]="plate() === c.plate"
                    [attr.aria-pressed]="plate() === c.plate"
                    (click)="pick(c.plate)"
                  >
                    <span class="cand__plate num">{{ c.plate }}</span>
                    <span class="cand__meta num">score {{ c.score.toFixed(0) }}</span>
                  </button>
                </li>
              }
            </ul>
          </section>
        }

        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>The plate it really was</mat-label>
          <input
            matInput
            class="num"
            [formField]="f.plate"
            placeholder="1234ABC"
            autocomplete="off"
            spellcheck="false"
            cdkFocusInitial
          />
          <mat-hint>
            Separators and case do not matter. Required to allow an entry — an access record
            that names no plate cannot be contested later.
          </mat-hint>
          <mat-error>{{ err(f.plate) }}</mat-error>
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Note</mat-label>
          <input matInput [formField]="f.note" placeholder="Optional" />
          <mat-error>{{ err(f.note) }}</mat-error>
        </mat-form-field>

        @if (facade.error(); as e) {
          <div class="msg msg--bad" role="alert">{{ e.message }}</div>
        }
      </mat-dialog-content>
    </app-loading-overlay>

    <mat-dialog-actions class="acts">
      <!--
        Discard sits apart from the two judgements, because it is not one: it records that
        the frame was not an entry and writes nothing to the access log.
      -->
      <button matButton type="button" [disabled]="facade.busy()" (click)="submit('DISCARD')">
        Unreadable, discard
      </button>
      <span class="acts__gap"></span>
      <button matButton mat-dialog-close type="button">Cancel</button>
      <button matButton type="button" [disabled]="facade.busy()" (click)="submit('DENY')">
        Not registered
      </button>
      <button
        matButton="filled"
        type="button"
        [disabled]="facade.busy()"
        [class.is-pending]="facade.busy()"
        (click)="submit('ALLOW')"
      >
        {{ facade.busy() ? 'Saving…' : 'This plate, allow' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .form {
        display: flex;
        flex-direction: column;
        gap: var(--sp-3);
        min-width: 26rem;
      }

      /* Tabular figures wherever a plate or a measurement is printed. */
      .num {
        font-variant-numeric: tabular-nums;
        font-feature-settings: 'tnum' 1;
        letter-spacing: 0.02em;
      }

      .facts {
        margin: 0;
        display: grid;
        gap: var(--sp-1) var(--sp-4);
        border-top: 1px solid var(--rule);
        padding-top: var(--sp-3);
      }
      .facts__row {
        display: grid;
        grid-template-columns: 11rem 1fr;
        gap: var(--sp-3);
        align-items: baseline;
      }
      .facts dt {
        font-size: var(--t-fine);
        color: var(--steel-soft);
      }
      .facts dd {
        margin: 0;
      }
      .ref {
        font-size: var(--t-fine);
        color: var(--steel-soft);
        word-break: break-all;
      }

      .pick {
        border-top: 1px solid var(--rule);
        padding-top: var(--sp-3);
      }
      .pick__h {
        font-size: var(--t-small);
      }
      .pick__p {
        font-size: var(--t-fine);
        color: var(--steel-soft);
        max-width: 46ch;
        margin: var(--sp-1) 0 var(--sp-2);
      }
      .pick__list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-wrap: wrap;
        gap: var(--sp-2);
      }
      .cand {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.1rem;
        font: inherit;
        padding: var(--sp-2) var(--sp-3);
        border: 1px solid var(--rule);
        border-left-width: 3px;
        background: transparent;
        color: var(--ink-1);
        cursor: pointer;
        min-height: 2.75rem;
      }
      .cand--on {
        border-left-color: var(--signal);
        background: var(--concrete-deep);
      }
      .cand__plate {
        font-size: var(--t-small);
      }
      .cand__meta {
        font-size: var(--t-fine);
        color: var(--steel-soft);
      }

      .acts {
        display: flex;
        flex-wrap: wrap;
        gap: var(--sp-2);
      }
      .acts__gap {
        flex: 1 1 auto;
      }

      @media (max-width: 34rem) {
        .form {
          min-width: 0;
        }
        .facts__row {
          grid-template-columns: 1fr;
          gap: 0;
        }
      }
    `,
  ],
})
export class PlateReviewDialog {
  readonly facade = inject(PlatesFacade);
  private readonly ref = inject(MatDialogRef<PlateReviewDialog>);
  readonly read = inject<PlateRead>(MAT_DIALOG_DATA);

  /** Pre-filled with the engine's best guess, which is right most of the time. */
  readonly model = signal({ plate: this.read.plate ?? '', note: '' });

  /**
   * The plate is required only to allow: Deny and Discard send none. Its rules sit on the
   * field regardless, and only the Allow path asks the whole form to be valid.
   */
  readonly f = form(this.model, (p) => {
    required(p.plate, { message: 'Type the plate to allow it. A record must name one.' });
    pattern(p.plate, PLATE_CHARACTER, { message: 'A plate needs at least one letter or digit.' });
    maxLength(p.plate, LIMITS.plate, { message: `Up to ${LIMITS.plate} characters.` });
    maxLength(p.note, LIMITS.notes, { message: `Up to ${LIMITS.notes} characters.` });
  });

  readonly err = fieldError;

  readonly plate = computed(() => this.model().plate);

  readonly reasonLabel: string;

  constructor() {
    this.facade.dismissError();
    // Nor does it outlive the dialog: left set, the page behind would print it next.
    inject(DestroyRef).onDestroy(() => this.facade.dismissError());
    this.reasonLabel = this.read.reason
      ? REASON_LABEL[this.read.reason] ?? this.read.reason
      : 'Low confidence';
  }

  pct(v: number | null): string {
    return v === null ? '—' : `${(v * 100).toFixed(1)}%`;
  }

  /** A candidate chip fills the field, as if typed, and counts as an answer to it. */
  pick(plate: string): void {
    this.model.update((m) => ({ ...m, plate }));
    this.f.plate().markAsTouched();
  }

  async submit(outcome: 'ALLOW' | 'DENY' | 'DISCARD'): Promise<void> {
    if (outcome === 'ALLOW') {
      await submitForm(this.f, () => this.resolve(outcome));
      return;
    }
    // Deny and Discard name no plate, so only the note has to hold.
    this.f.note().markAsTouched();
    if (this.f.note().valid()) await this.resolve(outcome);
  }

  private async resolve(outcome: 'ALLOW' | 'DENY' | 'DISCARD'): Promise<void> {
    const note = this.model().note.trim();
    const done = await this.facade.resolve(this.read, {
      plate: outcome === 'ALLOW' ? this.plate().trim() : null,
      // The server resolves a typed plate to an active registration itself, so the
      // reviewer never has to know a vehicle id.
      vehicleId: null,
      decision: outcome === 'ALLOW' ? 'ALLOW' : 'DENY',
      note: note.length > 0 ? note : null,
      discard: outcome === 'DISCARD',
    });
    if (done) this.ref.close(true);
  }
}
