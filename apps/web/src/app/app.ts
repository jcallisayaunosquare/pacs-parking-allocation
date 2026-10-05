import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthStore } from './core/auth/auth.store';

/**
 * The shell: auth context, navigation, toasts, outlet (§17, Figure 17.2).
 *
 * The header is a band of painted steel, which is where the product's identity lives —
 * the rest of the chrome stays out of the way. Navigation is built from the roles on
 * the token, and an admin keeps the resident shell too, so the admin links are
 * additive rather than a separate layout.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <a class="skip" href="#main">Skip to content</a>

    @if (auth.authenticated()) {
      <header class="bar">
        <div class="bar__inner">
          <div class="bar__id">
            <span class="bar__mark stencil">PACS</span>
            <span class="bar__what">Parking allocation</span>
          </div>

          <div class="bar__end">
            <span class="bar__who">{{ auth.displayName() }}</span>
            @if (auth.isAdmin()) {
              <span class="bar__role">Administrator</span>
            }
            <button class="bar__out" type="button" (click)="auth.logout()">Sign out</button>
          </div>
        </div>

        @if (links().length > 0) {
          <nav class="nav" aria-label="Sections">
            <ul class="nav__list">
              @for (link of links(); track link.path) {
                <li>
                  <a
                    class="nav__link"
                    [routerLink]="link.path"
                    routerLinkActive="nav__link--on"
                    [routerLinkActiveOptions]="{ exact: link.exact }"
                  >
                    {{ link.label }}
                  </a>
                </li>
              }
            </ul>
          </nav>
        }
      </header>
    }

    <main id="main" class="main">
      <router-outlet />
    </main>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        min-height: 100vh;
      }

      .skip {
        position: absolute;
        left: -9999px;
      }
      .skip:focus {
        left: var(--sp-3);
        top: var(--sp-3);
        z-index: 100;
        background: var(--slab);
        color: var(--steel);
        padding: var(--sp-2) var(--sp-4);
        border: 2px solid var(--steel);
        border-radius: 4px;
      }

      /* The painted band. The only place the brand asserts itself. */
      .bar {
        background: var(--steel);
        color: var(--stencil);
        border-bottom: 5px solid var(--bay-line);
      }

      .bar__inner {
        max-width: 68rem;
        margin: 0 auto;
        padding: var(--sp-4) var(--sp-5) var(--sp-3);
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--sp-5);
        flex-wrap: wrap;
      }

      .bar__id {
        display: flex;
        align-items: baseline;
        gap: var(--sp-3);
      }
      .bar__mark {
        font-size: 1.45rem;
        color: var(--stencil);
      }
      .bar__what {
        font-size: var(--t-fine);
        color: #a9b4c1;
      }

      .bar__end {
        display: flex;
        align-items: baseline;
        gap: var(--sp-3);
        font-size: var(--t-fine);
      }
      .bar__who {
        color: #c3cbd6;
      }
      .bar__role {
        color: var(--bay-line);
        font-weight: 600;
      }
      .bar__out {
        background: none;
        border: 0;
        padding: 0;
        color: var(--stencil);
        cursor: pointer;
        font-size: var(--t-fine);
        text-decoration: underline;
        text-decoration-color: #6d7a88;
        text-underline-offset: 3px;
      }
      .bar__out:hover {
        text-decoration-color: var(--bay-line);
      }

      .nav {
        max-width: 68rem;
        margin: 0 auto;
        padding: 0 var(--sp-5);
      }
      .nav__list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        gap: var(--sp-5);
        flex-wrap: wrap;
      }
      .nav__link {
        display: inline-block;
        padding: var(--sp-2) 0 calc(var(--sp-3) - 3px);
        color: #c3cbd6;
        text-decoration: none;
        border-bottom: 3px solid transparent;
        font-size: 0.9375rem;
      }
      .nav__link:hover {
        color: var(--stencil);
      }
      /* The active tab is marked with the bay line, same language as a held space. */
      .nav__link--on {
        color: var(--stencil);
        font-weight: 600;
        border-bottom-color: var(--bay-line);
      }

      .main {
        flex: 1;
        width: 100%;
        max-width: 68rem;
        margin: 0 auto;
        padding: var(--sp-6) var(--sp-5) var(--sp-8);
      }
    `,
  ],
})
export class App {
  readonly auth = inject(AuthStore);

  readonly links = computed(() => {
    const out: { path: string; label: string; exact: boolean }[] = [];
    if (this.auth.hasResidentRecord()) {
      out.push({ path: '/', label: 'My parking', exact: true });
      out.push({ path: '/history', label: 'History', exact: false });
    }
    if (this.auth.isAdmin()) {
      out.push({ path: '/admin/residents', label: 'Residents', exact: false });
      out.push({ path: '/admin/spots', label: 'Bays', exact: false });
      out.push({ path: '/admin/cycles', label: 'Cycles and draws', exact: false });
      out.push({ path: '/admin/metrics', label: 'Fairness', exact: false });
    }
    return out;
  });
}
