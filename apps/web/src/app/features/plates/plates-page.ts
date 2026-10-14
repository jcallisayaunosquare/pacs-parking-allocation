import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { MatMenuModule } from '@angular/material/menu';
import { MatTableModule } from '@angular/material/table';
import { PlatesFacade } from '../../application/plates.facade';
import type { PlateRead } from '../../domain/models';
import { StatusPill, type PillTone } from '../../shared/ui/status-pill';
import { ViewStateHost } from '../../shared/ui/view-state';
import { Pager } from '../../shared/ui/pager';
import { PlateReviewDialog } from './plate-review-dialog';
import { DECISION_LABEL, REASON_LABEL } from './reason-label';
import { toastFacadeErrors } from '../../shared/ui/toast';

/**
 * Admin — the gate log (M-7).
 *
 * The screen is a register, not a dashboard: one row per frame the camera captured, in
 * fixed columns, newest first. That is the direction contract's COLUMNS NEVER MOVE raise
 * applied to a live feed - rows arrive and the reader's eye does not have to re-find
 * anything.
 *
 * What it refuses to do is show the images. Every frame is a photograph of a resident's
 * car, and a log that renders fifty of them is a surveillance wall rather than a record;
 * it would also mean fifty five-minute credentials handed to the browser to draw one
 * page. The capture reference is printed instead, and the frame is fetched only when
 * somebody opens a read to review it.
 *
 * The one filter is "needs review", and it is the only one worth a control: it is the
 * single question an administrator opens this page to answer, and the server answers it
 * with a different ordering - oldest first - because a doubtful read loses its value once
 * the car has gone.
 */
@Component({
  selector: 'app-plates-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Reflected to an attribute so the host styles can drop the page's own measure and
  // gutters: a `:host` rule cannot read an input any other way.
  host: { '[attr.data-embedded]': 'embedded()' },
  imports: [
    DatePipe,
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatMenuModule,
    MatTableModule,
    StatusPill,
    ViewStateHost,
    Pager,
  ],
  template: `
    @if (!embedded()) {
      <header class="head">
        <div>
          <h1 class="head__h">Gate log</h1>
          <p class="head__p">
            What the cameras read, what it was matched to, and what was decided.
          </p>
        </div>
      </header>
    }

    @if (facade.metrics(); as m) {
      <!--
        Four numbers, and each one is here because it changes a decision. Match rate says
        whether the engine is working; the queue and its age say whether the building can
        keep up with it; corrections is the size of the evaluation set, which is the figure
        that decides whether this engine stays.
      -->
      <div class="tally">
        <div class="tally__item">
          <span class="tally__n num">{{ matchRate() }}</span>
          <span class="tally__l">matched, last {{ m.windowDays ?? 30 }} days</span>
        </div>
        <div class="tally__item">
          <span class="tally__n num">{{ m.pendingReview ?? '—' }}</span>
          <span class="tally__l">waiting for review</span>
        </div>
        <div class="tally__item">
          <span class="tally__n num">{{ oldestPending() }}</span>
          <span class="tally__l">oldest in the queue</span>
        </div>
        <div class="tally__item">
          <span class="tally__n num">{{ m.corrections ?? '—' }}</span>
          <span class="tally__l">corrections on record</span>
        </div>
      </div>
    }

    <div class="filters">
      <mat-checkbox
        [ngModel]="facade.onlyReview()"
        (ngModelChange)="facade.setOnlyReview($event)"
      >
        Needs review only
      </mat-checkbox>

      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Plate</mat-label>
        <input
          matInput
          class="num"
          [ngModel]="facade.plate() ?? ''"
          (ngModelChange)="facade.setPlate($event || undefined)"
          placeholder="1234ABC"
        />
      </mat-form-field>

      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Camera</mat-label>
        <input
          matInput
          [ngModel]="facade.cameraId() ?? ''"
          (ngModelChange)="facade.setCameraId($event || undefined)"
          placeholder="gate-north"
        />
      </mat-form-field>

      <!--
        The refresh, beside the filters rather than in the page header.
        It is the same kind of control they are - something that changes what the table
        shows - and the header does not exist in the gate screen, where this component is
        embedded under a live camera. A log that cannot be refetched where it is actually
        read was the defect: a plate was decided, the verdict printed above, and the
        register below still showed only what was there when the page loaded.
        It reloads the two resources behind this table and nothing else. The camera keeps
        streaming, the arrival on screen stays, and no route is navigated - the resource
        holds the previous rows while it refetches, so the table updates in place instead
        of collapsing to a skeleton. (No backticks in comments here: this is inside a
        template literal.)
      -->
      <div class="refresh">
        <button
          matIconButton
          type="button"
          [disabled]="facade.refreshing()"
          [attr.aria-label]="label()"
          (click)="facade.refresh()"
        >
          <!--
            The signal colour while the fetch is in flight, and nothing else: that colour
            carries action in this world, and a fetch is the one action this control has.
            Deliberately not a spinning icon - the screen above this one rejected a
            pulsing dot for the same reason, which is that a gate log is watched for hours
            and anything that moves forever gets covered over.
          -->
          <mat-icon aria-hidden="true" [class.refresh__i--on]="facade.refreshing()">
            refresh
          </mat-icon>
        </button>
        <!--
          Announced but not drawn: the rows change under the reader without anything
          moving, so somebody who refreshed and saw no new row needs to be told the fetch
          happened. The sighted reader reads the same fact off the first row's Captured
          column, which is why no timestamp is printed beside the icon - the table already
          says how fresh it is, in the fixed column where that figure lives.
        -->
        <span class="sr-only" role="status">{{ label() }}</span>
      </div>
    </div>

    <app-view-state
      [state]="facade.state()"
      [skeletonCount]="8"
      [busy]="facade.busy()"
      loadingLabel="Loading the gate log"
      busyLabel="Saving the review"
      [emptyTitle]="facade.onlyReview() ? 'Nothing waiting for review' : 'No reads yet'"
      [emptyBody]="
        facade.onlyReview()
          ? 'Every read the cameras have sent has been decided. Clear the filter to see the whole log.'
          : 'This fills in as the gate cameras upload frames. Nothing here means no camera has reported yet.'
      "
      (retry)="facade.refresh()"
    >
      <table mat-table [dataSource]="facade.reads()">
        <!--
          The row number, as in every other register: a position, hidden from screen
          readers because "1" through "25" read before each plate is noise.
        -->
        <ng-container matColumnDef="index">
          <th mat-header-cell *matHeaderCellDef class="col-index" aria-hidden="true">#</th>
          <td mat-cell *matCellDef="let r; let i = index" class="col-index" aria-hidden="true">
            {{ facade.rowOffset() + i + 1 }}
          </td>
        </ng-container>

        <ng-container matColumnDef="read">
          <th mat-header-cell *matHeaderCellDef>Read as</th>
          <td mat-cell *matCellDef="let r" data-label="Read as" class="code">
            {{ r.rawText || '—' }}
          </td>
        </ng-container>

        <ng-container matColumnDef="plate">
          <th mat-header-cell *matHeaderCellDef>Canonical</th>
          <td mat-cell *matCellDef="let r" data-label="Canonical" class="code">
            {{ r.plate || '—' }}
            @if (r.correctedPlate && r.correctedPlate !== r.plate) {
              <span class="corrected num">corrected to {{ r.correctedPlate }}</span>
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="confidence">
          <th mat-header-cell *matHeaderCellDef>Confidence</th>
          <td mat-cell *matCellDef="let r" data-label="Confidence" class="num">
            {{ pct(r.fused) }}
            <!--
              The fused value is what the threshold compared against, but the two inputs
              are printed under it: a blurred frame the engine was sure about and a sharp
              frame it was not are opposite faults, and the product alone hides which.
            -->
            <span class="sub num">{{ pct(r.confidence) }} ocr · {{ pct(r.quality) }} crop</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="matched">
          <th mat-header-cell *matHeaderCellDef>Matched</th>
          <td mat-cell *matCellDef="let r" data-label="Matched">
            @if (r.residentName) {
              <span class="who">{{ r.residentName }}</span>
              <span class="sub num">{{ r.spotCode || 'no bay' }}</span>
            } @else {
              <span class="dim">No match</span>
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="decision">
          <th mat-header-cell *matHeaderCellDef>Decision</th>
          <td mat-cell *matCellDef="let r" data-label="Decision">
            @if (r.decision) {
              <app-status-pill [label]="decisionLabel(r)" [tone]="tone(r)" />
            } @else {
              <!--
                No pill, on purpose. A read below the floor produced no access event at
                all, and painting it as a refusal would be the same lie in the interface
                that a DENY row would be in the log.
              -->
              <span class="dim">Not an entry</span>
            }
            <span class="sub">{{ reason(r) }}</span>
            @if (r.reviewedAt) {
              <span class="sub">Reviewed</span>
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="when">
          <th mat-header-cell *matHeaderCellDef>Captured</th>
          <td mat-cell *matCellDef="let r" data-label="Captured" class="num">
            {{ r.capturedAt | date: 'dd MMM HH:mm:ss' }}
            <span class="sub num">{{ r.cameraId }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="capture">
          <th mat-header-cell *matHeaderCellDef>Capture</th>
          <td mat-cell *matCellDef="let r" data-label="Capture" class="num ref">
            {{ r.captureId }}
          </td>
        </ng-container>

        <!--
          The same ⋮ menu every register has. It used to be an outlined Review button on
          some rows and the word "reviewed" on others, which made this the one table whose
          last column changed shape row by row. The queue is still findable at a glance by
          the mark down the left edge of a row that needs review.
        -->
        <ng-container matColumnDef="actions">
          <th mat-header-cell *matHeaderCellDef><span class="sr-only">Actions</span></th>
          <td mat-cell *matCellDef="let r" class="acts">
            <button
              matIconButton
              type="button"
              [disabled]="facade.busy()"
              [matMenuTriggerFor]="rowMenu"
              [attr.aria-label]="'Actions for the read ' + (r.plate || r.captureId)"
            >
              <mat-icon>more_vert</mat-icon>
            </button>
            <mat-menu #rowMenu="matMenu">
              @if (r.needsReview) {
                <button mat-menu-item type="button" (click)="review(r)">Review</button>
              }
              <button mat-menu-item type="button" (click)="copyRef(r)">
                Copy capture reference
              </button>
            </mat-menu>
          </td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="columns"></tr>
        <tr
          mat-row
          *matRowDef="let row; columns: columns"
          [class.row--review]="row.needsReview"
        ></tr>
      </table>

      @if (facade.hasPrevious() || facade.hasNext()) {
        <app-pager
          [page]="facade.pageNumber()"
          [pageSize]="facade.limit()"
          [count]="facade.reads().length"
          [hasPrevious]="facade.hasPrevious()"
          [hasNext]="facade.hasNext()"
          (previous)="facade.previousPage()"
          (next)="facade.nextPage()"
        />
      }
    </app-view-state>
  `,
  styles: [
    `
      :host {
        width: 100%;
        max-width: 92rem;
        margin: 0 auto;
        padding: var(--sp-6) var(--sp-5) var(--sp-8);
        display: flex;
        flex-direction: column;
        gap: var(--sp-4);
      }

      /* Embedded, the page around it owns the measure and the gutters. Keeping them here
         too would indent the log from a page that has already indented it. */
      :host([data-embedded='true']) {
        max-width: none;
        padding: 0;
      }

      /*
       * Tabular figures on every plate and every measurement. A plate is read character
       * by character against another plate, and proportional digits make two plates that
       * differ in one position look different in every position.
       */
      .num {
        font-variant-numeric: tabular-nums;
        font-feature-settings: 'tnum' 1;
      }

      .head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--sp-5);
        flex-wrap: wrap;
      }
      .head__h {
        font-size: var(--t-head);
      }
      .head__p {
        color: var(--steel-soft);
        margin-top: var(--sp-1);
        max-width: 60ch;
      }

      .tally {
        display: flex;
        gap: var(--sp-7);
        flex-wrap: wrap;
      }
      .tally__item {
        display: flex;
        flex-direction: column;
        border-top: 3px solid var(--steel);
        padding-top: var(--sp-2);
        min-width: 8rem;
      }
      .tally__n {
        font-size: 2rem;
      }
      .tally__l {
        font-size: var(--t-fine);
        color: var(--steel-soft);
      }

      .filters {
        display: flex;
        gap: var(--sp-5);
        align-items: center;
        flex-wrap: wrap;
        border-bottom: 1px solid var(--rule);
        padding-bottom: var(--sp-4);
      }
      .filters mat-form-field {
        width: 12rem;
      }

      /* Pushed to the far end of the filter row: it acts on the whole table, not on one
         field, so it does not sit in the run of fields. */
      .refresh {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        margin-left: auto;
      }
      /* In flight, the glyph takes the signal colour - the one colour this world spends
         on action - and holds still. No spinner: the gate screen above this table refused
         a pulsing dot for the same reason, which is that a log watched for hours covers
         over anything that moves forever. */
      /* Both selectors, and the disabled one is not redundant: the control disables
         itself while the fetch runs, and Material paints a disabled icon in its own
         grey - which is the one moment this glyph has something to say. */
      .refresh .refresh__i--on,
      .refresh button:disabled .refresh__i--on {
        color: var(--signal);
      }

      /* The table and its shared cells (.code, .sub, .dim, .acts) are styles.scss's. */
      .who {
        display: block;
      }
      .corrected {
        display: block;
        font-size: var(--t-fine);
        color: var(--attention);
      }
      .ref {
        font-size: var(--t-fine);
        color: var(--steel-faint);
        word-break: break-all;
        max-width: 14rem;
      }
      /* A left rule, not a tinted row: the queue is marked, not highlighted. */
      .row--review td:first-child {
        box-shadow: inset 3px 0 0 var(--signal);
      }

      @media (max-width: 40rem) {
        .head {
          flex-direction: column;
          align-items: stretch;
        }
        .tally {
          gap: var(--sp-5);
        }
        .filters mat-form-field {
          width: 100%;
        }
        .refresh {
          margin-left: 0;
        }
        .ref {
          max-width: none;
        }
      }
    `,
  ],
})
export default class PlatesPage {
  /**
   * Set when the log is the lower half of the gate screen rather than a page of its own.
   *
   * Only the page furniture changes - its own title, and the measure and padding a page
   * owns. The table, the filters, the tally and the review dialog are identical, because
   * they are the same job in both places and a second copy of them would be the first
   * thing to drift.
   */
  readonly embedded = input(false);

  readonly facade = inject(PlatesFacade);
  /** A refused row action is answered by a toast; a dialog's error stays in the dialog. */
  private readonly errorToasts = toastFacadeErrors(this.facade);
  private readonly dialog = inject(MatDialog);
  private readonly announcer = inject(LiveAnnouncer);

  readonly columns = [
    'index',
    'read',
    'plate',
    'confidence',
    'matched',
    'decision',
    'when',
    'capture',
    'actions',
  ];

  /**
   * The icon's accessible name, and what is announced once a fetch has finished.
   *
   * The name carries the freshness because a glyph cannot: it says "refresh" and not
   * "these rows are four minutes old", and somebody who presses it and sees no new row
   * has no way to tell a working control from a quiet gate. The sighted reader takes that
   * from the first row's Captured column rather than from a second clock on the screen.
   */
  readonly label = computed(() => {
    if (this.facade.refreshing()) return 'Refreshing the table';
    const at = this.facade.refreshedAt();
    return at === null
      ? 'Refresh the table'
      : `Refresh the table. Rows as at ${at.toLocaleTimeString()}`;
  });

  /** Null-safe, because the server may not have sent a figure this build knows about. */
  readonly matchRate = computed(() => {
    const m = this.facade.metrics();
    if (!m || m.reads === null || m.reads === 0 || m.matched === null) return '—';
    return `${Math.round((m.matched / m.reads) * 100)}%`;
  });

  readonly oldestPending = computed(() => {
    const h = this.facade.metrics()?.oldestPendingHours ?? null;
    if (h === null) return '—';
    return h < 1 ? `${Math.round(h * 60)}m` : `${h.toFixed(1)}h`;
  });

  pct(v: number | null): string {
    return v === null ? '—' : `${Math.round(v * 100)}%`;
  }

  decisionLabel(r: PlateRead): string {
    return r.decision ? DECISION_LABEL[r.decision] ?? r.decision : '';
  }

  reason(r: PlateRead): string {
    return r.reason ? REASON_LABEL[r.reason] ?? r.reason : '';
  }

  /**
   * Tone reinforces the word, it never carries the meaning on its own: the label is the
   * information, so the row survives greyscale and colour-blind vision (WCAG 2.2 AA).
   */
  tone(r: PlateRead): PillTone {
    switch (r.decision) {
      case 'ALLOW':
        return 'held';
      case 'DENY':
        return 'revoked';
      case 'REVIEW':
        return 'attention';
      default:
        return 'idle';
    }
  }

  /**
   * The capture reference is what support and the evidence store are keyed on, and the
   * column prints it in fine type that is tedious to select by hand. The confirmation is
   * announced rather than toasted: this product has no toasts, and a copy is otherwise
   * silent for a screen-reader user.
   */
  async copyRef(r: PlateRead): Promise<void> {
    try {
      await navigator.clipboard.writeText(r.captureId);
      void this.announcer.announce(`Capture reference ${r.captureId} copied`);
    } catch {
      void this.announcer.announce('The browser did not allow copying to the clipboard');
    }
  }

  review(r: PlateRead): void {
    this.facade.dismissError();
    this.dialog.open(PlateReviewDialog, {
      data: r,
      width: '38rem',
      maxWidth: 'calc(100vw - 2rem)',
    });
  }
}
