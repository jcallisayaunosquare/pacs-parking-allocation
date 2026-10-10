import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { FormsModule } from '@angular/forms';
import { AuthStore } from '../../core/auth/auth.store';
import { CognitoService, type AuthOutcome } from '../../core/auth/cognito.service';

/** The five things a sign-in can be, each one a real state Cognito can return. */
type Step = 'sign-in' | 'new-password' | 'mfa' | 'reset-request' | 'reset-confirm';

/** Illustrative, and the only invented content on either surface: no real unit is named. */
const BOARD_ROWS = [
  { pos: 1, unit: 'Unit 1104', wait: '214 d', bay: 'A04', on: false, past: false, cut: false },
  { pos: 2, unit: 'Unit 503', wait: '186 d', bay: 'A11', on: false, past: false, cut: false },
  { pos: 3, unit: 'Unit 211', wait: '173 d', bay: 'B02', on: true, past: false, cut: false },
  { pos: 4, unit: 'Unit 902', wait: '168 d', bay: 'B07', on: false, past: false, cut: false },
  { pos: 5, unit: 'Unit 406', wait: '91 d', bay: '', on: false, past: true, cut: true },
  { pos: 6, unit: 'Unit 308', wait: '77 d', bay: '', on: false, past: true, cut: false },
];


/**
 * The four pages the sign-in round trip needs. They only make sense as a set, so they
 * live together.
 */

@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="gate">
      <section class="gate__say">
        <p class="gate__mark">PACS</p>

        @switch (step()) {
          @case ('sign-in') {
            <h1 class="gate__h">Your place in line for a parking bay.</h1>
            <p class="gate__p">
              Bays rotate every period. The longer you have waited, the higher you stand.
            </p>
          }
          @case ('new-password') {
            <h1 class="gate__h">Set a password for this account.</h1>
            <p class="gate__p">
              The administration created this account with a temporary password. Choose
              your own to finish signing in.
            </p>
          }
          @case ('mfa') {
            <h1 class="gate__h">Enter the code.</h1>
            <p class="gate__p">
              {{ mfaDestination() ? 'Sent to ' + mfaDestination() + '.' : 'From your authenticator app.' }}
            </p>
          }
          @case ('reset-request') {
            <h1 class="gate__h">Reset your password.</h1>
            <p class="gate__p">We will email a code to the address on your account.</p>
          }
          @case ('reset-confirm') {
            <h1 class="gate__h">Enter the code and a new password.</h1>
            <p class="gate__p">The code is in the email we just sent.</p>
          }
        }

        <!--
          The ticket: the one pale, soft object in the world, and the only thing on any
          screen with a torn edge. It holds what is yours, which at this moment is the way
          in. One form element per line, labels above, because a sign-in is read top down.
        -->
        <form class="ticket" (ngSubmit)="submit()" novalidate>
          <span class="ticket__tear" aria-hidden="true"></span>

          <div class="ticket__body">
            @if (step() === 'sign-in' || step() === 'reset-request') {
              <label class="f">
                <span class="f__l">Email</span>
                <input
                  class="f__i"
                  type="email"
                  name="email"
                  autocomplete="username"
                  inputmode="email"
                  spellcheck="false"
                  [disabled]="busy()"
                  [(ngModel)]="email"
                  required
                />
              </label>
            }

            @if (step() === 'sign-in') {
              <label class="f">
                <span class="f__l">Password</span>
                <input
                  class="f__i"
                  type="password"
                  name="password"
                  autocomplete="current-password"
                  [disabled]="busy()"
                  [(ngModel)]="password"
                  required
                />
              </label>
            }

            @if (step() === 'new-password') {
              <label class="f">
                <span class="f__l">New password</span>
                <input
                  class="f__i"
                  type="password"
                  name="newPassword"
                  autocomplete="new-password"
                  [disabled]="busy()"
                  [(ngModel)]="password"
                  required
                />
              </label>
            }

            @if (step() === 'mfa') {
              <label class="f">
                <span class="f__l">Six-digit code</span>
                <input
                  class="f__i f__i--code"
                  type="text"
                  name="code"
                  autocomplete="one-time-code"
                  inputmode="numeric"
                  maxlength="6"
                  [disabled]="busy()"
                  [(ngModel)]="code"
                  required
                />
              </label>
            }

            @if (step() === 'reset-confirm') {
              <label class="f">
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
              <label class="f">
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
              <p class="ticket__err" role="alert">{{ e }}</p>
            }
            @if (notice(); as n) {
              <p class="ticket__ok" role="status">{{ n }}</p>
            }

            <button class="ticket__go" type="submit" [disabled]="busy()">
              {{ busy() ? 'Working...' : actionLabel() }}
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
        </form>

        <p class="gate__fine">
          The building administration issues accounts. If you do not have one yet, ask them
          to add you to the register.
        </p>
      </section>

      <aside class="gate__board" aria-hidden="true">
        <p class="gate__now">Period 2026-02 <span class="gate__sep">/</span> closes in 11 days</p>
        <ol class="gate__rows">
          @for (row of boardRows; track row.pos) {
            @if (row.cut) {
              <li class="gate__cut"><span>Bays run out here</span></li>
            }
            <li class="gate__row" [class.gate__row--on]="row.on" [class.gate__row--past]="row.past">
              <span class="gate__pos">{{ row.pos }}</span>
              <span class="gate__unit">{{ row.unit }}</span>
              <span class="gate__wait">{{ row.wait }}</span>
              <span class="gate__bay">{{ row.bay }}</span>
            </li>
          }
        </ol>
      </aside>
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
        max-width: 34rem;
        padding: var(--sp-7) var(--sp-7);
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
        margin: 0 0 var(--sp-3);
        font-size: clamp(1.9rem, 2.4vw, 2.5rem);
        line-height: 1.08;
        letter-spacing: -0.02em;
        font-variation-settings:
          'wdth' 104,
          'wght' 660;
        color: var(--ink-1);
        max-width: 18ch;
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

        display: flex;
        background: var(--ticket);
        color: var(--ticket-ink);
        border: 1px solid var(--ticket-edge);
        max-width: 23rem;
        overflow: hidden;
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
        padding: var(--sp-5);
        display: flex;
        flex-direction: column;
        gap: var(--sp-4);
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

      .f__i {
        font: inherit;
        font-size: var(--t-body);
        min-height: 2.75rem;
        padding: 0 var(--sp-3);
        color: var(--ticket-ink);
        background: var(--ticket-field);
        border: 1px solid var(--ticket-rule);
        border-radius: 2px;
      }

      .f__i:focus-visible {
        outline: 3px solid var(--ticket-signal);
        outline-offset: 1px;
      }

      .f__i:disabled {
        opacity: 0.6;
      }

      /* A code is read digit by digit, so it is set like one. */
      .f__i--code {
        letter-spacing: 0.4em;
        font-size: var(--t-lead);
      }

      .ticket__go {
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
        transition: background-color 140ms cubic-bezier(0.22, 1, 0.36, 1);
      }

      @media (hover: hover) and (pointer: fine) {
        .ticket__go:hover:not(:disabled) {
          background: var(--ticket-signal-deep);
          transition-duration: 0ms;
        }
      }

      .ticket__go:disabled {
        opacity: 0.65;
        cursor: default;
      }

      .ticket__alt {
        font: inherit;
        font-size: var(--t-small);
        align-self: flex-start;
        padding: 0;
        border: 0;
        background: none;
        color: var(--ticket-ink-dim);
        text-decoration: underline;
        cursor: pointer;
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

      /* ------------------------------------------------------------- the board */

      .gate__board {
        background: var(--board);
        color: var(--board-ink);
        padding: var(--sp-7);
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: var(--sp-4);
        overflow: hidden;
      }

      .gate__now {
        margin: 0;
        font-size: var(--t-fine);
        letter-spacing: 0.2em;
        color: var(--board-ink-dim);
      }

      .gate__sep {
        color: var(--board-rule);
        padding: 0 0.4em;
      }

      .gate__rows {
        list-style: none;
        margin: 0;
        padding: 0;
        border-top: 1px solid var(--board-rule);
      }

      /* Columns never move, whatever a row says. */
      .gate__row {
        display: grid;
        grid-template-columns: 3.5ch 1fr 7ch 5ch;
        gap: var(--sp-4);
        align-items: baseline;
        padding: var(--sp-3) 0;
        border-bottom: 1px solid var(--board-rule);
        font-size: var(--t-small);
      }

      .gate__pos {
        font-size: var(--t-body);
        font-variation-settings:
          'wdth' 112,
          'wght' 620;
        color: var(--board-ink-dim);
        text-align: right;
      }

      .gate__unit {
        color: var(--board-ink);
      }

      .gate__wait,
      .gate__bay {
        color: var(--board-ink-dim);
        text-align: right;
      }

      .gate__row--on,
      .gate__row--on .gate__pos,
      .gate__row--on .gate__unit,
      .gate__row--on .gate__wait,
      .gate__row--on .gate__bay {
        color: var(--signal-on-board);
      }

      .gate__row--past {
        opacity: 0.55;
      }

      .gate__cut {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        padding: var(--sp-4) 0 var(--sp-3);
        font-size: var(--t-fine);
        letter-spacing: 0.18em;
        color: var(--board-ink-dim);
      }

      .gate__cut::after {
        content: '';
        flex: 1;
        height: 1px;
        background: repeating-linear-gradient(
          to right,
          var(--board-rule) 0 6px,
          transparent 6px 12px
        );
      }

      @media (max-width: 62rem) {
        .gate {
          grid-template-columns: minmax(0, 1fr);
        }

        .gate__say {
          justify-self: start;
          padding: var(--sp-6) var(--sp-5);
        }

        .ticket {
          max-width: none;
        }

        .gate__board {
          padding: var(--sp-6) var(--sp-5);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .ticket__go {
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

  email = '';
  password = '';
  code = '';

  readonly boardRows = BOARD_ROWS;

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
    this.password = '';
    this.code = '';
  }

  async submit(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);

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
          } else this.error.set(r.message);
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
          } else this.error.set(r.message);
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
        this.error.set(outcome.message);
        break;
    }
  }

  /** Back to where they were heading before the guard sent them here. */
  private async finish(): Promise<void> {
    await this.auth.adopt();
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
  imports: [RouterLink],
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

      <aside class="gate__board" aria-hidden="true">
        <p class="gate__now">Period 2026-02 <span class="gate__sep">/</span> closes in 11 days</p>
        <ol class="gate__rows">
          @for (row of boardRows; track row.pos) {
            @if (row.cut) {
              <li class="gate__cut"><span>Bays run out here</span></li>
            }
            <li class="gate__row" [class.gate__row--on]="row.on" [class.gate__row--past]="row.past">
              <span class="gate__pos">{{ row.pos }}</span>
              <span class="gate__unit">{{ row.unit }}</span>
              <span class="gate__wait">{{ row.wait }}</span>
              <span class="gate__bay">{{ row.bay }}</span>
            </li>
          }
        </ol>
      </aside>
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
        color: #ffffff;
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

      .gate__board {
        background: var(--board);
        color: var(--board-ink);
        padding: var(--sp-7);
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: var(--sp-4);
        overflow: hidden;
      }

      .gate__now {
        margin: 0;
        font-size: var(--t-fine);
        letter-spacing: 0.2em;
        color: var(--board-ink-dim);
      }

      .gate__sep {
        color: var(--board-rule);
        padding: 0 0.4em;
      }

      .gate__rows {
        list-style: none;
        margin: 0;
        padding: 0;
        border-top: 1px solid var(--board-rule);
      }

      .gate__row {
        display: grid;
        grid-template-columns: 3.5ch 1fr 7ch 5ch;
        gap: var(--sp-4);
        align-items: baseline;
        padding: var(--sp-3) 0;
        border-bottom: 1px solid var(--board-rule);
        font-size: var(--t-small);
      }

      .gate__pos {
        font-size: var(--t-body);
        font-variation-settings:
          'wdth' 112,
          'wght' 620;
        color: var(--board-ink-dim);
        text-align: right;
      }

      .gate__unit {
        color: var(--board-ink);
      }

      .gate__wait,
      .gate__bay {
        color: var(--board-ink-dim);
        text-align: right;
      }

      .gate__row--on,
      .gate__row--on .gate__pos,
      .gate__row--on .gate__unit,
      .gate__row--on .gate__wait,
      .gate__row--on .gate__bay {
        color: var(--signal-on-board);
      }

      .gate__row--past {
        opacity: 0.55;
      }

      .gate__cut {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        padding: var(--sp-4) 0 var(--sp-3);
        font-size: var(--t-fine);
        letter-spacing: 0.18em;
        color: var(--board-ink-dim);
      }

      .gate__cut::after {
        content: '';
        flex: 1;
        height: 1px;
        background: repeating-linear-gradient(
          to right,
          var(--board-rule) 0 6px,
          transparent 6px 12px
        );
      }

      @media (max-width: 62rem) {
        .gate {
          grid-template-columns: minmax(0, 1fr);
        }

        .gate__say {
          justify-self: start;
          padding: var(--sp-6) var(--sp-5);
        }

        .gate__board {
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
export class WelcomePage {
  readonly boardRows = BOARD_ROWS;
}
