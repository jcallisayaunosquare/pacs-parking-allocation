import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { FormsModule } from '@angular/forms';
import { AuthStore } from '../../core/auth/auth.store';
import { CognitoService, type AuthOutcome } from '../../core/auth/cognito.service';
import { DOTTED_DOMAIN } from '../../shared/forms/limits';
import { environment } from '../../../environments/environment';
import { QueueBoard } from './queue-board';

/** The five things a sign-in can be, each one a real state Cognito can return. */
type Step = 'sign-in' | 'new-password' | 'mfa' | 'reset-request' | 'reset-confirm';


/**
 * The four pages the sign-in round trip needs. They only make sense as a set, so they
 * live together.
 */

@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatIconModule, NgTemplateOutlet, QueueBoard],
  template: `
    <div class="gate" [class.gate--out]="admitted()">
      <section class="gate__say">
        <p class="gate__mark rise" style="--i: 0">
          <span class="gate__dot" aria-hidden="true"></span>PACS
        </p>

        <!--
          Keyed by step: each case is a new block, so a change of step plays the heading
          in again instead of swapping words under a still frame.
        -->
        @switch (step()) {
          @case ('sign-in') {
            <div class="gate__copy" animate.enter="swap-in">
              <h1 class="gate__h rise" style="--i: 1">Your place in line for a parking bay.</h1>
              <p class="gate__p rise" style="--i: 2">
                Bays rotate every period. The longer you have waited, the higher you stand.
              </p>
            </div>
          }
          @case ('new-password') {
            <div class="gate__copy" animate.enter="swap-in">
              <h1 class="gate__h">Set a password for this account.</h1>
              <p class="gate__p">
                The administration created this account with a temporary password. Choose
                your own to finish signing in.
              </p>
            </div>
          }
          @case ('mfa') {
            <div class="gate__copy" animate.enter="swap-in">
              <h1 class="gate__h">Enter the code.</h1>
              <p class="gate__p">
                {{ mfaDestination() ? 'Sent to ' + mfaDestination() + '.' : 'From your authenticator app.' }}
              </p>
            </div>
          }
          @case ('reset-request') {
            <div class="gate__copy" animate.enter="swap-in">
              <h1 class="gate__h">Reset your password.</h1>
              <p class="gate__p">We will email a code to the address on your account.</p>
            </div>
          }
          @case ('reset-confirm') {
            <div class="gate__copy" animate.enter="swap-in">
              <h1 class="gate__h">Enter the code and a new password.</h1>
              <p class="gate__p">The code is in the email we just sent.</p>
            </div>
          }
        }

        <!--
          The ticket: the one pale, soft object in the world, and the only thing on any
          screen with a torn edge. It holds what is yours, which at this moment is the way
          in. It prints in on arrival, shakes on a refusal, and is stamped and torn off on
          the way through. One form element per line, labels above.
        -->
        <form
          class="ticket"
          [class.ticket--printed]="printed()"
          [class.ticket--shake]="shaking()"
          [class.ticket--admitted]="admitted()"
          (animationend)="onTicketAnimationEnd($event)"
          (ngSubmit)="submit()"
          novalidate
        >
          <span class="ticket__tear" aria-hidden="true"></span>

          <div class="ticket__body">
            <p class="ticket__no" aria-hidden="true">
              <span>Admit one</span>
              <span class="ticket__serial">No. {{ serial }}</span>
            </p>

            @if (step() === 'sign-in' || step() === 'reset-request') {
              <label class="f" animate.enter="field-in">
                <span class="f__l">Email</span>
                <input
                  class="f__i"
                  type="email"
                  name="email"
                  autocomplete="username"
                  inputmode="email"
                  spellcheck="false"
                  [disabled]="busy() || admitted()"
                  [(ngModel)]="email"
                  required
                />
              </label>
            }

            @if (step() === 'sign-in') {
              <!-- A div, not a label: the show button sits beside the input and must not
                   become part of its accessible name. -->
              <div class="f" animate.enter="field-in" style="--d: 50ms">
                <label class="f__l" for="login-password">Password</label>
                <span class="f__w">
                  <input
                    id="login-password"
                    class="f__i f__i--pw"
                    [type]="showPassword() ? 'text' : 'password'"
                    name="password"
                    autocomplete="current-password"
                    [disabled]="busy() || admitted()"
                    [(ngModel)]="password"
                    required
                  />
                  <ng-container [ngTemplateOutlet]="eye" />
                </span>
              </div>
            }

            @if (step() === 'new-password') {
              <div class="f" animate.enter="field-in">
                <label class="f__l" for="login-new-password">New password</label>
                <span class="f__w">
                  <input
                    id="login-new-password"
                    class="f__i f__i--pw"
                    [type]="showPassword() ? 'text' : 'password'"
                    name="newPassword"
                    autocomplete="new-password"
                    [disabled]="busy() || admitted()"
                    [(ngModel)]="password"
                    required
                  />
                  <ng-container [ngTemplateOutlet]="eye" />
                </span>
              </div>
            }

            <!-- Show or hide what was typed: a long password is mistyped more than guessed. -->
            <ng-template #eye>
              <button
                class="f__eye"
                type="button"
                [attr.aria-label]="showPassword() ? 'Hide password' : 'Show password'"
                [attr.aria-pressed]="showPassword()"
                (click)="showPassword.set(!showPassword())"
              >
                <mat-icon>{{ showPassword() ? 'visibility_off' : 'visibility' }}</mat-icon>
              </button>
            </ng-template>

            @if (step() === 'mfa') {
              <label class="f" animate.enter="field-in">
                <span class="f__l">Six-digit code</span>
                <input
                  class="f__i f__i--code"
                  type="text"
                  name="code"
                  autocomplete="one-time-code"
                  inputmode="numeric"
                  maxlength="6"
                  [disabled]="busy() || admitted()"
                  [(ngModel)]="code"
                  required
                />
              </label>
            }

            @if (step() === 'reset-confirm') {
              <label class="f" animate.enter="field-in">
                <span class="f__l">Code from the email</span>
                <input
                  class="f__i f__i--code"
                  type="text"
                  name="resetCode"
                  autocomplete="one-time-code"
                  inputmode="numeric"
                  [disabled]="busy()"
                  [(ngModel)]="code"
                  required
                />
              </label>
              <label class="f" animate.enter="field-in" style="--d: 50ms">
                <span class="f__l">New password</span>
                <input
                  class="f__i"
                  type="password"
                  name="resetPassword"
                  autocomplete="new-password"
                  [disabled]="busy()"
                  [(ngModel)]="password"
                  required
                />
              </label>
            }

            @if (error(); as e) {
              <p class="ticket__err" role="alert" animate.enter="msg-in">{{ e }}</p>
            }
            @if (notice(); as n) {
              <p class="ticket__ok" role="status" animate.enter="msg-in">{{ n }}</p>
            }

            <button
              class="ticket__go"
              [class.ticket__go--busy]="busy()"
              type="submit"
              [disabled]="busy() || admitted()"
            >
              <span class="ticket__goLabel">
                {{ admitted() ? 'Welcome' : busy() ? 'Checking…' : actionLabel() }}
              </span>
              @if (!busy() && !admitted()) {
                <mat-icon class="ticket__arrow" aria-hidden="true">arrow_forward</mat-icon>
              }
            </button>

            @if (step() === 'sign-in') {
              <button class="ticket__alt" type="button" (click)="go('reset-request')">
                Forgot password
              </button>
            } @else if (step() !== 'new-password') {
              <button class="ticket__alt" type="button" (click)="go('sign-in')">
                Back to sign in
              </button>
            }
          </div>

          <!-- The stamp that lands when the sign-in is accepted. -->
          @if (admitted()) {
            <span class="ticket__stamp" aria-hidden="true">Admitted</span>
          }
        </form>

        <p class="gate__fine rise" style="--i: 5">
          The building administration issues accounts. If you do not have one yet, ask them
          to add you to the register.
        </p>
      </section>

      <app-queue-board class="gate__board" />
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
      }

      .gate {
        min-height: 100vh;
        min-height: 100dvh;
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 0.8fr);
        background: var(--surface-2);
      }

      /* Pinned from the top rather than centred, so an error line appearing in the
         ticket grows it downward instead of nudging the whole column up. */
      .gate__say {
        align-self: start;
        justify-self: center;
        width: 100%;
        max-width: 34rem;
        padding: max(var(--sp-7), 11vh) var(--sp-7) var(--sp-7);
      }

      /* ------------------------------------------------------------ arrival */

      /* Each piece of the left column arrives in reading order, one beat apart. */
      .rise {
        animation: rise 640ms var(--ease-out) both;
        animation-delay: calc(var(--i, 0) * 70ms + 80ms);
      }

      @keyframes rise {
        from {
          opacity: 0;
          transform: translateY(14px);
        }
      }

      .gate__mark {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        margin: 0 0 var(--sp-5);
        font-size: var(--t-body);
        font-variation-settings:
          'wdth' 112,
          'wght' 700;
        letter-spacing: 0.22em;
        color: var(--ink-3);
      }

      /* The one live thing in the mark: the signal, breathing, as on a board that is on. */
      .gate__dot {
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 50%;
        background: var(--signal);
        animation: breathe 2.4s ease-in-out infinite;
      }

      @keyframes breathe {
        50% {
          opacity: 0.35;
          transform: scale(0.8);
        }
      }

      .gate__copy {
        min-height: 9.5rem;
      }

      .gate__h {
        margin: 0 0 var(--sp-3);
        font-size: clamp(1.9rem, 2.6vw, 2.75rem);
        line-height: 1.06;
        letter-spacing: -0.02em;
        font-variation-settings:
          'wdth' 104,
          'wght' 660;
        color: var(--ink-1);
        max-width: 18ch;
        text-wrap: balance;
      }

      .gate__p {
        margin: 0 0 var(--sp-5);
        font-size: var(--t-body);
        line-height: 1.5;
        color: var(--ink-2);
        max-width: 46ch;
      }

      .gate__fine {
        margin: var(--sp-5) 0 0;
        font-size: var(--t-small);
        line-height: 1.5;
        color: var(--ink-3);
        max-width: 46ch;
      }

      /* A change of step: the new words slide in from the right, as the next card would. */
      .swap-in {
        animation: swap-in 420ms var(--ease-out) both;
      }

      @keyframes swap-in {
        from {
          opacity: 0;
          transform: translateX(18px);
        }
      }

      .field-in {
        animation: field-in 380ms var(--ease-out) both;
        animation-delay: var(--d, 0ms);
      }

      @keyframes field-in {
        from {
          opacity: 0;
          transform: translateY(8px);
        }
      }

      .msg-in {
        animation: field-in 260ms var(--ease-out) both;
      }

      /* ------------------------------------------------------------ the ticket */

      /*
       * The ticket carries its own values, and everything inside it is measured against
       * paper rather than against the page. It has to be: the page's ink is near-white
       * and the page's signal is a light lavender picked to carry on slate, and both of
       * them disappear on a pale stub. So the stub is its own lit object, with a deep
       * signal and a dark ink, and it stays that way whichever palette the page wears.
       */
      .ticket {
        --ticket-field: #ffffff;
        --ticket-rule: #b9bed3;
        --ticket-ink-dim: #4a4d5c; /*  7.3:1 on the stub */
        --ticket-signal: #4a43cf; /*  7.1:1 against white, for the filled button */
        --ticket-signal-deep: #38309f;
        --ticket-bad: #9b3f47; /*  6.0:1 on the stub */
        --ticket-good: #246a54; /*  5.6:1 on the stub */

        position: relative;
        display: flex;
        background: var(--ticket);
        color: var(--ticket-ink);
        border: 1px solid var(--ticket-edge);
        max-width: 24rem;
        overflow: hidden;
        transform-origin: 50% 0;
        /* Printed: it feeds out of the slot top-down. */
        animation: print 760ms var(--ease-out) 260ms both;
      }

      @keyframes print {
        from {
          clip-path: inset(0 0 100% 0);
          transform: translateY(-10px);
        }
        to {
          clip-path: inset(0 0 0 0);
        }
      }

      /* Printed once. Without this, dropping the shake class would print it again. */
      .ticket--printed {
        animation: none;
      }

      /* A refusal: the stub is pushed back, twice, the way a turnstile says no. */
      .ticket--shake {
        animation: shake 420ms cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
      }

      @keyframes shake {
        15%,
        85% {
          transform: translateX(-2px);
        }
        30%,
        70% {
          transform: translateX(5px);
        }
        45%,
        55% {
          transform: translateX(-7px);
        }
      }

      /* Accepted: stamped, then torn off upward. */
      .ticket--admitted {
        animation: tear-off 520ms cubic-bezier(0.55, 0, 0.75, 0) 560ms both;
      }

      @keyframes tear-off {
        to {
          opacity: 0;
          transform: translateY(-36px) rotate(-2.5deg);
        }
      }

      .ticket__stamp {
        position: absolute;
        left: 50%;
        top: 46%;
        padding: var(--sp-2) var(--sp-4);
        border: 3px solid var(--ticket-good);
        border-radius: 3px;
        background: color-mix(in srgb, var(--ticket) 88%, transparent);
        color: var(--ticket-good);
        font-size: var(--t-title);
        font-variation-settings:
          'wdth' 112,
          'wght' 760;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        transform: translate(-50%, -50%) rotate(-8deg);
        animation: stamp 360ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
      }

      @keyframes stamp {
        from {
          opacity: 0;
          transform: translate(-50%, -50%) rotate(-8deg) scale(1.9);
        }
      }

      /* The torn edge: the one soft contour in a world of hairlines and right angles. */
      .ticket__tear {
        flex: 0 0 14px;
        background:
          radial-gradient(circle 4px at 0 7px, var(--surface-2) 97%, transparent 100%) 0 0 /
            14px 14px repeat-y,
          var(--ticket);
        border-right: 1px dashed var(--ticket-edge);
      }

      .ticket__body {
        flex: 1;
        min-width: 0;
        padding: var(--sp-5);
        display: flex;
        flex-direction: column;
        gap: var(--sp-4);
      }

      .ticket__no {
        display: flex;
        justify-content: space-between;
        margin: 0;
        padding-bottom: var(--sp-3);
        border-bottom: 1px dashed var(--ticket-rule);
        font-size: var(--t-fine);
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--ticket-ink-dim);
      }

      .ticket__serial {
        letter-spacing: 0.08em;
      }

      .f {
        display: flex;
        flex-direction: column;
        gap: var(--sp-2);
      }

      .f__l {
        font-size: var(--t-small);
        color: var(--ticket-ink-dim);
      }

      .f__w {
        position: relative;
        display: flex;
      }

      .f__i {
        flex: 1;
        min-width: 0;
        font: inherit;
        font-size: var(--t-body);
        min-height: 2.75rem;
        padding: 0 var(--sp-3);
        color: var(--ticket-ink);
        background: var(--ticket-field);
        border: 1px solid var(--ticket-rule);
        border-radius: 2px;
        transition:
          border-color 160ms ease,
          box-shadow 160ms ease;
      }

      .f__i:hover:not(:disabled) {
        border-color: var(--ticket-ink-dim);
      }

      .f__i:focus-visible {
        outline: 3px solid var(--ticket-signal);
        outline-offset: 1px;
        border-color: var(--ticket-signal);
      }

      .f__i:disabled {
        opacity: 0.6;
      }

      .f__i--pw {
        padding-right: 3rem;
      }

      .f__eye {
        position: absolute;
        right: 0;
        top: 0;
        bottom: 0;
        width: 2.75rem;
        display: grid;
        place-items: center;
        padding: 0;
        border: 0;
        background: none;
        color: var(--ticket-ink-dim);
        cursor: pointer;
      }

      .f__eye:focus-visible {
        outline: 3px solid var(--ticket-signal);
        outline-offset: -3px;
      }

      /* A code is read digit by digit, so it is set like one. */
      .f__i--code {
        letter-spacing: 0.4em;
        font-size: var(--t-lead);
      }

      .ticket__go {
        position: relative;
        overflow: hidden;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--sp-2);
        font: inherit;
        font-size: var(--t-body);
        font-weight: 600;
        min-height: 2.875rem;
        border: 0;
        border-radius: 3px;
        background: var(--ticket-signal);
        color: #ffffff;
        cursor: pointer;
        touch-action: manipulation;
        transition:
          background-color 140ms ease,
          transform 120ms ease;
      }

      .ticket__go:focus-visible {
        outline: 3px solid var(--ticket-signal);
        outline-offset: 2px;
      }

      .ticket__arrow {
        width: 20px;
        height: 20px;
        font-size: 20px;
        transition: transform 220ms var(--ease-out);
      }

      @media (hover: hover) and (pointer: fine) {
        .ticket__go:hover:not(:disabled) {
          background: var(--ticket-signal-deep);
        }
        .ticket__go:hover:not(:disabled) .ticket__arrow {
          transform: translateX(4px);
        }
      }

      .ticket__go:active:not(:disabled) {
        transform: scale(0.985);
      }

      .ticket__go:disabled {
        cursor: default;
      }

      /* Working: a band of light runs along the button, the same mark as waiting elsewhere. */
      .ticket__go--busy::after {
        content: '';
        position: absolute;
        left: 0;
        bottom: 0;
        height: 3px;
        width: 40%;
        background: rgb(255 255 255 / 75%);
        animation: run 1s ease-in-out infinite;
      }

      @keyframes run {
        from {
          transform: translateX(-100%);
        }
        to {
          transform: translateX(260%);
        }
      }

      .ticket__alt {
        font: inherit;
        font-size: var(--t-small);
        align-self: flex-start;
        min-height: 1.5rem;
        padding: 0;
        border: 0;
        background: none;
        color: var(--ticket-ink-dim);
        text-decoration: underline;
        text-underline-offset: 3px;
        cursor: pointer;
      }

      .ticket__alt:focus-visible {
        outline: 3px solid var(--ticket-signal);
        outline-offset: 2px;
      }

      .ticket__err {
        margin: 0;
        font-size: var(--t-small);
        line-height: 1.45;
        color: var(--ticket-bad);
      }

      .ticket__ok {
        margin: 0;
        font-size: var(--t-small);
        color: var(--ticket-good);
      }

      /* Leaving: the whole board dims as the ticket is torn off, then the route takes over. */
      .gate--out .gate__board {
        transition: opacity 400ms ease 700ms;
        opacity: 0.4;
      }

      /* ------------------------------------------------------------- narrow */

      @media (max-width: 62rem) {
        .gate {
          grid-template-columns: minmax(0, 1fr);
        }

        .gate__say {
          justify-self: stretch;
          max-width: 36rem;
          margin: 0 auto;
          padding: var(--sp-6) var(--sp-5) var(--sp-7);
        }

        .gate__copy {
          min-height: 0;
        }

        .ticket {
          max-width: none;
        }
      }

      @media (max-width: 30rem) {
        .gate__say {
          padding: var(--sp-6) var(--sp-4) var(--sp-6);
        }

        .ticket__body {
          padding: var(--sp-4);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .rise,
        .swap-in,
        .field-in,
        .msg-in,
        .ticket,
        .ticket--shake,
        .ticket--admitted,
        .ticket__stamp,
        .gate__dot,
        .ticket__go--busy::after {
          animation: none;
        }
        .ticket__go,
        .ticket__arrow,
        .f__i {
          transition: none;
        }
      }
    `,
  ],
})
export class LoginPage {
  private readonly auth = inject(AuthStore);
  private readonly cognito = inject(CognitoService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** Which of the five things a sign-in can be is on screen. */
  readonly step = signal<Step>('sign-in');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly mfaDestination = signal<string | null>(null);

  /** The ticket's motion: printed once on arrival, shaken on a refusal, torn off on entry. */
  readonly printed = signal(false);
  readonly shaking = signal(false);
  readonly admitted = signal(false);
  readonly showPassword = signal(false);

  email = '';
  password = '';
  code = '';

  /** Printed on the stub. Decoration only: it identifies nothing. */
  readonly serial = String(Math.floor(100000 + Math.random() * 900000));

  private readonly reducedMotion =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  onTicketAnimationEnd(e: AnimationEvent): void {
    // Children animate too (fields, the stamp) and their ends bubble up here.
    if (e.target !== e.currentTarget) return;
    if (e.animationName.includes('print')) this.printed.set(true);
    if (e.animationName.includes('shake')) this.shaking.set(false);
  }

  /** Report a refusal, and shake the ticket - restarting the shake if one is running. */
  private fail(message: string): void {
    this.error.set(message);
    if (this.reducedMotion) return;
    this.printed.set(true);
    this.shaking.set(false);
    requestAnimationFrame(() => this.shaking.set(true));
  }

  /** The control names its action, and keeps that name through the whole flow. */
  actionLabel(): string {
    switch (this.step()) {
      case 'sign-in':
        return 'Sign in';
      case 'new-password':
        return 'Set password and sign in';
      case 'mfa':
        return 'Submit code';
      case 'reset-request':
        return 'Email me a code';
      case 'reset-confirm':
        return 'Change password';
    }
  }

  go(step: Step): void {
    this.step.set(step);
    this.error.set(null);
    this.notice.set(null);
    this.showPassword.set(false);
    this.password = '';
    this.code = '';
  }

  /**
   * What is missing or malformed in the step on screen, before Cognito is asked.
   *
   * An empty email sent to Cognito comes back as a generic failure that reads like a
   * wrong password; a weak new password comes back as Cognito's own policy text, after a
   * round trip. Both are known here. The password rules are the user pool's, copied from
   * apps/api/serverless.yml (PasswordPolicy), so the two cannot disagree silently - a
   * change there must be made here.
   */
  private problem(): string | null {
    const step = this.step();
    const email = this.email.trim();
    if (step === 'sign-in' || step === 'reset-request') {
      if (!email) return 'Enter your email.';
      // The offline stub's two accounts live at `@local`, which has no dot to find.
      if (!environment.localAuth && !DOTTED_DOMAIN.test(email)) {
        return 'Enter an address like name@example.com.';
      }
    }
    if (step === 'sign-in' && !this.password) return 'Enter your password.';
    if (step === 'mfa' && !/^\d{6}$/.test(this.code.trim())) {
      return 'Enter the six digits from your authenticator app.';
    }
    if (step === 'reset-confirm' && !/^\d+$/.test(this.code.trim())) {
      return 'Enter the code from the email, digits only.';
    }
    if (step === 'new-password' || step === 'reset-confirm') {
      const p = this.password;
      if (
        p.length < 12 ||
        !/[a-z]/.test(p) ||
        !/[A-Z]/.test(p) ||
        !/\d/.test(p) ||
        !/[^A-Za-z0-9]/.test(p)
      ) {
        return 'Use at least 12 characters, with a lower-case and an upper-case letter, a digit and a symbol.';
      }
    }
    return null;
  }

  async submit(): Promise<void> {
    if (this.busy()) return;
    this.notice.set(null);
    const problem = this.problem();
    if (problem) {
      this.fail(problem);
      return;
    }
    this.busy.set(true);
    this.error.set(null);

    try {
      switch (this.step()) {
        case 'sign-in':
          this.handle(await this.cognito.signIn(this.email.trim(), this.password));
          break;
        case 'new-password':
          this.handle(await this.cognito.completeNewPassword(this.password));
          break;
        case 'mfa':
          this.handle(await this.cognito.submitMfaCode(this.code.trim()));
          break;
        case 'reset-request': {
          const r = await this.cognito.requestPasswordReset(this.email.trim());
          if (r.ok) {
            this.go('reset-confirm');
            this.notice.set(r.message);
          } else this.fail(r.message);
          break;
        }
        case 'reset-confirm': {
          const r = await this.cognito.confirmPasswordReset(
            this.email.trim(),
            this.code.trim(),
            this.password,
          );
          if (r.ok) {
            this.go('sign-in');
            this.notice.set(r.message);
          } else this.fail(r.message);
          break;
        }
      }
    } finally {
      this.busy.set(false);
    }
  }

  private handle(outcome: AuthOutcome): void {
    switch (outcome.kind) {
      case 'signed-in':
        void this.finish();
        break;
      case 'new-password-required':
        this.password = '';
        this.step.set('new-password');
        break;
      case 'mfa-required':
        this.mfaDestination.set(outcome.destination);
        this.step.set('mfa');
        break;
      case 'failed':
        this.fail(outcome.message);
        break;
    }
  }

  /** Back to where they were heading before the guard sent them here. */
  private async finish(): Promise<void> {
    await this.auth.adopt();
    // Stamp and tear off the ticket before the route changes; the board stays behind.
    if (!this.reducedMotion) {
      this.printed.set(true);
      this.admitted.set(true);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl') ?? '/';
    await this.router.navigateByUrl(returnUrl);
  }
}

/**
 * Where Cognito redirects back to. The OIDC client has already exchanged the code by
 * the time this renders, because the app initializer runs `checkAuth()` on every load
 * including this one. The only job here is sending the person where they were going.
 */
@Component({
  selector: 'app-callback-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wait" aria-live="polite">
      <span class="wait__bar"></span>
      <p>Signing you in</p>
    </div>
  `,
  styles: [
    `
      .wait {
        max-width: 24rem;
        margin: 22vh auto 0;
        color: var(--steel-soft);
      }
      .wait__bar {
        display: block;
        height: 6px;
        background: var(--concrete-deep);
        overflow: hidden;
        position: relative;
        margin-bottom: var(--sp-3);
      }
      /* The one piece of non-user-triggered motion in the product: it marks waiting. */
      .wait__bar::after {
        content: '';
        position: absolute;
        inset: 0;
        width: 40%;
        background: var(--bay-line);
        animation: slide 1.1s ease-in-out infinite;
      }
      @keyframes slide {
        0% {
          transform: translateX(-100%);
        }
        100% {
          transform: translateX(250%);
        }
      }
    `,
  ],
})
export class CallbackPage implements OnInit {
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  async ngOnInit(): Promise<void> {
    if (!this.auth.checked()) await this.auth.restore();

    if (!this.auth.authenticated()) {
      void this.router.navigate(['/login']);
      return;
    }

    const returnUrl = new URLSearchParams(window.location.search).get('returnUrl');
    const fallback = this.auth.hasResidentRecord()
      ? '/'
      : this.auth.isAdmin()
        ? '/admin/residents'
        : '/pending';
    void this.router.navigateByUrl(returnUrl ?? fallback);
  }
}

/**
 * A signed-in account with no resident record.
 *
 * This used to land on the forbidden page, which told someone who had just created an
 * account and verified their email that they had no access — technically true and
 * completely unhelpful. The state is now named for what it is: the account works, it
 * is simply not linked to a resident yet, which happens when an administrator adds
 * them (FR-10) and the provisioning event comes back round.
 */
@Component({
  selector: 'app-pending-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, RouterLink],
  template: `
    <!--
      Two states, deliberately told apart. They used to share this page, so a failed
      GET /me was reported as "your account is not linked" ? the wrong answer, and one
      nobody can act on.
    -->
    @if (auth.principalError(); as err) {
      <div class="pend pend--fail" role="alert">
        <h1 class="pend__h">We could not load your account</h1>
        <p class="pend__p">
          You are signed in, but the server did not answer when we asked who you are, so
          there is nothing to show yet. This is not a problem with your account.
        </p>
        <p class="pend__p pend__detail">{{ err.message }}</p>
        @if (err.traceId) {
          <p class="pend__trace">
            Reference for support: <code>{{ err.traceId }}</code>
          </p>
        }
        <div class="pend__row">
          <button matButton="filled" type="button" (click)="recheck()">Try again</button>
          <button class="pend__out" type="button" (click)="auth.logout()">Sign out</button>
        </div>
      </div>
    } @else {
      <div class="pend">
        <h1 class="pend__h">Your account is not linked to a resident yet</h1>
        <p class="pend__p">
          You are signed in as <strong>{{ auth.principal()?.email }}</strong>. Before you
          can see your parking status, the building administration has to add you to the
          resident register with your unit number.
        </p>
        <p class="pend__p">
          Once they do, this page becomes your parking status. Nothing else is needed from
          you.
        </p>
        <div class="pend__row">
          <button matButton="outlined" type="button" (click)="recheck()">Check again</button>
          @if (auth.isAdmin()) {
            <a matButton routerLink="/admin/residents">Go to administration</a>
          }
          <button class="pend__out" type="button" (click)="auth.logout()">Sign out</button>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .pend {
        max-width: 40rem;
        border-left: 10px solid var(--attention);
        padding-left: var(--sp-5);
        display: flex;
        flex-direction: column;
        gap: var(--sp-3);
      }
      .pend__h {
        font-size: var(--t-title);
      }
      .pend__p {
        color: var(--steel-soft);
      }
      .pend--fail {
        border-left-color: var(--revoked);
      }
      .pend__detail {
        font-size: var(--t-small);
        color: var(--revoked);
      }
      .pend__trace {
        font-size: var(--t-fine);
        color: var(--steel-faint);
      }
      .pend__trace code {
        user-select: all;
      }
      .pend__row {
        display: flex;
        align-items: center;
        gap: var(--sp-4);
        margin-top: var(--sp-2);
      }
      .pend__out {
        background: none;
        border: 0;
        padding: 0;
        color: var(--steel-soft);
        text-decoration: underline;
        cursor: pointer;
        font-size: var(--t-fine);
      }
    `,
  ],
})
export class PendingPage {
  readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  async recheck(): Promise<void> {
    await this.auth.loadPrincipal();
    if (this.auth.hasResidentRecord()) void this.router.navigateByUrl('/');
  }
}

/** A 403 is a product state, not a crash (§17). */
@Component({
  selector: 'app-forbidden-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, RouterLink],
  template: `
    <div class="stop" role="alert">
      <h1 class="stop__h">This page is for building administrators</h1>
      <p class="stop__p">
        Your account does not have that permission. If it should, ask the building
        administration to grant it.
      </p>
      <a matButton="outlined" [routerLink]="auth.isAdmin() ? '/admin/residents' : '/'">
        {{ auth.isAdmin() ? 'Go to residents' : 'Back to my parking' }}
      </a>
    </div>
  `,
  styles: [
    `
      .stop {
        max-width: 40rem;
        border-left: 10px solid var(--revoked);
        padding-left: var(--sp-5);
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: var(--sp-3);
      }
      .stop__h {
        font-size: var(--t-title);
      }
      .stop__p {
        color: var(--steel-soft);
      }
    `,
  ],
})
export class ForbiddenPage {
  readonly auth = inject(AuthStore);
}

/**
 * The front door, for someone who arrived without a destination.
 *
 * Kept apart from the sign-in form on purpose: the two surfaces answer different
 * questions. This one answers "what is this and should I be here", and the form answers
 * "let me in". Folding them together, as an earlier pass did, means a resident who knows
 * exactly why they came has to read the pitch again every time.
 *
 * A deep link does not come here. Someone who asked for a bay detail is sent straight to
 * the form with their destination remembered.
 */
@Component({
  selector: 'app-welcome-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, QueueBoard],
  template: `
    <div class="gate">
      <section class="gate__say">
        <p class="gate__mark">PACS</p>

        <h1 class="gate__h">Your place in line for a parking bay.</h1>

        <p class="gate__p">
          Bays rotate every period. The longer you have waited, the higher you stand - and
          when two residents stand level, a draw you can check for yourself decides.
        </p>

        <a class="gate__go" routerLink="/login">Sign in</a>

        <dl class="gate__how">
          <dt>Waiting time decides</dt>
          <dd>Counted from the day your last bay ended, or the day you joined the register.</dd>
          <dt>History breaks the tie</dt>
          <dd>Level on waiting, fewer past bays goes first.</dd>
          <dt>The draw is checkable</dt>
          <dd>Still level, and a seeded draw decides. You can recompute your own token.</dd>
        </dl>

        <p class="gate__fine">
          The building administration issues accounts. If you do not have one yet, ask them
          to add you to the register.
        </p>
      </section>

      <app-queue-board class="gate__board" />
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .gate {
        min-height: 100vh;
        min-height: 100dvh;
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 0.72fr);
        background: var(--surface-2);
      }

      .gate__say {
        align-self: center;
        justify-self: center;
        max-width: 40rem;
        padding: var(--sp-7);
      }

      .gate__mark {
        margin: 0 0 var(--sp-5);
        font-size: var(--t-body);
        font-variation-settings:
          'wdth' 112,
          'wght' 700;
        letter-spacing: 0.22em;
        color: var(--ink-3);
      }

      .gate__h {
        margin: 0 0 var(--sp-4);
        font-size: clamp(2.125rem, 3vw, 3rem);
        line-height: 1.06;
        letter-spacing: -0.02em;
        font-variation-settings:
          'wdth' 104,
          'wght' 660;
        color: var(--ink-1);
        max-width: 17ch;
      }

      .gate__p {
        margin: 0 0 var(--sp-6);
        font-size: var(--t-lead);
        line-height: 1.5;
        color: var(--ink-2);
        max-width: 46ch;
      }

      .gate__go {
        display: inline-block;
        font-size: var(--t-body);
        font-weight: 600;
        line-height: 3.25rem;
        padding: 0 var(--sp-6);
        border-radius: 3px;
        background: var(--signal);
        color: var(--on-primary);
        text-decoration: none;
        touch-action: manipulation;
        transition: background-color 140ms cubic-bezier(0.22, 1, 0.36, 1);
      }

      @media (hover: hover) and (pointer: fine) {
        .gate__go:hover {
          background: var(--primary-strong);
          transition-duration: 0ms;
        }
      }

      /*
       * The rule, stated once, in the order it is applied. A resident contesting a result
       * is owed this before they sign in, not buried in a help page afterwards.
       */
      .gate__how {
        margin: var(--sp-7) 0 0;
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--sp-3) var(--sp-5);
        max-width: 52ch;
        border-top: 1px solid var(--rule-soft);
        padding-top: var(--sp-5);
      }

      .gate__how dt {
        font-size: var(--t-small);
        font-weight: 600;
        color: var(--ink-1);
        white-space: nowrap;
      }

      .gate__how dd {
        margin: 0;
        font-size: var(--t-small);
        line-height: 1.5;
        color: var(--ink-2);
      }

      .gate__fine {
        margin: var(--sp-6) 0 0;
        font-size: var(--t-small);
        line-height: 1.5;
        color: var(--ink-3);
        max-width: 46ch;
      }

      @media (max-width: 62rem) {
        .gate {
          grid-template-columns: minmax(0, 1fr);
        }

        .gate__say {
          justify-self: start;
          padding: var(--sp-6) var(--sp-5);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .gate__go {
          transition: none;
        }
      }
    `,
  ],
})
export class WelcomePage {}
