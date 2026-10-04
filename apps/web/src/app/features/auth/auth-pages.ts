import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthStore } from '../../core/auth/auth.store';

/**
 * The four pages the sign-in round trip needs. They only make sense as a set, so they
 * live together.
 */

@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="gate">
      <p class="gate__mark stencil">PACS</p>
      <h1 class="gate__h">Parking allocation</h1>
      <p class="gate__p">
        A quarterly draw for the building's parking bays. Sign in to see where you stand.
      </p>
      <button class="btn btn--go" type="button" (click)="auth.login()">Sign in</button>
      <p class="gate__fine">
        Accounts are created by the building administration. If you do not have one, ask
        them to add you.
      </p>
    </div>
  `,
  styles: [
    `
      .gate {
        max-width: 30rem;
        margin: 16vh auto 0;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: var(--sp-3);
        border-left: 10px solid var(--bay-line);
        padding-left: var(--sp-5);
      }
      .gate__mark {
        font-size: 2.75rem;
        margin: 0;
      }
      .gate__h {
        font-size: var(--t-title);
        font-weight: 500;
        color: var(--steel-soft);
      }
      .gate__p {
        margin-bottom: var(--sp-2);
      }
      .gate__fine {
        font-size: var(--t-fine);
        color: var(--steel-faint);
        margin-top: var(--sp-2);
      }
    `,
  ],
})
export class LoginPage {
  readonly auth = inject(AuthStore);
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
  imports: [RouterLink],
  template: `
    <!--
      Two states, deliberately told apart. They used to share this page, so a failed
      GET /me was reported as "your account is not linked" — the wrong answer, and one
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
          <button class="btn" type="button" (click)="recheck()">Try again</button>
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
          <button class="btn btn--quiet" type="button" (click)="recheck()">Check again</button>
          @if (auth.isAdmin()) {
            <a class="btn btn--bare" routerLink="/admin/residents">Go to administration</a>
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
  imports: [RouterLink],
  template: `
    <div class="stop" role="alert">
      <h1 class="stop__h">This page is for building administrators</h1>
      <p class="stop__p">
        Your account does not have that permission. If it should, ask the building
        administration to grant it.
      </p>
      <a class="btn btn--quiet" [routerLink]="auth.isAdmin() ? '/admin/residents' : '/'">
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
