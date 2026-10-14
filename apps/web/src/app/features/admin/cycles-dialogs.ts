import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import {
  FormField,
  form,
  maxLength,
  pattern,
  required,
  submit as submitForm,
} from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { provideNativeDateAdapter } from '@angular/material/core';
import { CyclesFacade } from '../../application/admin.facades';
import { AllocationConfigFacade } from '../../application/allocation-config.facade';
import type { Cycle } from '../../domain/models';
import { LoadingOverlay } from '../../shared/ui/loading-overlay';
import { LIMITS, NOT_BLANK, fieldError } from '../../shared/forms/limits';

/**
 * The day a picker hands back, as the `yyyy-MM-dd` string the contract speaks.
 *
 * Built from the local parts, never from `toISOString()`. A `Date` is an instant, and
 * the instant behind local midnight on 1 January is 31 December in UTC for anyone west
 * of it — which is exactly how a quarter beginning on 1 January once came to be shown as
 * the day before. The picker's own value is a calendar day in the operator's zone, and
 * reading its parts is the only conversion that keeps it one.
 */
const toDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The same calendar day, N months on. Clamped the way a calendar clamps: 31 Jan + 1M = 28 Feb. */
const addMonths = (d: Date, months: number): Date => {
  const out = new Date(d.getFullYear(), d.getMonth() + months, d.getDate());
  if (out.getDate() !== d.getDate()) out.setDate(0);
  return out;
};

interface NewCycleForm {
  label: string;
  startsOn: Date | null;
  opensAt: Date | null;
  closesAt: Date | null;
}

/**
 * Creating a period.
 *
 * An administrator picks one date - the day the period begins - and nothing else about
 * its length. The end comes from Period length in the allocation rules, so the number
 * that governs the rotation lives in exactly one place and a period cannot be created
 * that disagrees with it. The end is still shown here, because deriving a value is not a
 * reason to hide it: an operator about to commit the whole building for a quarter should
 * see the date they are committing to.
 *
 * The server derives it too, and the server's answer is the one that counts. What this
 * screen computes is a preview, and it says so if it cannot compute one.
 */
@Component({
  selector: 'app-new-cycle-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [provideNativeDateAdapter()],
  imports: [
    DatePipe,
    FormField,
    MatButtonModule,
    MatDatepickerModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    LoadingOverlay,
  ],
  template: `
    <h2 mat-dialog-title>New period</h2>

    <app-loading-overlay [active]="facade.busy()" [veil]="false" label="Creating the period">
      <mat-dialog-content class="form">
        <mat-form-field appearance="outline">
          <mat-label>Name</mat-label>
          <input
            matInput
            [formField]="f.label"
            [placeholder]="derivedLabel()"
            autocomplete="off"
          />
          <mat-hint>Optional. Left empty, the building names it {{ derivedLabel() }}.</mat-hint>
          <mat-error>{{ err(f.label) }}</mat-error>
        </mat-form-field>

        <!--
          A real datepicker rather than a bare text field: an administrator picking the
          quarter a building rotates on should see the month, not type eight characters
          and hope.
        -->
        <mat-form-field appearance="outline">
          <mat-label>Period begins</mat-label>
          <input matInput [matDatepicker]="startPicker" [formField]="f.startsOn" cdkFocusInitial />
          <mat-datepicker-toggle matIconSuffix [for]="startPicker" />
          <mat-datepicker #startPicker />
          <mat-error>{{ err(f.startsOn) }}</mat-error>
        </mat-form-field>

        <p class="derived">
          @if (endsOn(); as end) {
            Ends <strong>{{ end | date: 'longDate' }}</strong>
            &middot; {{ months() }} months, from Period length in the rules
          } @else if (startsOn()) {
            The end date comes from Period length in the rules, which could not be read.
            The server will still work it out.
          } @else {
            Pick a start date and the end follows from Period length in the rules.
          }
        </p>

        <div class="dates">
          <mat-form-field appearance="outline">
            <mat-label>Registration opens</mat-label>
            <input matInput [matDatepicker]="opensPicker" [formField]="f.opensAt" />
            <mat-datepicker-toggle matIconSuffix [for]="opensPicker" />
            <mat-datepicker #opensPicker />
            <mat-error>{{ err(f.opensAt) }}</mat-error>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Registration closes</mat-label>
            <input matInput [matDatepicker]="closesPicker" [formField]="f.closesAt" />
            <mat-datepicker-toggle matIconSuffix [for]="closesPicker" />
            <mat-datepicker #closesPicker />
            <mat-error>{{ err(f.closesAt) }}</mat-error>
          </mat-form-field>
        </div>

        @if (windowProblem(); as problem) {
          <p class="msg msg--warn" role="alert">{{ problem }}</p>
        }

        @if (facade.error(); as e) {
          <div class="msg msg--bad" role="alert">{{ e.message }}</div>
        }
      </mat-dialog-content>
    </app-loading-overlay>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button
        matButton="filled"
        [disabled]="facade.busy()"
        [class.is-pending]="facade.busy()"
        (click)="submit()"
      >
        {{ facade.busy() ? 'Creating…' : 'Create period' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .form {
        display: flex;
        flex-direction: column;
        gap: var(--sp-2);
        padding-top: var(--sp-2);
        min-width: 28rem;
      }
      .dates {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--sp-2);
      }
      /* The consequence of the date above it, so it sits with it rather than in a box. */
      .derived {
        margin: 0 0 var(--sp-3);
        font-size: var(--t-small);
        color: var(--steel-soft);
      }
      .derived strong {
        color: var(--ink-1);
      }
      @media (max-width: 34rem) {
        .form {
          min-width: 0;
        }
        .dates {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class NewCycleDialog {
  readonly facade = inject(CyclesFacade);
  private readonly config = inject(AllocationConfigFacade);
  private readonly ref = inject(MatDialogRef<NewCycleDialog>);

  readonly model = signal<NewCycleForm>({
    label: '',
    startsOn: null,
    opensAt: null,
    closesAt: null,
  });

  /**
   * Required dates and the name's length. The two orderings in `windowProblem` stay a
   * warning rather than a rule - see there.
   */
  readonly f = form(this.model, (p) => {
    maxLength(p.label, LIMITS.cycleLabel, { message: `Up to ${LIMITS.cycleLabel} characters.` });
    required(p.startsOn, { message: 'Pick the day the period begins.' });
    required(p.opensAt, { message: 'Pick the day registration opens.' });
    required(p.closesAt, { message: 'Pick the day registration closes.' });
  });

  readonly err = fieldError;

  readonly startsOn = computed(() => this.model().startsOn);
  private readonly opensAt = computed(() => this.model().opensAt);
  private readonly closesAt = computed(() => this.model().closesAt);

  /** Period length, when the rules could be read. Null means "ask the server". */
  readonly months = computed(() => this.config.saved()?.allocationDurationMonths ?? null);

  readonly endsOn = computed(() => {
    const start = this.startsOn();
    const months = this.months();
    if (!start || months === null) return null;
    // A period ends the day before the next one would begin, so the rotation has no gap.
    const end = addMonths(start, months);
    end.setDate(end.getDate() - 1);
    return end;
  });

  /** What the building will call it if the name is left empty: the server's own rule. */
  readonly derivedLabel = computed(() => {
    const start = this.startsOn();
    const months = this.months();
    if (!start) return 'the start month';
    if (months === 3) return `${start.getFullYear()}-Q${Math.floor(start.getMonth() / 3) + 1}`;
    return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
  });

  /**
   * Said as a warning rather than enforced: these are the two orderings that produce a
   * period nobody can register for, and an operator is better told than blocked.
   */
  readonly windowProblem = computed(() => {
    const opens = this.opensAt();
    const closes = this.closesAt();
    const starts = this.startsOn();
    if (opens && closes && closes < opens) return 'Registration closes before it opens.';
    if (closes && starts && closes > starts) {
      return 'Registration closes after the period begins, so the draw would run late.';
    }
    return null;
  });

  constructor() {
    this.facade.dismissError();
    // Nor does it outlive the dialog: left set, the page behind would print it next.
    inject(DestroyRef).onDestroy(() => this.facade.dismissError());

    /*
     * Opening the picker for a window with no dates yet should not start from nowhere.
     * Keyed on the start date alone, and the window read untracked: clearing a window
     * date by hand must stay cleared, not be refilled because the model changed.
     */
    effect(() => {
      const start = this.startsOn();
      if (!start) return;
      untracked(() => {
        const v = this.model();
        if (v.closesAt && v.opensAt) return;
        const closes = new Date(start);
        closes.setDate(closes.getDate() - 1);
        this.model.update((m) => ({
          ...m,
          closesAt: m.closesAt ?? closes,
          opensAt: m.opensAt ?? new Date(),
        }));
      });
    });
  }

  async submit(): Promise<void> {
    await submitForm(this.f, async () => {
      const v = this.model();
      const name = v.label.trim();
      const created = await this.facade.create({
        // Omitted on purpose: the server derives both from Period length, and a value sent
        // from here would be this screen's opinion competing with the rule.
        ...(name ? { label: name } : {}),
        startsOn: toDay(v.startsOn!),
        // The window is a timestamp in the contract; the chosen day, whole, in UTC.
        registrationOpensAt: new Date(`${toDay(v.opensAt!)}T00:00:00Z`).toISOString(),
        registrationClosesAt: new Date(`${toDay(v.closesAt!)}T23:59:59Z`).toISOString(),
      });
      if (created) this.ref.close(true);
    });
  }
}

/**
 * Renaming a period.
 *
 * The only thing about a period that can change once it exists. Its dates are stamped
 * onto every assignment it made, so moving one would rewrite when a resident's bay ended
 * and therefore when their waiting time restarted - the dialog says so rather than
 * leaving an administrator to wonder why there is only one field.
 */
@Component({
  selector: 'app-rename-cycle-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormField,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    LoadingOverlay,
  ],
  template: `
    <h2 mat-dialog-title>Rename period</h2>

    <app-loading-overlay [active]="facade.busy()" [veil]="false" label="Renaming the period">
      <mat-dialog-content class="form">
        <mat-form-field appearance="outline">
          <mat-label>Name</mat-label>
          <input matInput [formField]="f.label" autocomplete="off" cdkFocusInitial />
          <mat-error>{{ err(f.label) }}</mat-error>
        </mat-form-field>

        <p class="fixed">
          Runs {{ cycle.startsOn | date: 'd MMM y' }} to {{ cycle.endsOn | date: 'd MMM y' }}.
          Those dates are stamped on every assignment this period made, so they do not
          change here.
        </p>

        @if (facade.error(); as e) {
          <div class="msg msg--bad" role="alert">{{ e.message }}</div>
        }
      </mat-dialog-content>
    </app-loading-overlay>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button
        matButton="filled"
        [disabled]="!dirty() || facade.busy()"
        [class.is-pending]="facade.busy()"
        (click)="submit()"
      >
        {{ facade.busy() ? 'Saving…' : 'Save name' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .form {
        display: flex;
        flex-direction: column;
        gap: var(--sp-2);
        padding-top: var(--sp-2);
        min-width: 22rem;
      }
      .fixed {
        margin: 0;
        font-size: var(--t-fine);
        color: var(--steel-faint);
        max-width: 44ch;
      }
      @media (max-width: 30rem) {
        .form {
          min-width: 0;
        }
      }
    `,
  ],
})
export class RenameCycleDialog {
  readonly facade = inject(CyclesFacade);
  private readonly ref = inject(MatDialogRef<RenameCycleDialog>);
  readonly cycle = inject<Cycle>(MAT_DIALOG_DATA);

  readonly model = signal({ label: this.cycle.label });

  readonly f = form(this.model, (p) => {
    required(p.label, { message: 'A period needs a name.' });
    pattern(p.label, NOT_BLANK, { message: 'A period needs a name.' });
    maxLength(p.label, LIMITS.cycleLabel, { message: `Up to ${LIMITS.cycleLabel} characters.` });
  });

  readonly err = fieldError;

  constructor() {
    this.facade.dismissError();
    // Nor does it outlive the dialog: left set, the page behind would print it next.
    inject(DestroyRef).onDestroy(() => this.facade.dismissError());
  }

  /**
   * Something other than the current name. An emptied field counts as a change, so the
   * button stays live and pressing it says why an empty name cannot be saved.
   */
  dirty(): boolean {
    return this.model().label.trim() !== this.cycle.label;
  }

  async submit(): Promise<void> {
    await submitForm(this.f, async () => {
      if (!this.dirty()) return;
      const saved = await this.facade.rename(this.cycle.id, this.model().label.trim());
      if (saved) this.ref.close(true);
    });
  }
}
