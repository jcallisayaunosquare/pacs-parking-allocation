import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { AuthStore } from '../../core/auth/auth.store';

/**
 * The three pages the login round trip needs. Small enough to live together, and they
 * only make sense as a set.
 */

@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule],
  template: `
    <div class="gate">
      <h1 class="gate__title">PACS</h1>
      <p class="gate__sub">Asignación de estacionamiento</p>
      <p class="gate__body">
        Ingresá con la cuenta del edificio. Te lleva a la pantalla de Cognito y vuelve acá.
      </p>
      <p-button label="Ingresar" icon="pi pi-sign-in" (onClick)="auth.login()" />
    </div>
  `,
  styles: [
    `
      .gate {
        max-width: 26rem;
        margin: 15vh auto 0;
        text-align: center;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
      }
      .gate__title {
        margin: 0;
        font-size: 2rem;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .gate__sub {
        margin: 0;
        color: #6a6a6a;
        font-size: 0.9rem;
      }
      .gate__body {
        margin: 0.8rem 0 1rem;
        color: #5d5d5d;
        line-height: 1.55;
        font-size: 0.92rem;
      }
    `,
  ],
})
export class LoginPage {
  readonly auth = inject(AuthStore);
}

/**
 * Where Cognito redirects back to. The OIDC client has already processed the code by
 * the time this renders (the app initializer runs `checkAuth()` on every load,
 * including this one), so the job here is only to send the user where they were going.
 */
@Component({
  selector: 'app-callback-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProgressSpinnerModule],
  template: `
    <div class="wait" aria-live="polite">
      <p-progress-spinner [style]="{ width: '2.5rem', height: '2.5rem' }" strokeWidth="4" />
      <p>Completando el ingreso…</p>
    </div>
  `,
  styles: [
    `
      .wait {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1rem;
        margin-top: 20vh;
        color: #5d5d5d;
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
    // An admin with no resident row has no dashboard, so send them somewhere useful.
    const fallback = this.auth.hasResidentRecord()
      ? '/'
      : this.auth.isAdmin()
        ? '/admin/residents'
        : '/forbidden';
    void this.router.navigateByUrl(returnUrl ?? fallback);
  }
}

/** A 403 is a product state, not a crash (§17). */
@Component({
  selector: 'app-forbidden-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule, RouterLink],
  template: `
    <div class="gate" role="alert">
      <i class="pi pi-lock gate__icon" aria-hidden="true"></i>
      <h1 class="gate__title">No tenés acceso a esta sección</h1>
      <p class="gate__body">
        @if (auth.isAdmin()) {
          Tu cuenta es de administración y no tiene una ficha de residente, así que no hay
          un panel personal que mostrar.
        } @else {
          Esta pantalla es solo para administradores del edificio.
        }
      </p>
      <p-button
        [label]="auth.isAdmin() ? 'Ir a residentes' : 'Volver a mi panel'"
        [routerLink]="auth.isAdmin() ? '/admin/residents' : '/'"
        severity="secondary"
      />
    </div>
  `,
  styles: [
    `
      .gate {
        max-width: 32rem;
        margin: 15vh auto 0;
        text-align: center;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.6rem;
      }
      .gate__icon {
        font-size: 1.8rem;
        opacity: 0.5;
      }
      .gate__title {
        margin: 0;
        font-size: 1.25rem;
        font-weight: 660;
      }
      .gate__body {
        margin: 0 0 0.8rem;
        color: #5d5d5d;
        line-height: 1.55;
        font-size: 0.92rem;
        max-width: 48ch;
      }
    `,
  ],
})
export class ForbiddenPage {
  readonly auth = inject(AuthStore);
}
