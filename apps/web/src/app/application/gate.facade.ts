import { Injectable, computed, inject, signal } from '@angular/core';
import { CaptureRepository, type CaptureTicket } from '../domain/repositories';

/**
 * One attempt to hand a frame to the system, kept so the person installing the camera can
 * see what happened without a console open.
 */
export interface GateAttempt {
  readonly at: Date;
  readonly captureId: string | null;
  readonly objectKey: string | null;
  readonly bytes: number;
  readonly state: 'sending' | 'sent' | 'failed';
  readonly error: string | null;
}

/** How many attempts the screen remembers. A gate runs for days; the log is not a record. */
const KEPT = 12;

/**
 * The gate client's state (M-7).
 *
 * This facade knows nothing about cameras or canvases - those are the component's, because
 * they are DOM. What lives here is the part that would otherwise be untestable: the two
 * step upload, what counts as a failure, and the short history the screen shows.
 *
 * It does not poll for verdicts, and that is deliberate rather than unfinished. The device
 * at the barrier is not told which resident was recognised: the answer names a person and
 * their car, and a screen at a gate is read by whoever is standing next to it. The gate log
 * is where that answer belongs, behind an administrator's sign-in.
 */
@Injectable({ providedIn: 'root' })
export class GateFacade {
  private readonly captures = inject(CaptureRepository);

  private readonly _attempts = signal<readonly GateAttempt[]>([]);
  private readonly _sending = signal(false);

  readonly attempts = this._attempts.asReadonly();
  readonly sending = this._sending.asReadonly();
  readonly sentCount = computed(() => this._attempts().filter((a) => a.state === 'sent').length);
  readonly lastError = computed(() => this._attempts().find((a) => a.state === 'failed')?.error ?? null);

  /**
   * Ticket, then PUT.
   *
   * A failure of either step is recorded against the attempt rather than thrown: a camera
   * that loses its uplink for one frame has not failed, it has missed a frame, and the next
   * one will do. The caller gets a boolean so an automatic loop can back off.
   */
  async send(cameraId: string, frame: Blob): Promise<boolean> {
    const at = new Date();
    const pending: GateAttempt = {
      at,
      captureId: null,
      objectKey: null,
      bytes: frame.size,
      state: 'sending',
      error: null,
    };
    this.push(pending);
    this._sending.set(true);

    let ticket: CaptureTicket | null = null;
    try {
      ticket = await this.captures.ticket({
        cameraId,
        capturedAt: at,
        contentType: frame.type === 'image/png' ? 'image/png' : 'image/jpeg',
      });
      await this.captures.upload(ticket, frame);
      this.replace(at, {
        ...pending,
        captureId: ticket.captureId,
        objectKey: ticket.objectKey,
        state: 'sent',
      });
      return true;
    } catch (e) {
      this.replace(at, {
        ...pending,
        captureId: ticket?.captureId ?? null,
        objectKey: ticket?.objectKey ?? null,
        state: 'failed',
        // Which step failed is the first thing anyone debugging a gate wants to know.
        error: `${ticket === null ? 'Requesting the upload ticket' : 'Uploading the frame'} failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
      return false;
    } finally {
      this._sending.set(false);
    }
  }

  private push(a: GateAttempt): void {
    this._attempts.update((list) => [a, ...list].slice(0, KEPT));
  }

  private replace(at: Date, a: GateAttempt): void {
    this._attempts.update((list) => list.map((x) => (x.at === at ? a : x)));
  }
}
