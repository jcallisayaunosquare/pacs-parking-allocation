import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { AuthStore } from './core/auth/auth.store';
import { ThemeStore } from './core/theme.store';

/**
 * The shell: auth context, navigation, outlet.
 *
 * The bar carries the product's identity and one control. Everything that used to sit
 * there - the name, the role badge, two appearance buttons and a sign-out link - was
 * chrome a person goes looking for rather than reads while working, so it moved behind a
 * single account trigger.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatIconModule, MatMenuModule],
  template: `
    <a class="skip" href="#main">Skip to content</a>

    @if (auth.authenticated()) {
      <header class="bar">
        <div class="bar__inner">
          <div class="bar__id">
            <span class="bar__mark">PACS</span>
            <span class="bar__what">Parking allocation</span>
          </div>

          <!--
            One control instead of four. A hamburger would be the wrong instrument here:
            that one means navigation, and the navigation is already on the row below.
            This is an account.
          -->
          <button
            class="who"
            type="button"
            [matMenuTriggerFor]="accountMenu"
            [attr.aria-label]="'Account: ' + auth.displayName()"
          >
            <mat-icon>person</mat-icon>
            <span class="who__name">{{ auth.displayName() }}</span>
          </button>

          <mat-menu #accountMenu="matMenu" xPosition="before">
            <div class="acct">
              <p class="acct__name">{{ auth.displayName() }}</p>
              <p class="acct__role">
                {{ auth.isAdmin() ? 'Building administrator' : 'Resident' }}
              </p>
            </div>

            <div class="acct__sep" role="separator"></div>

            <p class="acct__label">Appearance</p>
            @for (t of themes; track t.value) {
              <button
                mat-menu-item
                type="button"
                [attr.aria-pressed]="theme.choice() === t.value"
                (click)="theme.set(t.value)"
              >
                <mat-icon>{{ t.icon }}</mat-icon>
                <span>{{ t.label }}</span>
                @if (theme.choice() === t.value) {
                  <mat-icon class="acct__tick">check</mat-icon>
                }
              </button>
            }

            <div class="acct__sep" role="separator"></div>

            <button mat-menu-item type="button" (click)="auth.logout()">
              <mat-icon>logout</mat-icon>
              <span>Sign out</span>
            </button>
          </mat-menu>
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
        min-height: 100dvh;
      }

      .skip {
        position: absolute;
        left: -9999px;
      }

      .skip:focus {
        position: static;
        display: inline-block;
        padding: var(--sp-2) var(--sp-4);
        background: var(--surface-1);
        color: var(--ink-1);
      }

      .bar {
        background: var(--surface-1);
        color: var(--ink-1);
        border-bottom: 1px solid var(--rule);
      }

      .bar__inner {
        max-width: none;
        padding: var(--sp-4) var(--sp-5) var(--sp-3);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--sp-5);
      }

      .bar__id {
        display: flex;
        align-items: baseline;
        gap: var(--sp-3);
        min-width: 0;
      }

      .bar__mark {
        font-size: var(--t-lead);
        font-variation-settings:
          'wdth' 112,
          'wght' 720;
        letter-spacing: 0.06em;
        color: var(--ink-1);
      }

      .bar__what {
        font-size: var(--t-small);
        color: var(--ink-3);
      }

      /*
       * The account trigger. Chrome, so it sits at the quietest weight the bar has, and
       * the name is dropped on narrow screens where the icon alone still identifies it.
       */
      .who {
        display: inline-flex;
        align-items: center;
        gap: var(--sp-2);
        flex: 0 0 auto;
        font: inherit;
        font-size: var(--t-small);
        min-height: 2.5rem;
        padding: 0 var(--sp-3);
        border: 1px solid var(--rule);
        border-radius: 3px;
        background: transparent;
        color: var(--ink-2);
        cursor: pointer;
        touch-action: manipulation;
        transition: border-color 140ms ease;
      }

      @media (hover: hover) and (pointer: fine) {
        .who:hover {
          border-color: var(--ink-3);
          transition-duration: 0ms;
        }
      }

      .who mat-icon {
        font-size: 18px;
        width: 18px;
        height: 18px;
        color: var(--ink-3);
      }

      @media (max-width: 40rem) {
        .who__name {
          display: none;
        }
      }

      .nav {
        padding: 0 var(--sp-5);
        border-top: 1px solid var(--rule-soft);
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
        padding: var(--sp-3) 0 calc(var(--sp-3) - 3px);
        font-size: var(--t-small);
        color: var(--ink-2);
        text-decoration: none;
        /* Reserved at rest, so the active mark does not shift the row. */
        border-bottom: 3px solid transparent;
      }

      @media (hover: hover) and (pointer: fine) {
        .nav__link:hover {
          color: var(--ink-1);
        }
      }

      .nav__link--on {
        color: var(--ink-1);
        border-bottom-color: var(--signal);
      }

      /*
       * The shell sets no measure. It cannot: a page is a descendant, so a variable it
       * declares is invisible here. Each page owns its own width instead, which is also
       * the truthful arrangement - a floor plan, a register and a dashboard do not want
       * the same measure.
       */
      .main {
        flex: 1;
      }

      @media (prefers-reduced-motion: reduce) {
        .who {
          transition: none;
        }
      }
    `,
  ],
})
export class App {
  readonly auth = inject(AuthStore);
  readonly theme = inject(ThemeStore);

  readonly themes = [
    { value: 'light' as const, label: 'Light appearance', icon: 'light_mode' },
    { value: 'dark' as const, label: 'Dark appearance', icon: 'dark_mode' },
  ];

  /**
   * Navigation is built from the roles on the principal, so a resident never downloads a
   * link to a screen the server would refuse them.
   */
  readonly links = computed(() => {
    const out: { path: string; label: string; exact: boolean }[] = [];
    /*
     * The resident half, which an administrator does not have. It used to be built from
     * `hasResidentRecord()` alone, so an administrator who also had a register row - the
     * one person who is both, in a small building - was offered "My parking" and their
     * own unit by the product that says they never hold a bay. The lot is not in here:
     * it is shared ground, reached by both roles from the group each of them owns.
     */
    if (this.auth.hasResidentSurface()) {
      out.push({ path: '/', label: 'My parking', exact: true });
      out.push({ path: '/lot', label: 'The lot', exact: false });
      out.push({ path: '/history', label: 'History', exact: false });
    }
    /*
     * A gate account gets one link and nothing else. It is a machine role: the only route
     * the server will serve it is `POST /captures`, so offering it the lot or a register
     * would be offering it a 403 with a nicer name.
     */
    if (this.auth.isCamera() && !this.auth.isAdmin()) {
      out.push({ path: '/gate', label: 'Gate camera', exact: false });
      return out;
    }
    if (this.auth.isAdmin()) {
      out.push({ path: '/admin/residents', label: 'Residents', exact: false });
      out.push({ path: '/admin/spots', label: 'Bays', exact: false });
      // Next to Bays, because the two are the same inventory seen two ways: the register
      // of them, and where they are. An administrator sees occupants on it; a resident
      // does not, which is the one screen the two roles genuinely share.
      out.push({ path: '/lot', label: 'The lot', exact: false });
      out.push({ path: '/admin/draw', label: 'Run the draw', exact: false });
      out.push({ path: '/admin/cycles', label: 'Periods', exact: false });
      // "Fairness" alone hid the rules editor: an administrator looking for the period
      // length had no reason to open a page that sounded like a report.
      out.push({ path: '/admin/metrics', label: 'Fairness & rules', exact: false });
      // After the draw group and before Reports: the gate log is something an
      // administrator watches between periods rather than while running one, but it is
      // checked far more often than a report is produced.
      // One entry for the whole of M-7: the camera, the arrival it produced and the
      // record of every frame are one screen, because they are one job.
      out.push({ path: '/gate', label: 'Gate', exact: false });
      // Last, because it is what an administrator does at the end of a period rather
      // than while running one.
      out.push({ path: '/admin/reports', label: 'Reports', exact: false });
    }
    return out;
  });
}
