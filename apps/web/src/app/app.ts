import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { AuthStore } from './core/auth/auth.store';

/**
 * The app shell (§17, Figure 17.2): auth context, nav, toasts, and the outlet.
 *
 * Navigation is built from the roles on the token. An admin also gets the resident
 * shell, which is why the admin links are additive rather than a separate layout.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ButtonModule, ToastModule],
  template: `
    <a class="skip" href="#main">Saltar al contenido</a>
    <p-toast position="bottom-right" />

    @if (auth.authenticated()) {
      <header class="bar">
        <nav class="bar__nav" aria-label="Principal">
          <span class="bar__brand">PACS</span>
          @for (link of links(); track link.path) {
            <a
              class="bar__link"
              [routerLink]="link.path"
              routerLinkActive="bar__link--on"
              [routerLinkActiveOptions]="{ exact: link.exact }"
            >
              {{ link.label }}
            </a>
          }
        </nav>
        <div class="bar__right">
          <span class="bar__who">{{ auth.displayName() }}</span>
          @if (auth.isAdmin()) {
            <span class="bar__role">admin</span>
          }
          <p-button
            label="Salir"
            icon="pi pi-sign-out"
            severity="secondary"
            [text]="true"
            size="small"
            (onClick)="auth.logout()"
          />
        </div>
      </header>
    }

    <main id="main" class="main">
      <router-outlet />
    </main>
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: 100vh;
        background: #f7f6f4;
      }
      .skip {
        position: absolute;
        left: -9999px;
      }
      .skip:focus {
        left: 0.5rem;
        top: 0.5rem;
        z-index: 100;
        background: #fff;
        padding: 0.5rem 0.9rem;
        border-radius: 6px;
        border: 2px solid #2c6b4a;
      }
      .bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.6rem 1.25rem;
        background: #fff;
        border-bottom: 1px solid #e2e0dc;
        flex-wrap: wrap;
      }
      .bar__nav {
        display: flex;
        align-items: center;
        gap: 1.1rem;
        flex-wrap: wrap;
      }
      .bar__brand {
        font-weight: 760;
        letter-spacing: -0.01em;
        margin-right: 0.4rem;
      }
      .bar__link {
        text-decoration: none;
        color: #4a4a4a;
        font-size: 0.88rem;
        padding: 0.3rem 0;
        border-bottom: 2px solid transparent;
      }
      .bar__link:hover {
        color: #1d1d1d;
      }
      .bar__link--on {
        color: #1d5438;
        border-bottom-color: #2c6b4a;
        font-weight: 620;
      }
      .bar__right {
        display: flex;
        align-items: center;
        gap: 0.6rem;
      }
      .bar__who {
        font-size: 0.85rem;
        color: #4a4a4a;
      }
      .bar__role {
        font-size: 0.68rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        background: #e7eef8;
        color: #22456f;
        padding: 0.1rem 0.4rem;
        border-radius: 4px;
        font-weight: 700;
      }
      .main {
        max-width: 72rem;
        margin: 0 auto;
        padding: 1.5rem 1.25rem 4rem;
      }
    `,
  ],
})
export class App {
  readonly auth = inject(AuthStore);

  readonly links = computed(() => {
    const out: { path: string; label: string; exact: boolean }[] = [];
    if (this.auth.hasResidentRecord()) {
      out.push({ path: '/', label: 'Mi panel', exact: true });
      out.push({ path: '/history', label: 'Historial', exact: false });
    }
    if (this.auth.isAdmin()) {
      out.push({ path: '/admin/residents', label: 'Residentes', exact: false });
      out.push({ path: '/admin/spots', label: 'Lugares', exact: false });
      out.push({ path: '/admin/cycles', label: 'Ciclos', exact: false });
      out.push({ path: '/admin/metrics', label: 'Equidad', exact: false });
    }
    return out;
  });
}
