import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { ApiError, PlateRead } from '../domain/models';
import { PlateRepository } from '../domain/repositories';
import { toApiError } from '../core/http/api-error';

/** How many arrivals the board shows. A board is not a log; the log is one click away. */
const KEPT = 6;

/**
 * How many reads to ask for to find those arrivals.
 *
 * Much larger than KEPT, because most rows are not arrivals: a lane sends a frame every
 * two seconds whether or not a car is in it, and a single car crossing produces one
 * arrival plus a run of duplicates. Thirty reads is about a minute of an idle lane at the
 * default cadence, so the last real arrival survives a quiet spell on the board.
 */
const FETCH = 30;

/**
 * How often the board asks. Two seconds, matching the camera's default cadence.
 *
 * Polling and not a socket, deliberately. The arrival is already several hops old by the
 * time it could be pushed - S3 notification, Rekognition, a DynamoDB stream with its own
 * batch window - so a socket would deliver a two-second-old event in real time and cost a
 * WebSocket API, a connection table and a fan-out path for it. At one small building's
 * traffic the poll is one indexed query every two seconds, and it keeps working through a
 * laptop lid closing, which a socket does not.
 */
const POLL_MS = 2_000;

/** When a read stops being "now at the gate" and becomes something that happened. */
export const CURRENT_WINDOW_MS = 90_000;

/**
 * The arrivals board (M-7): what the camera is seeing, as it sees it.
 *
 * This is the "real-time vehicle detection using license plate recognition cameras"
 * requirement as a surface. The gate log answers "what came through today"; this answers
 * "who just arrived", which is a different question with a different shape - one car at a
 * time, large enough to read across a room, with everything the person on duty needs to
 * wave it through or walk over to it: the plate, the resident, their unit, the car on
 * file and the bay they hold.
 *
 * It owns no filters and no paging. A board that can be filtered is a log.
 */
@Injectable({ providedIn: 'root' })
export class ArrivalsFacade {
  private readonly repo = inject(PlateRepository);

  private readonly _rows = signal<readonly PlateRead[]>([]);
  private readonly _error = signal<ApiError | null>(null);
  private readonly _lastAt = signal<Date | null>(null);
  private readonly _live = signal(false);
  /** Ticks with the poll so "updated 3s ago" is recomputed rather than frozen. */
  private readonly _now = signal(Date.now());
  /** When the current watch began. Reads older than this are the log's, not the screen's. */
  private readonly _since = signal<Date | null>(null);

  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  readonly rows = this._rows.asReadonly();
  readonly error = this._error.asReadonly();
  readonly live = this._live.asReadonly();

  /**
   * Arrivals, which is not the same list as reads.
   *
   * Two kinds of row are dropped, and both were found by watching a real camera:
   *
   *   - **Duplicates inside the cooldown.** A car creeping towards the barrier is
   *     photographed every two seconds and the server marks every frame after the first
   *     as DISCARDED - correctly, since one car arriving is one arrival. On the board
   *     they buried the thing it exists to show: six rows of "Same car again" with the
   *     verdict pushed off the bottom, under a headline reading "Same car again · No
   *     reason recorded" instead of why the barrier did or did not open.
   *   - **Frames with no plate in them.** A lane with no car in it is still being
   *     photographed every two seconds, and every one of those frames is a legitimate
   *     unreadable read. They arrive newer than the last real recognition, so within
   *     seconds of a car passing the board had replaced it with a blank: no plate, "Not
   *     registered", "Not decided". That is the empty lane, truthfully reported, and
   *     completely useless on a board whose question is "who just arrived".
   *
   * Both stay in the gate log, which is the record. This is the board, which is a view.
   */
  private readonly arrivals = computed(() => {
    const since = this._since();
    return this._rows()
      .filter(
        (r) =>
          r.status !== 'DISCARDED' &&
          r.plate !== null &&
          (since === null || r.capturedAt.getTime() >= since.getTime()),
      )
      .slice(0, KEPT);
  });

  /** The arrival the board is about: the newest one, newest first from the server. */
  readonly current = computed<PlateRead | null>(() => this.arrivals()[0] ?? null);
  readonly earlier = computed(() => this.arrivals().slice(1));

  /**
   * Whether that arrival is still happening.
   *
   * Without this the board would show a car from an hour ago as though it were at the
   * barrier now, which is the one way a live display can actively mislead. After the
   * window it is still shown - an empty board tells the person on duty nothing - but it
   * is labelled as past.
   */
  readonly currentIsNow = computed(() => {
    const at = this.current()?.capturedAt;
    return at ? this._now() - at.getTime() < CURRENT_WINDOW_MS : false;
  });

  readonly secondsSinceUpdate = computed(() => {
    const at = this._lastAt();
    return at === null ? null : Math.max(0, Math.round((this._now() - at.getTime()) / 1000));
  });

  constructor() {
    // A board left polling after its page is gone is a request every two seconds for the
    // rest of the session.
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /**
   * Begin watching, counting only what arrives from `since` onwards.
   *
   * The window exists because the first poll of a session returns whatever the gate read
   * last - which can be hours old, and which would appear the instant somebody pressed
   * Start, in the largest type on the screen, labelled with the time it was captured.
   * Anything before the camera was switched on belongs to the log, not to the screen.
   */
  start(since: Date = new Date()): void {
    this._since.set(since);
    if (this.timer !== null) return;
    this._live.set(true);
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this._live.set(false);
  }

  toggle(): void {
    if (this._live()) this.stop();
    else this.start();
  }

  /**
   * Forget what is on screen.
   *
   * Called when the camera stops, because the arrival is a property of a camera that is
   * running. Left in place it becomes a read from an unknown time ago displayed in the
   * largest type on the screen, under a heading that says it was captured - which is the
   * one way a live display can lie. The read itself is not lost: every frame is in the
   * log below, which is the record.
   */
  clear(): void {
    this._rows.set([]);
    this._lastAt.set(null);
    this._error.set(null);
    this._since.set(null);
  }

  /**
   * One pass.
   *
   * Overlapping requests are skipped rather than queued: on a slow connection a two
   * second interval against a three second request would otherwise open a second
   * connection per tick until the browser's limit, and the answers would start arriving
   * out of order - which on a board that only ever shows the newest row means the display
   * jumping backwards.
   */
  async poll(): Promise<void> {
    this._now.set(Date.now());
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const page = await this.repo.list({ limit: FETCH });
      this._rows.set(page.items);
      this._lastAt.set(new Date());
      this._error.set(null);
    } catch (e) {
      /*
       * A failed poll does not blank the board. The last arrival is still the last thing
       * that happened, and a camera lane is exactly where a connection drops for a few
       * seconds; clearing the display would turn a blip into "nothing is arriving".
       */
      this._error.set(toApiError(e));
    } finally {
      this.inFlight = false;
    }
  }
}
