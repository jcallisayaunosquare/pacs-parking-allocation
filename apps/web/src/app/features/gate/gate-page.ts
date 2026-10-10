import {
  ChangeDetectionStrategy,
  Component,
  type OnDestroy,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { GateFacade } from '../../application/gate.facade';
import { ArrivalsFacade } from '../../application/arrivals.facade';
import { AuthStore } from '../../core/auth/auth.store';
import type { PlateRead } from '../../domain/models';
import { REASON_LABEL } from '../plates/reason-label';
import PlatesPage from '../plates/plates-page';
import { environment } from '../../../environments/environment';

/** Where the gate's own name is kept, so a device remembers it across a reload. */
const CAMERA_ID_KEY = 'pacs.gate.cameraId';
/**
 * The long edge the frame is scaled to before upload.
 *
 * 1280 and not the sensor's full resolution: Rekognition's own limit is 5 MB for inline
 * bytes and the plate occupies a few hundred pixels either way, while a 4 K frame over a
 * car park uplink is the difference between one capture a second and one every six. If
 * plates start coming back unreadable this is the first number to raise.
 */
const MAX_EDGE = 1280;
/** JPEG, not PNG: a photograph compresses, and the bucket notification accepts both. */
const MIME = 'image/jpeg';
const QUALITY = 0.82;

/**
 * Focus measurement: the variance of the Laplacian, on a small grey copy of the frame.
 *
 * A blurred image has no sharp edges, so the second derivative is near zero everywhere
 * and its variance collapses; a frame with a plate in it, in focus, has a lot of high
 * contrast edges and the variance is large. It is the standard cheap blur detector and it
 * needs no library, no model and about a millisecond on a 320 px copy - which matters,
 * because this runs several times a second on whatever machine is sitting at the gate.
 *
 * What it does NOT do is detect a plate. A sharp photograph of an empty lane scores well.
 * It is a floor, not a judgement: it stops us spending a Rekognition call and a stored
 * frame on an image nothing could be read from.
 */
const SAMPLE_EDGE = 320;
const FOCUS_POLL_MS = 250;
/**
 * The variance above which a frame is worth sending, and the figure most worth revisiting
 * on real hardware. Measured on a 1080p webcam at about two metres: a hand-held plate in
 * focus sat around 900-1800, the same plate moving sat under 150, and an empty lit room
 * sat around 250. 400 keeps the moving blur out without demanding a studio.
 */
const FOCUS_CLEAR = 400;
/** The scale the meter is drawn against, so a good frame is not pinned at the top. */
const FOCUS_FULL = 1600;

/**
 * On demand, one click takes a short burst and keeps the sharpest frame.
 *
 * A person pressing a button is reacting to what they saw, which is already 200 ms old,
 * and a car is moving. Five frames over half a second costs one upload and almost always
 * contains one frame better than the one under the finger.
 */
const BURST_FRAMES = 5;
const BURST_GAP_MS = 110;

/**
 * The three ways a frame reaches the recogniser.
 *
 * `continuous` is a lane running by itself. `on-demand` is a person at the barrier
 * choosing the instant. `captured` is a photograph that already exists - a frame pulled
 * off a DVR, a picture taken on a phone, the evidence somebody sends after the fact - fed
 * to the same pipeline. All three end at the same presigned PUT, which is the point: the
 * recognition does not know or care which one it was.
 */
export type GateMode = 'continuous' | 'on-demand' | 'captured';

const toMode = (raw: string): GateMode =>
  raw === 'on-demand' || raw === 'captured' ? raw : 'continuous';

/** What a file has to be before it is worth a presigned PUT: the API accepts these two. */
const ACCEPTED_TYPES = ['image/jpeg', 'image/png'];
/**
 * Above this, the file is re-encoded rather than sent as it is.
 *
 * Rekognition reads an S3 object up to 15 MB, so this is not its limit - it is the car
 * park's uplink and the operator's patience. A phone photograph is routinely 4 MB of
 * detail that a plate occupying 300 px across does not need.
 */
const MAX_UPLOAD_BYTES = 2_500_000;

/** The headline the screen exists to print, and the tone it is printed in. */
interface Verdict {
  readonly word: string;
  readonly tone: 'ok' | 'warn' | 'bad' | 'none';
  readonly detail: string;
}

/**
 * The gate (M-7): one screen for the whole thing.
 *
 * It was three - a camera page, a live board and a log - and that was one screen too many
 * in each direction. They are one job: a car arrives, the camera reads its plate, and the
 * building either knows the car or does not. Splitting that across three menu entries
 * made a person choose between watching what is happening and seeing what happened, which
 * is not a choice anybody wants to make while a car is at the barrier.
 *
 * So, top to bottom: the camera and what it is sending; the arrival, in the largest type
 * on the screen, with the one answer the person on duty needs - whether this car has
 * parking - and the time it was captured; then the full record underneath, filters and
 * review and all, which is the same component the log page was.
 *
 * Who sees what: a CAMERA account is a device bolted to a wall in a car park, and it gets
 * the capture half only. The verdict names a resident, their unit and their car, and that
 * is an administrator's to read.
 */
@Component({
  selector: 'app-gate-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    PlatesPage,
  ],
  template: `
    <header class="head">
      <div>
        <h1 class="head__h">Gate</h1>
        <p class="head__p">
          The camera reads the plate of every car that arrives and matches it against the
          vehicle register.
        </p>
      </div>

      @if (isAdmin) {
        <p class="live" role="status">
          <span class="live__dot" [class.live__dot--on]="arrivals.live()" aria-hidden="true"></span>
          @if (arrivals.live()) {
            Listening
            @if (arrivals.secondsSinceUpdate() !== null) {
              · checked {{ arrivals.secondsSinceUpdate() }}s ago
            }
          } @else {
            Camera off
          }
        </p>
      }
    </header>

    @if (offline) {
      <!--
        The stub has no S3 and no Rekognition, and a capture screen that appeared to work
        against it would be the most misleading thing in the product: frames would seem to
        go somewhere and no plate would ever be read.
      -->
      <p class="alert" role="alert">
        This screen is running against the in-memory stub, which has no capture store.
        Frames cannot be sent. Start the app with <code>pnpm start</code> instead.
      </p>
    }

    <!--
      Camera on the left, verdict on the right, and they do not swap: the preview is what
      you adjust and the verdict is what you read, so each keeps its side. Below 64rem
      they stack with the verdict first, because on a phone the answer matters more than
      the picture.
    -->
    <div class="deck">
      <section class="cam" aria-label="Camera">
        <!--
          muted and playsinline, or iOS refuses to play the stream inline and the preview
          stays black while the frames upload perfectly - which looks exactly like a
          broken camera.
        -->
        <!--
          The video element stays in the DOM in every mode, hidden rather than removed:
          the capture code holds a required reference to it, and a mode switch that
          destroyed it would take the reference with it.
        -->
        <video #video class="cam__v" autoplay muted playsinline [hidden]="fromFile()"></video>
        <canvas #canvas hidden></canvas>
        <canvas #sample hidden></canvas>

        @if (fromFile()) {
          <!--
            The drop zone takes the same box the preview had, so switching modes does not
            move everything below it. A label wrapping a hidden input, rather than a
            button that clicks one: that is what makes the whole area a drop target and a
            keyboard-reachable control at the same time.
          -->
          <label
            class="drop"
            [class.drop--over]="dragging()"
            (dragover)="onDragOver($event)"
            (dragleave)="onDragLeave()"
            (drop)="onDrop($event)"
          >
            <input
              class="sr-only"
              type="file"
              accept="image/jpeg,image/png"
              [disabled]="uploading()"
              (change)="onFileChosen($event)"
            />
            @if (filePreview(); as src) {
              <img class="drop__img" [src]="src" alt="The photograph that was sent" />
            } @else {
              <span class="drop__t">
                {{ uploading() ? 'Reading…' : 'Drop a photograph here, or choose one' }}
              </span>
              <span class="drop__h">JPEG or PNG. Large files are scaled down before upload.</span>
            }
          </label>

          @if (fileName(); as name) {
            <p class="cam__s">
              Sent {{ name }}
              <button class="link" type="button" (click)="clearFile()">Clear</button>
            </p>
          }
          @if (fileError()) {
            <p class="alert" role="alert">{{ fileError() }}</p>
          }
        }

        <!--
          The mode, above the controls it changes. Two buttons rather than a tab strip:
          the direction contract has no tabs in it, and these are not two views of the
          same thing - they are two ways of working, and the one in force changes what
          the button below does.
        -->
        <div class="mode" role="group" aria-label="Capture mode">
          <button
            class="mode__b"
            type="button"
            [attr.aria-pressed]="mode() === 'continuous'"
            (click)="setMode('continuous')"
          >
            Continuous
          </button>
          <button
            class="mode__b"
            type="button"
            [attr.aria-pressed]="mode() === 'on-demand'"
            (click)="setMode('on-demand')"
          >
            On demand
          </button>
          <button
            class="mode__b"
            type="button"
            [attr.aria-pressed]="mode() === 'captured'"
            (click)="setMode('captured')"
          >
            Captured
          </button>
        </div>
        <p class="mode__h">
          @switch (mode()) {
            @case ('continuous') {
              The lane runs by itself: a frame every {{ intervalSeconds() }}s, and blurred
              frames are not sent at all.
            }
            @case ('on-demand') {
              Nothing is sent until you press. One press takes a short burst and keeps the
              sharpest frame of it.
            }
            @case ('captured') {
              No camera. A photograph you already have is read by the same recogniser.
            }
          }
        </p>

        @if (running()) {
          <!--
            The focus meter. It is here because "wait until the image is clear" is not
            something a person can judge from a preview on a laptop screen at arm's
            length, and because the capture button needs a reason to be disabled that the
            operator can see changing.
          -->
          <div class="focus">
            <div class="focus__track" aria-hidden="true">
              <div
                class="focus__fill"
                [class.focus__fill--ok]="clear()"
                [style.transform]="'scaleX(' + focusPercent() / 100 + ')'"
              ></div>
            </div>
            <p class="focus__l" role="status">
              {{ clear() ? 'Sharp enough' : 'Too blurred to read' }}
              <span class="num">· {{ focus() | number: '1.0-0' }}</span>
            </p>
          </div>
        }

        <div class="cam__bar">
          @if (fromFile()) {
            <!-- Nothing: the drop zone is the control in this mode. -->
          } @else if (!running()) {
            <button matButton="filled" type="button" (click)="start()">Start the camera</button>
          } @else {
            @if (mode() === 'on-demand') {
              <!--
                The one control the operator uses all day, so it is the biggest thing in
                this column and it says what it will do rather than naming a mechanism.
              -->
              <button
                class="shot"
                type="button"
                [disabled]="!clear() || bursting() || facade.sending()"
                (click)="captureBest()"
              >
                {{ bursting() ? 'Capturing…' : 'Read the plate' }}
              </button>
            } @else {
              <button
                matButton="filled"
                type="button"
                [disabled]="facade.sending()"
                (click)="captureOnce(true)"
              >
                Capture now
              </button>
            }
            <button matButton="outlined" type="button" (click)="stop()">Stop</button>
          }
        </div>

        @if (running()) {
          <p class="cam__s" role="status">
            @if (mode() === 'continuous') {
              {{ facade.sentCount() }} sent
              @if (skipped() > 0) {
                · {{ skipped() }} skipped as blurred
              }
            } @else {
              {{ facade.sentCount() }} captured
            }
            @if (lastFrame(); as f) {
              · last {{ f.bytes / 1024 | number: '1.0-0' }} kB at {{ f.at | date: 'HH:mm:ss' }}
            }
          </p>
        }

        @if (mediaError()) {
          <p class="alert" role="alert">{{ mediaError() }}</p>
        }
        @if (facade.lastError()) {
          <p class="alert" role="alert">{{ facade.lastError() }}</p>
        }

        <!--
          The settings, below the thing they configure and out of the way: a gate is named
          once when it is installed and the interval is changed about as often.
        -->
        <details class="set">
          <summary class="set__t">Camera settings</summary>
          <div class="set__grid">
            <div>
              <label class="set__l" for="gate-name">Gate name</label>
              <input
                id="gate-name"
                class="set__i"
                type="text"
                autocomplete="off"
                spellcheck="false"
                [ngModel]="cameraId()"
                (ngModelChange)="setCameraId($event)"
              />
              <p class="set__h">
                Lower case letters, digits and hyphens. It names the lane in the log, so it
                should name the lane rather than the device.
              </p>
            </div>

            <div>
              <label class="set__l" for="gate-device">Camera</label>
              <select
                id="gate-device"
                class="set__i"
                [ngModel]="deviceId()"
                (ngModelChange)="deviceId.set($event)"
              >
                @for (d of devices(); track d.deviceId) {
                  <option [value]="d.deviceId">{{ d.label || 'Camera' }}</option>
                }
                @if (devices().length === 0) {
                  <option value="">No camera found</option>
                }
              </select>
              <p class="set__h">Listed once permission is granted.</p>
            </div>

            <div>
              <label class="set__l" for="gate-interval">Capture every</label>
              <input
                id="gate-interval"
                class="set__i num"
                type="number"
                min="1"
                max="60"
                step="1"
                [ngModel]="intervalSeconds()"
                (ngModelChange)="setInterval($event)"
              />
              <p class="set__h">
                Seconds. Two sees a car crossing the lane twice; the cooldown keeps that
                from counting as two arrivals.
              </p>
            </div>
          </div>
        </details>
      </section>

      @if (isAdmin) {
        @let now = arrivals.current();
        <section class="read" aria-live="polite" aria-label="Last arrival">
          @if (!arrivals.live()) {
            <p class="read__none">
              @if (fromFile()) {
                Nothing sent yet. Drop a photograph on the left and it will be read here.
              } @else {
                The camera is off. Nothing is shown here while it is: an arrival beside a
                stopped camera is a read from an unknown time ago. Every frame that was
                read is in the log below.
              }
            </p>
          } @else if (now === null) {
            <p class="read__none">
              @if (fromFile()) {
                Reading the photograph. It takes a few seconds: the frame goes to the
                capture store, is recognised there, and the result comes back here.
              } @else {
                Nothing recognised yet. A lane with no car in it still sends frames, and
                they are recorded as unreadable — that is the normal state of a quiet
                gate.
              }
            </p>
          } @else {
            @let v = verdict(now);
            <p class="read__when">
              Captured {{ now.capturedAt | date: 'HH:mm:ss' }} ·
              {{ now.capturedAt | date: 'd MMM' }} · {{ now.cameraId }}
            </p>

            <p class="read__plate stencil">{{ now.plate ?? '—' }}</p>

            <!--
              The headline. It is a word, not a colour: the rule beside it carries the same
              meaning again for anybody who cannot tell the two rules apart, which WCAG
              1.4.1 is about and which a car park at night is also about.
            -->
            <p class="call call--{{ v.tone }}">{{ v.word }}</p>
            <p class="read__why">{{ v.detail }}</p>

            <dl class="who">
              <div>
                <dt>Resident</dt>
                <dd>{{ now.residentName ?? 'Not registered' }}</dd>
              </div>
              <div>
                <dt>Unit</dt>
                <dd class="num">{{ now.unitNumber ?? '—' }}</dd>
              </div>
              <div>
                <dt>Vehicle</dt>
                <dd>{{ car(now) }}</dd>
              </div>
              <div>
                <dt>Bay</dt>
                <dd class="num">
                  {{ now.spotCode ?? (now.residentName ? 'None this period' : '—') }}
                </dd>
              </div>
            </dl>

            @if (now.registeredPlate && now.registeredPlate !== now.plate) {
              <p class="read__note">
                Registered as {{ now.registeredPlate }} · read {{ distanceWord(now) }}
              </p>
            }
          }
        </section>
      }
    </div>

    @if (isAdmin) {
      <section class="log" aria-label="Gate log">
        <h2 class="log__h">Every frame</h2>
        <app-plates-page [embedded]="true" />
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        max-width: 92rem;
        margin: 0 auto;
        padding: var(--sp-6) var(--sp-5) var(--sp-8);
      }

      .head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--sp-5);
        flex-wrap: wrap;
        padding-bottom: var(--sp-4);
        border-bottom: 1px solid var(--rule);
      }

      .head__h {
        margin: 0;
        font-size: var(--t-title);
        font-variation-settings:
          'wdth' 108,
          'wght' 660;
      }

      .head__p {
        margin: var(--sp-2) 0 0;
        max-width: 60ch;
        color: var(--ink-3);
        font-size: var(--t-small);
      }

      .live {
        margin: 0;
        font-size: var(--t-small);
        color: var(--ink-2);
        font-variant-numeric: tabular-nums;
      }

      /* A 7px square, not a pulsing circle: a gate screen is looked at for hours, and
         something that moves forever in the corner of the eye gets covered over. */
      .live__dot {
        display: inline-block;
        width: 7px;
        height: 7px;
        margin-right: var(--sp-2);
        background: var(--ink-3);
        opacity: 0.4;
      }

      .live__dot--on {
        background: var(--signal);
        opacity: 1;
      }

      .alert {
        margin: var(--sp-4) 0 0;
        padding-left: var(--sp-3);
        border-left: 3px solid var(--danger);
        font-size: var(--t-small);
        max-width: 70ch;
      }

      .deck {
        display: grid;
        grid-template-columns: minmax(0, 7fr) minmax(0, 8fr);
        gap: var(--sp-6);
        padding: var(--sp-5) 0;
        border-bottom: 1px solid var(--rule);
      }

      @media (max-width: 64rem) {
        .deck {
          grid-template-columns: 1fr;
        }

        /* The answer above the picture on a narrow screen. */
        .read {
          order: -1;
        }
      }

      /* 16/9 reserved before the stream arrives, so starting the camera does not shove
         the page around. */
      /* A display rule beats the hidden attribute, which is only a presentation default -
         so the hidden video kept its 16/9 box and left a dark slab above the drop zone.
         (No backticks in comments here: this is inside a template literal.) */
      .cam__v[hidden] {
        display: none;
      }

      .cam__v {
        display: block;
        width: 100%;
        aspect-ratio: 16 / 9;
        background: var(--ink-1);
        object-fit: cover;
      }

      /* Two buttons sharing one hairline frame, so the pair reads as one control. */
      .mode {
        display: inline-flex;
        margin-top: var(--sp-4);
        border: 1px solid var(--rule);
      }

      .mode__b {
        font: inherit;
        font-size: var(--t-small);
        min-height: 2.25rem;
        padding: 0 var(--sp-4);
        background: transparent;
        color: var(--ink-3);
        border: 0;
        border-radius: 0;
        cursor: pointer;
      }

      .mode__b + .mode__b {
        border-left: 1px solid var(--rule);
      }

      /* The one in force is darker and heavier - the type channel again, not a fill. */
      .mode__b[aria-pressed='true'] {
        color: var(--ink-1);
        font-variation-settings: 'wght' 620;
        box-shadow: inset 0 -3px 0 0 var(--signal);
      }

      .mode__b:focus-visible {
        outline: 2px solid var(--signal);
        outline-offset: -2px;
      }

      .mode__h {
        margin: var(--sp-2) 0 0;
        font-size: var(--t-fine);
        color: var(--ink-3);
        max-width: 52ch;
      }

      .focus {
        margin-top: var(--sp-4);
      }

      .focus__track {
        height: 4px;
        background: var(--rule-soft);
      }

      /*
       * Full width, scaled down on the X axis, rather than a width that animates.
       *
       * The meter updates four times a second for as long as the camera is on, and a
       * width transition relayouts the page on every one of those frames. A transform is
       * composited and touches no layout - which is the difference between a gate screen
       * that can sit open all shift and one that heats a laptop.
       */
      .focus__fill {
        height: 100%;
        width: 100%;
        transform-origin: left center;
        background: var(--ink-3);
        transition: transform 160ms linear;
      }

      .focus__fill--ok {
        background: var(--signal);
      }

      .focus__l {
        margin: var(--sp-2) 0 0;
        font-size: var(--t-fine);
        color: var(--ink-3);
      }

      /*
       * The shutter. Deliberately not a Material button: on this screen it is the
       * instrument, and it is sized to be hit without looking - the operator is watching
       * the lane, not the laptop.
       */
      .shot {
        font: inherit;
        font-size: var(--t-lead);
        font-variation-settings:
          'wdth' 108,
          'wght' 660;
        min-height: 3.5rem;
        padding: 0 var(--sp-6);
        color: var(--on-primary);
        background: var(--signal);
        border: 0;
        border-radius: 0;
        cursor: pointer;
      }

      .shot:disabled {
        background: var(--rule);
        color: var(--ink-3);
        cursor: not-allowed;
      }

      .shot:focus-visible {
        outline: 2px solid var(--ink-1);
        outline-offset: 2px;
      }

      /* Clipped, so the scaled bar cannot paint outside its track. */
      .focus__track {
        overflow: hidden;
      }

      @media (prefers-reduced-motion: reduce) {
        .focus__fill {
          transition: none;
        }
      }

      /* The same box the preview occupies, so a mode change does not move the page. */
      .drop {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--sp-2);
        width: 100%;
        aspect-ratio: 16 / 9;
        padding: var(--sp-5);
        text-align: center;
        border: 1px dashed var(--rule);
        background: var(--surface-1);
        cursor: pointer;
      }

      .drop--over {
        border-color: var(--signal);
        border-style: solid;
      }

      .drop:focus-within {
        outline: 2px solid var(--signal);
        outline-offset: 2px;
      }

      .drop__img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
      }

      .drop__t {
        font-size: var(--t-small);
        color: var(--ink-2);
      }

      .drop__h {
        font-size: var(--t-fine);
        color: var(--ink-3);
      }

      /* A button that reads as prose, for an action that sits inside a sentence. */
      .link {
        font: inherit;
        padding: 0;
        margin-left: var(--sp-2);
        background: none;
        border: 0;
        color: var(--ink-2);
        text-decoration: underline;
        cursor: pointer;
      }

      .cam__bar {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        flex-wrap: wrap;
        padding-top: var(--sp-4);
      }

      .cam__s {
        margin: var(--sp-3) 0 0;
        font-size: var(--t-small);
        color: var(--ink-3);
        font-variant-numeric: tabular-nums;
      }

      .set {
        margin-top: var(--sp-5);
        border-top: 1px solid var(--rule-soft);
        padding-top: var(--sp-3);
      }

      .set__t {
        font-size: var(--t-fine);
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--ink-3);
        cursor: pointer;
      }

      .set__grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
        gap: var(--sp-4);
        padding-top: var(--sp-4);
      }

      .set__l {
        display: block;
        font-size: var(--t-fine);
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--ink-3);
      }

      .set__i {
        display: block;
        width: 100%;
        margin-top: var(--sp-2);
        min-height: 2.5rem;
        padding: 0 var(--sp-3);
        font: inherit;
        color: var(--ink-1);
        background: transparent;
        border: 1px solid var(--rule);
        border-radius: 0;
      }

      .set__i:focus-visible {
        outline: 2px solid var(--signal);
        outline-offset: 1px;
      }

      .set__h {
        margin: var(--sp-2) 0 0;
        font-size: var(--t-fine);
        color: var(--ink-3);
        max-width: 38ch;
      }

      .read__none {
        margin: 0;
        max-width: 56ch;
        color: var(--ink-3);
      }

      .read__when {
        margin: 0;
        font-size: var(--t-fine);
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--ink-3);
        font-variant-numeric: tabular-nums;
      }

      /* The plate: the one number on this screen that is the point of the screen, which
         is exactly what the stencil treatment is reserved for. */
      .read__plate {
        margin: var(--sp-2) 0 0;
        font-size: var(--t-display);
        font-variant-numeric: tabular-nums;
      }

      /*
       * The call. Large, because the person reading it is three metres away or looking up
       * from a barrier, and set in the width axis the rest of the system paints numbers
       * in so it reads as the same voice rather than a banner bolted on.
       */
      .call {
        margin: var(--sp-4) 0 0;
        padding-left: var(--sp-4);
        border-left: 6px solid var(--rule);
        font-size: var(--t-head);
        letter-spacing: 0.02em;
        text-transform: uppercase;
        font-variation-settings:
          'wdth' 112,
          'wght' 700;
        line-height: 1.1;
      }

      .call--ok {
        border-left-color: var(--signal);
        color: var(--ink-1);
      }

      .call--warn {
        border-left-color: var(--attention);
        color: var(--ink-1);
      }

      .call--bad {
        border-left-color: var(--danger);
        color: var(--ink-1);
      }

      .call--none {
        border-left-color: var(--rule);
        color: var(--ink-2);
      }

      .read__why {
        margin: var(--sp-2) 0 0 calc(var(--sp-4) + 6px);
        font-size: var(--t-small);
        color: var(--ink-3);
      }

      .read__note {
        margin: var(--sp-4) 0 0;
        font-size: var(--t-small);
        color: var(--ink-3);
      }

      /* Four fixed pairs that do not reflow on content: COLUMNS NEVER MOVE applies
         hardest here, because this block changes under the reader's eye every few
         seconds. */
      .who {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
        gap: var(--sp-4);
        margin: var(--sp-5) 0 0;
        padding-top: var(--sp-4);
        border-top: 1px solid var(--rule-soft);
      }

      .who dt {
        font-size: var(--t-fine);
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--ink-3);
      }

      .who dd {
        margin: var(--sp-2) 0 0;
        font-size: var(--t-lead);
        color: var(--ink-1);
      }

      .log {
        padding-top: var(--sp-6);
      }

      .log__h {
        margin: 0 0 var(--sp-4);
        font-size: var(--t-small);
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--ink-3);
      }

      .num {
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
})
export default class GatePage implements OnDestroy {
  readonly facade = inject(GateFacade);
  readonly arrivals = inject(ArrivalsFacade);
  private readonly auth = inject(AuthStore);

  /** True only under `ng serve --configuration offline`. */
  readonly offline = environment.localAuth;

  /**
   * Read once rather than as a signal: the roles on a principal do not change inside a
   * session, and a template that re-evaluated them would start and stop the poll under
   * its own feet.
   */
  readonly isAdmin = this.auth.isAdmin();

  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  /** A second, small canvas: the focus sample must not fight the capture for size. */
  private readonly sample = viewChild.required<ElementRef<HTMLCanvasElement>>('sample');

  readonly devices = signal<readonly MediaDeviceInfo[]>([]);
  readonly deviceId = signal<string>('');
  readonly running = signal(false);

  /**
   * How the gate decides when to capture.
   *
   * `continuous` is a lane running by itself: a frame every few seconds, whatever is in
   * front of it. It is the only mode a CAMERA device can usefully run, because there is
   * nobody at the device to press anything.
   *
   * `on-demand` is a person at the barrier: nothing is sent until they press, and then
   * one deliberate capture is taken from the sharpest of a short burst. It exists because
   * continuous capture has a flaw that showed up the first time a real camera was pointed
   * at a real plate - the cooldown keeps the FIRST frame of a car, which is the one taken
   * while it was still entering the lane, and the better frames behind it are discarded
   * as duplicates. One capture per arrival has no first-frame problem to have.
   */
  readonly mode = signal<GateMode>(toMode(this.readString('pacs.gate.mode', 'continuous')));
  readonly auto = computed(() => this.mode() === 'continuous');
  /** `captured` needs no camera at all, so the whole camera column changes shape. */
  readonly fromFile = computed(() => this.mode() === 'captured');

  /** The variance of the Laplacian on the live frame, sampled a few times a second. */
  readonly focus = signal(0);
  readonly focusPercent = computed(() =>
    Math.min(100, Math.round((this.focus() / FOCUS_FULL) * 100)),
  );
  readonly clear = computed(() => this.focus() >= FOCUS_CLEAR);
  readonly bursting = signal(false);
  /** Automatic ticks that found nothing worth sending. Shown so a dark lens is obvious. */
  readonly skipped = signal(0);

  /** `captured` mode: what was dropped in, shown back so the operator sees what was sent. */
  readonly filePreview = signal<string | null>(null);
  readonly fileName = signal<string | null>(null);
  readonly fileError = signal<string | null>(null);
  readonly uploading = signal(false);
  readonly dragging = signal(false);
  readonly mediaError = signal<string | null>(null);
  readonly intervalSeconds = signal(this.readNumber('pacs.gate.interval', 2));
  readonly cameraId = signal(this.readString(CAMERA_ID_KEY, 'gate-main'));

  /** Valid per the API's own pattern, checked here so a bad name fails before a frame does. */
  readonly nameOk = computed(() => /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(this.cameraId()));

  /** The most recent upload, for the one line that says the uplink is alive. */
  readonly lastFrame = computed(() => this.facade.attempts()[0] ?? null);

  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    /*
     * The loop is an effect on (running, auto, interval) rather than something each
     * handler starts and stops. Three controls can change it, and with the timer owned by
     * the handlers one path or another always ended up leaving a second interval running
     * - which looked like the camera sending twice as fast as it was asked to.
     */
    effect((onCleanup) => {
      const on = this.running() && this.auto();
      const every = Math.max(1, Math.min(60, this.intervalSeconds())) * 1000;
      if (!on) return;
      this.timer = setInterval(() => void this.captureOnce(), every);
      onCleanup(() => {
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
      });
    });

    /*
     * The focus meter runs whenever the camera does, in both modes. On demand it is what
     * the capture button waits for; continuously it is what keeps a smeared frame from
     * costing a Rekognition call and a stored photograph of nothing.
     */
    effect((onCleanup) => {
      if (!this.running()) {
        this.focus.set(0);
        return;
      }
      const id = setInterval(() => this.focus.set(this.measureFocus()), FOCUS_POLL_MS);
      onCleanup(() => clearInterval(id));
    });
  }

  setMode(mode: GateMode): void {
    if (mode === this.mode()) return;
    /*
     * Changing mode ends whatever the last one was doing. A camera left streaming behind
     * a file upload screen is a lit lens nobody can see, and a photograph left on screen
     * under a live camera is the stale-read problem again in a different coat.
     */
    if (mode === 'captured') this.stop();
    else this.clearFile();
    this.mode.set(mode);
    this.write('pacs.gate.mode', mode);
  }


  async start(): Promise<void> {
    this.mediaError.set(null);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(this.deviceId() ? { deviceId: { exact: this.deviceId() } } : {}),
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      this.video().nativeElement.srcObject = this.stream;
      this.running.set(true);
      /*
       * The arrival is tied to the camera, not to the page: no poll on load, and nothing
       * on screen until a camera is running. An arrival shown beside a stopped camera is
       * a read from an unknown time ago, printed in the largest type on the screen under
       * the word "captured". The log below is the record and it is always there.
       */
      if (this.isAdmin) this.arrivals.start();
      // Labels are blank until permission is granted, so the list is only worth filling
      // once a stream exists.
      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = all.filter((d) => d.kind === 'videoinput');
      this.devices.set(cams);
      if (!this.deviceId() && cams[0]) this.deviceId.set(cams[0].deviceId);
    } catch (e) {
      this.running.set(false);
      this.mediaError.set(
        e instanceof Error && e.name === 'NotAllowedError'
          ? 'The browser refused access to the camera. Grant it for this site and start again.'
          : `The camera could not be opened: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  stop(): void {
    this.running.set(false);
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.video().nativeElement.srcObject = null;
    this.skipped.set(0);
    this.arrivals.stop();
    this.arrivals.clear();
  }

  /**
   * How sharp the live frame is, as the variance of its Laplacian.
   *
   * On a 320 px grey copy, because the number only has to be comparable with itself and
   * a full frame would cost ten times as much for the same answer. Returns 0 when there
   * is nothing to measure, which reads as "not clear" everywhere it is used.
   */
  private measureFocus(): number {
    const video = this.video().nativeElement;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w === 0 || h === 0) return 0;

    const canvas = this.sample().nativeElement;
    const scale = SAMPLE_EDGE / Math.max(w, h);
    canvas.width = Math.max(8, Math.round(w * scale));
    canvas.height = Math.max(8, Math.round(h * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) return 0;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const cw = canvas.width;
    const ch = canvas.height;
    // Luma first, so the kernel runs over one channel instead of three.
    const grey = new Float32Array(cw * ch);
    for (let i = 0, p = 0; i < grey.length; i += 1, p += 4) {
      grey[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }

    // The 4-neighbour Laplacian, skipping the border where it has no neighbours.
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = 1; y < ch - 1; y += 1) {
      for (let x = 1; x < cw - 1; x += 1) {
        const i = y * cw + x;
        const lap =
          4 * grey[i] - grey[i - 1] - grey[i + 1] - grey[i - cw] - grey[i + cw];
        sum += lap;
        sumSq += lap * lap;
        n += 1;
      }
    }
    if (n === 0) return 0;
    const mean = sum / n;
    return sumSq / n - mean * mean;
  }

  /**
   * On demand: take a short burst and send only the sharpest frame of it.
   *
   * The frames that lose are never uploaded, so this costs one object and one
   * recognition - the burst is spent on choosing, not on sending more.
   */
  async captureBest(): Promise<void> {
    if (!this.running() || this.bursting() || this.facade.sending()) return;
    if (!this.nameOk()) {
      this.mediaError.set('The gate name is not valid: lower case letters, digits and hyphens.');
      return;
    }
    this.bursting.set(true);
    try {
      let best: { blob: Blob; focus: number } | null = null;
      for (let i = 0; i < BURST_FRAMES; i += 1) {
        const focus = this.measureFocus();
        this.focus.set(focus);
        const blob = await this.grabFrame();
        if (blob !== null && (best === null || focus > best.focus)) best = { blob, focus };
        if (i < BURST_FRAMES - 1) await new Promise((r) => setTimeout(r, BURST_GAP_MS));
      }
      if (best !== null) await this.facade.send(this.cameraId(), best.blob);
    } finally {
      this.bursting.set(false);
    }
  }

  /**
   * One frame: draw the video into a canvas, scale the long edge down, encode, send.
   *
   * Skipped rather than queued while a send is in flight. A gate on a slow uplink would
   * otherwise build a backlog of frames that are already minutes stale, and a stale frame
   * is worse than no frame - the car it shows has gone.
   */
  async captureOnce(force = false): Promise<void> {
    if (!this.running() || this.facade.sending() || this.bursting()) return;
    if (!this.nameOk()) {
      this.mediaError.set('The gate name is not valid: lower case letters, digits and hyphens.');
      return;
    }

    /*
     * On the automatic tick, a frame nothing could be read from is not sent at all.
     *
     * Those frames were costing a Rekognition call and a stored photograph each, and
     * worse than the cost: the cooldown keeps the first decided frame of a car, so a
     * smeared one arriving first is the one the whole arrival gets judged by. Skipping
     * them raises the floor on what the gate ever decides from. A capture the operator
     * asked for is sent whatever it looks like - they can see the preview, and refusing
     * to do what the button says is worse than one poor frame.
     */
    if (!force) {
      const focus = this.measureFocus();
      this.focus.set(focus);
      if (focus < FOCUS_CLEAR) {
        this.skipped.update((n) => n + 1);
        return;
      }
    }

    const blob = await this.grabFrame();
    if (blob === null) return;
    await this.facade.send(this.cameraId(), blob);
  }

  // ------------------------------------------------------------------ captured mode

  onFileChosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    // Cleared so choosing the same file twice fires change again - which is exactly what
    // somebody does after fixing a crop and re-exporting it under the same name.
    input.value = '';
    if (file !== null) void this.sendFile(file);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    const file = event.dataTransfer?.files?.[0] ?? null;
    if (file !== null) void this.sendFile(file);
  }

  onDragOver(event: DragEvent): void {
    // Without this the browser navigates to the file, which loses the page and the
    // session with it.
    event.preventDefault();
    this.dragging.set(true);
  }

  onDragLeave(): void {
    this.dragging.set(false);
  }

  /**
   * Send a photograph that already exists.
   *
   * It goes through the same two steps as a live frame - ticket, then presigned PUT - so
   * the recogniser cannot tell the difference and no second path through the pipeline
   * exists to drift. What differs is only what is being uploaded: bytes off a disk rather
   * than a canvas, re-encoded first if they are large enough for the upload to be the
   * slow part.
   */
  async sendFile(file: File): Promise<void> {
    this.fileError.set(null);
    if (!this.nameOk()) {
      this.fileError.set('The gate name is not valid: lower case letters, digits and hyphens.');
      return;
    }
    if (!file.type.startsWith('image/')) {
      this.fileError.set(`${file.name} is not an image.`);
      return;
    }

    this.uploading.set(true);
    try {
      let blob: Blob = file;
      if (!ACCEPTED_TYPES.includes(file.type) || file.size > MAX_UPLOAD_BYTES) {
        /*
         * Re-encoded for one of two reasons, and the first one matters more: the API
         * accepts JPEG and PNG only, because those are the two the capture bucket's
         * notification fires on. A HEIC straight off a phone would upload happily and
         * then sit in the bucket with nothing watching for it.
         */
        const scaled = await this.reencode(file);
        if (scaled === null) {
          this.fileError.set(
            `${file.name} could not be read as an image by this browser. ` +
              'HEIC from an iPhone usually needs exporting as JPEG first.',
          );
          return;
        }
        blob = scaled;
      }

      this.showPreview(file);
      this.fileName.set(file.name);

      /*
       * The watch starts a moment before the upload, not after it: the read is filed
       * under the time the server saw it, and a window opened after the PUT returned
       * could begin on the far side of it and hide the very arrival it was opened for.
       */
      if (this.isAdmin) this.arrivals.start(new Date(Date.now() - 2000));
      await this.facade.send(this.cameraId(), blob);
    } finally {
      this.uploading.set(false);
    }
  }

  /** Decode, scale the long edge to MAX_EDGE and re-encode as JPEG. Null if undecodable. */
  private async reencode(file: File): Promise<Blob | null> {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      const loaded = await new Promise<boolean>((resolve) => {
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = url;
      });
      if (!loaded || img.naturalWidth === 0) return null;

      const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = this.canvas().nativeElement;
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext('2d');
      if (ctx === null) return null;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), MIME, QUALITY),
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** The preview owns an object URL, so the previous one has to go or the tab leaks. */
  private showPreview(file: File): void {
    const previous = this.filePreview();
    if (previous !== null) URL.revokeObjectURL(previous);
    this.filePreview.set(URL.createObjectURL(file));
  }

  clearFile(): void {
    const previous = this.filePreview();
    if (previous !== null) URL.revokeObjectURL(previous);
    this.filePreview.set(null);
    this.fileName.set(null);
    this.fileError.set(null);
    this.arrivals.stop();
    this.arrivals.clear();
  }

  /** Draw the current video frame, scaled, and encode it. Null if there is no frame yet. */
  private async grabFrame(): Promise<Blob | null> {
    const video = this.video().nativeElement;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w === 0 || h === 0) return null; // the stream has not produced a frame yet

    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const canvas = this.canvas().nativeElement;
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    return new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), MIME, QUALITY),
    );
  }

  /**
   * The headline, and the single question behind it: can this car park here.
   *
   * "Allowed" was the wrong word for the top of this screen. The gate's decision and the
   * building's allocation are not the same fact - a resident with no bay this period is
   * registered, known and still has nowhere to put the car - and the person on duty is
   * deciding where to send them, not whether they exist.
   */
  verdict(r: PlateRead): Verdict {
    const why = r.reason === null ? '' : REASON_LABEL[r.reason];
    if (r.decision === 'ALLOW') {
      return r.spotCode === null
        ? { word: 'Registered · no bay', tone: 'warn', detail: 'Known car, no bay allocated this period.' }
        : { word: `Parking enabled · ${r.spotCode}`, tone: 'ok', detail: why };
    }
    if (r.decision === 'REVIEW' || r.status === 'REVIEW') {
      return { word: 'Needs review', tone: 'warn', detail: why || 'Read too uncertain to act on.' };
    }
    if (r.decision === 'DENY') {
      return r.reason === 'PLATE_NOT_REGISTERED'
        ? { word: 'Not registered', tone: 'bad', detail: 'This plate is not in the vehicle register.' }
        : { word: 'Not allowed', tone: 'bad', detail: why };
    }
    return { word: 'No decision', tone: 'none', detail: why || 'The frame produced no entry.' };
  }

  /** The car on file, as one line. Empty fields are left out rather than printed as dashes. */
  car(r: PlateRead): string {
    const parts = [r.vehicleColour, r.vehicleMake, r.vehicleModel].filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    );
    const line = parts.join(' ');
    const year = r.vehicleYear === null ? '' : ` (${r.vehicleYear})`;
    return line.length > 0 ? `${line}${year}` : r.vehicleId ? 'Registered, no details' : '—';
  }

  distanceWord(r: PlateRead): string {
    if (r.matchDistance === null || r.matchDistance === 0) return 'as the same plate';
    return r.matchDistance === 1 ? 'one character out' : `${r.matchDistance} characters out`;
  }

  setCameraId(value: string): void {
    const next = value.trim().toLowerCase();
    this.cameraId.set(next);
    this.write(CAMERA_ID_KEY, next);
  }

  setInterval(value: number): void {
    const next = Math.max(1, Math.min(60, Math.round(Number(value) || 2)));
    this.intervalSeconds.set(next);
    this.write('pacs.gate.interval', String(next));
  }

  ngOnDestroy(): void {
    this.stop();
    const preview = this.filePreview();
    if (preview !== null) URL.revokeObjectURL(preview);
    // The facade is a root service, so leaving it polling would be a request every two
    // seconds for the rest of the session.
    this.arrivals.stop();
  }

  // Storage is a convenience, never a dependency: a gate in a private window still works,
  // it just forgets its name.
  private readString(key: string, fallback: string): string {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }

  private readNumber(key: string, fallback: number): number {
    const raw = Number(this.readString(key, String(fallback)));
    return Number.isFinite(raw) && raw >= 1 && raw <= 60 ? raw : fallback;
  }

  private write(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* nothing to do: the setting is a convenience */
    }
  }
}
