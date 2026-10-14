import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { A11yModule } from '@angular/cdk/a11y';
import { BreakpointObserver } from '@angular/cdk/layout';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { filter, map } from 'rxjs';
import { AuthStore } from './core/auth/auth.store';
import { ThemeStore } from './core/theme.store';
import { ToastHost } from './shared/ui/toast';

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
  imports: [
    A11yModule,
    MatIconModule,
    MatMenuModule,
    NgTemplateOutlet,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    ToastHost,
  ],
  template: `
    <a class="skip" href="#main">Skip to content</a>

    @if (chrome()) {
      <header class="bar">
        <div class="bar__inner">
          <div class="bar__start">
            @if (sideNav() && narrow()) {
              <!--
                The hamburger exists only where the sidebar cannot: below 64rem the
                sections would wrap into rows above every page. On a wide screen the
                navigation stays on the left, always visible, for every role.
              -->
              <button
                #burger
                class="burger"
                type="button"
                aria-label="Open navigation"
                aria-controls="side-nav"
                [attr.aria-expanded]="drawerOpen()"
                (click)="openDrawer()"
              >
                <mat-icon>menu</mat-icon>
              </button>
            }
            <div class="bar__id">
              <span class="bar__mark">PACS</span>
              <span class="bar__what">Parking allocation</span>
            </div>
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
      </header>
    }

    <div class="shell" [class.shell--side]="sideNav() && !narrow()">
      @if (sideNav()) {
        @if (!narrow()) {
          <aside id="side-nav" class="side">
            <ng-container [ngTemplateOutlet]="sections" />
          </aside>
        } @else if (drawerOpen()) {
          <div class="scrim" (click)="closeDrawer()" aria-hidden="true"></div>
          <!--
            Rendered only while open, so a closed drawer is not in the tab order or the
            accessibility tree at all. The focus trap moves focus in on open and hands
            it back to the hamburger on close - which is where the person was.
          -->
          <aside
            id="side-nav"
            class="side side--drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            cdkTrapFocus
            [cdkTrapFocusAutoCapture]="true"
            (keydown.escape)="closeDrawer()"
          >
            <button class="side__close" type="button" aria-label="Close navigation" (click)="closeDrawer()">
              <mat-icon>close</mat-icon>
            </button>
            <ng-container [ngTemplateOutlet]="sections" />
          </aside>
        }
      }

      <main id="main" class="main">
        <router-outlet />
      </main>
    </div>

    <!-- Notices about row actions, bottom right, stacked. See shared/ui/toast.ts. -->
    <app-toast-host />

    <!--
      Every role's sections, grouped. The administrator's in the order the work is done
      (see links()), so eight entries read as three steps rather than one long run; a
      resident's three as one group, so both halves of the product wear the same shell.
    -->
    <ng-template #sections>
      <nav class="side__nav" aria-label="Sections">
        @for (group of groups(); track group.label) {
          <section class="side__sec">
            <p class="side__group" [id]="'nav-' + $index">{{ group.label }}</p>
            <ul class="side__list" [attr.aria-labelledby]="'nav-' + $index">
              @for (link of group.links; track link.path) {
                <li>
                  <a
                    class="side__link"
                    [routerLink]="link.path"
                    routerLinkActive="side__link--on"
                    ariaCurrentWhenActive="page"
                    [routerLinkActiveOptions]="{ exact: link.exact }"
                  >
                    @if (link.icon) {
                      <mat-icon class="side__i" aria-hidden="true">{{ link.icon }}</mat-icon>
                    }
                    <span>{{ link.label }}</span>
                  </a>
                </li>
              }
            </ul>
          </section>
        }
      </nav>

      <!-- Who is signed in, at the foot of the column, where it is found and not read. -->
      <div class="side__me">
        <span class="side__avatar" aria-hidden="true">{{ initials() }}</span>
        <span class="side__meText">
          <span class="side__meName">{{ auth.displayName() }}</span>
          <span class="side__meRole">{{ roleLabel() }}</span>
        </span>
      </div>
    </ng-template>
  `,
  styles: [
    `
      :host {
        /* The bar's height, shared with the column so the two together fill one screen. */
        --bar-h: 4.5rem;
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

      /* Held at the top, so the account and the drawer are one reach away down a long page. */
      .bar {
        position: sticky;
        top: 0;
        z-index: 30;
        height: var(--bar-h);
        background: var(--surface-1);
        color: var(--ink-1);
        border-bottom: 1px solid var(--rule);
      }

      .bar__inner {
        max-width: none;
        height: 100%;
        padding: 0 var(--sp-5);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--sp-5);
      }

      .bar__start {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        min-width: 0;
      }

      .bar__id {
        display: flex;
        align-items: baseline;
        gap: var(--sp-3);
        min-width: 0;
      }

      /* Borderless icons like the account trigger, so the bar has one control vocabulary
         at both ends. 44px: it is the only way into the navigation on a phone. */
      .burger,
      .side__close {
        display: inline-grid;
        place-items: center;
        width: 2.75rem;
        height: 2.75rem;
        flex: 0 0 auto;
        padding: 0;
        border: 0;
        border-radius: 3px;
        background: transparent;
        color: var(--ink-2);
        cursor: pointer;
        touch-action: manipulation;
      }

      @media (hover: hover) and (pointer: fine) {
        .burger:hover,
        .side__close:hover {
          background: var(--surface-3);
          color: var(--ink-1);
        }
      }

      .burger:focus-visible,
      .side__close:focus-visible,
      .side__link:focus-visible {
        outline: 2px solid var(--signal);
        outline-offset: 2px;
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
       * The account trigger: an icon and nothing else. The name is chrome a person goes
       * looking for, not something they read while working, so it is in the menu it opens
       * and in the button's accessible name rather than printed on the bar. No border: on
       * its own at the end of the bar it needs no frame, and hover is shown by the same
       * quiet fill the sidebar's links use.
       */
      .who {
        display: inline-grid;
        place-items: center;
        flex: 0 0 auto;
        width: 2.75rem;
        height: 2.75rem;
        padding: 0;
        border: 0;
        border-radius: 3px;
        background: transparent;
        color: var(--ink-2);
        cursor: pointer;
        touch-action: manipulation;
        transition: background-color 140ms ease;
      }

      @media (hover: hover) and (pointer: fine) {
        .who:hover {
          background: var(--surface-3);
          color: var(--ink-1);
          transition-duration: 0ms;
        }
      }

      .who:focus-visible {
        outline: 2px solid var(--signal);
        outline-offset: 2px;
      }

      /*
       * The shell sets no measure. It cannot: a page is a descendant, so a variable it
       * declares is invisible here. Each page owns its own width instead, which is also
       * the truthful arrangement - a floor plan, a register and a dashboard do not want
       * the same measure.
       */
      .main {
        flex: 1;
        min-width: 0;
        /* Only the page cross-fades on a route change: the bar and the column hold
           still, so navigating never moves what the eye is anchored to. */
        view-transition-name: page;
      }

      .shell {
        flex: 1;
        display: flex;
        flex-direction: column;
      }

      /*
       * The administrator's layout on a wide screen: the sections down the left, the page
       * beside them. The window still scrolls - the sidebar is sticky rather than the page
       * being a scroll box - so the router's scroll-to-top on navigation keeps working.
       */
      .shell--side {
        display: grid;
        grid-template-columns: 15rem minmax(0, 1fr);
        align-items: start;
      }

      /* One viewport tall and sticky, so the sections stay in view down a fifty-row
         register. Stretched to the page instead, it would scroll away with it. */
      .side {
        position: sticky;
        top: var(--bar-h);
        height: calc(100vh - var(--bar-h));
        height: calc(100dvh - var(--bar-h));
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        padding: var(--sp-5) var(--sp-4) var(--sp-5);
        background: var(--surface-1);
        border-right: 1px solid var(--rule);
      }

      /*
       * One step of the work per section, divided by a hairline - the rule this product
       * draws everywhere else between things that are separate - with the gap above the
       * line larger than below it, so a heading belongs to what follows it.
       */
      .side__sec + .side__sec {
        margin-top: var(--sp-4);
        padding-top: var(--sp-4);
        border-top: 1px solid var(--rule);
      }

      /* The step's name: the small caps-and-tracking caption the gate settings and the
         tallies already use, set in the width axis the system paints labels in. */
      .side__group {
        margin: 0 0 var(--sp-2);
        padding-left: var(--sp-3);
        font-size: var(--t-fine);
        font-variation-settings:
          'wdth' 112,
          'wght' 640;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--ink-3);
      }

      .side__list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .side__nav {
        flex: 1 0 auto;
      }

      .side__me {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        margin-top: var(--sp-5);
        padding: var(--sp-4) var(--sp-3) 0;
        border-top: 1px solid var(--rule);
      }

      .side__avatar {
        display: inline-grid;
        place-items: center;
        flex: none;
        width: 2.25rem;
        height: 2.25rem;
        border-radius: 3px;
        background: var(--surface-3);
        color: var(--ink-1);
        font-size: var(--t-fine);
        font-variation-settings:
          'wdth' 112,
          'wght' 700;
        letter-spacing: 0.06em;
      }

      .side__meText {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }

      .side__meName {
        font-size: var(--t-small);
        color: var(--ink-1);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .side__meRole {
        font-size: var(--t-fine);
        color: var(--ink-3);
      }

      /* Full-width targets, so the whole row is the link and not just its word. */
      .side__link {
        position: relative;
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        min-height: 2.5rem;
        padding: 0 var(--sp-3);
        font-size: var(--t-small);
        font-variation-settings: 'wght' 460;
        line-height: 1.2;
        color: var(--ink-2);
        text-decoration: none;
        border-radius: 3px;
        transition:
          background-color 160ms ease,
          color 160ms ease;
      }

      /* The position mark grows from the middle of the row rather than appearing, so
         the eye follows the move from one section to the next. */
      .side__link::before {
        content: '';
        position: absolute;
        left: 0;
        top: 18%;
        bottom: 18%;
        width: 3px;
        background: var(--signal);
        transform: scaleY(0);
        transition: transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
      }

      /* A glyph a step quieter than its word, so the label is still what is read. */
      .side__i {
        flex: none;
        width: 20px;
        height: 20px;
        font-size: 20px;
        color: var(--ink-3);
        transition:
          color 160ms ease,
          transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
      }

      @media (hover: hover) and (pointer: fine) {
        .side__link:hover {
          color: var(--ink-1);
          background: var(--surface-3);
        }
        .side__link:hover .side__i {
          color: var(--ink-2);
          transform: translateX(2px);
        }
      }

      /*
       * Where you are: darker, heavier, and the signal mark at the left edge - the colour
       * this product spends on position, drawn as an inset so it costs no layout. The
       * glyph takes the signal too, so the place reads at a glance down the column.
       */
      .side__link--on {
        color: var(--ink-1);
        font-variation-settings: 'wght' 640;
        background: var(--surface-3);
      }

      .side__link--on::before {
        transform: scaleY(1);
      }

      .side__link--on .side__i {
        color: var(--signal);
      }

      /* Below 64rem: a drawer over the page, opened from the hamburger. */
      .side--drawer {
        position: fixed;
        inset: 0 auto 0 0;
        z-index: 40;
        width: min(18rem, 85vw);
        height: auto;
        padding-top: var(--sp-4);
        animation: side-in 240ms cubic-bezier(0.16, 1, 0.3, 1);
      }

      /* The drawer's groups follow it in, one beat apart. */
      .side--drawer .side__sec,
      .side--drawer .side__me {
        animation: side-item 320ms cubic-bezier(0.16, 1, 0.3, 1) both;
      }
      .side--drawer .side__sec:nth-child(2) {
        animation-delay: 50ms;
      }
      .side--drawer .side__sec:nth-child(3) {
        animation-delay: 100ms;
      }
      .side--drawer .side__me {
        animation-delay: 140ms;
      }

      .side__close {
        margin: 0 0 var(--sp-4) auto;
        display: grid;
      }

      .scrim {
        position: fixed;
        inset: 0;
        z-index: 39;
        background: color-mix(in srgb, var(--ink-1) 40%, transparent);
        animation: scrim-in 180ms ease-out;
      }

      @keyframes side-in {
        from {
          transform: translateX(-100%);
        }
      }

      @keyframes side-item {
        from {
          opacity: 0;
          transform: translateX(-12px);
        }
      }

      @keyframes scrim-in {
        from {
          opacity: 0;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .who {
          transition: none;
        }
        .side--drawer,
        .side--drawer .side__sec,
        .side--drawer .side__me,
        .scrim {
          animation: none;
        }
        .side__link,
        .side__link::before,
        .side__i {
          transition: none;
        }
      }
    `,
  ],
})
export class App {
  readonly auth = inject(AuthStore);
  readonly theme = inject(ThemeStore);
  private readonly router = inject(Router);

  /** Below this the sidebar becomes a drawer. The gate screen stacks at the same width. */
  private static readonly NARROW = '(max-width: 64rem)';
  private readonly breakpoints = inject(BreakpointObserver);
  readonly narrow = toSignal(
    this.breakpoints.observe(App.NARROW).pipe(map((s) => s.matches)),
    { initialValue: this.breakpoints.isMatched(App.NARROW) },
  );

  /** The path on screen, as a signal, so the shell can tell a door from a room. */
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  /**
   * The bar and the column, for a signed-in person on a page inside the product. The way
   * in has none: the sign-in finishes its own exit animation after the session exists,
   * and a shell drawn around it for that second would be the wrong frame.
   */
  readonly chrome = computed(
    () => this.auth.authenticated() && !/^\/(login|welcome|callback)(\/|\?|$)/.test(this.url()),
  );

  /** Every signed-in role navigates from the same left column. */
  readonly sideNav = computed(() => this.chrome() && this.links().length > 0);

  readonly roleLabel = computed(() =>
    this.auth.isAdmin()
      ? 'Building administrator'
      : this.auth.isCamera()
        ? 'Gate device'
        : 'Resident',
  );

  /** Two letters for the account mark: from the name, or from the address without one. */
  readonly initials = computed(() => {
    const words = this.auth
      .displayName()
      .replace(/@.*/, '')
      .split(/[\s._-]+/)
      .filter(Boolean);
    const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2);
    return letters.toUpperCase();
  });

  readonly drawerOpen = signal(false);
  private readonly burger = viewChild<ElementRef<HTMLButtonElement>>('burger');

  constructor() {
    // Choosing a section is the end of the drawer's job; it closes behind the navigation.
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.drawerOpen.set(false));

    // Widening the window with the drawer open would leave it open, unseen, for the next
    // time the window narrows.
    effect(() => {
      if (!this.narrow()) this.drawerOpen.set(false);
    });
  }

  openDrawer(): void {
    this.drawerOpen.set(true);
  }

  closeDrawer(): void {
    this.drawerOpen.set(false);
    // Back to the control that opened it, which is where the person was. The trap's own
    // restore covers the destroy path; this covers a close by Escape or the scrim too.
    queueMicrotask(() => this.burger()?.nativeElement.focus());
  }

  /**
   * The same links, in the same order, under the step of the work they belong to. The
   * order is the one links() argues for; the groups only name its stretches.
   */
  readonly groups = computed(() => {
    const byPath = new Map(this.links().map((l) => [l.path, l]));
    const pick = (...paths: string[]) =>
      paths.map((p) => byPath.get(p)).filter((l): l is NonNullable<typeof l> => !!l);
    if (!this.auth.isAdmin()) {
      return [{ label: this.auth.isCamera() ? 'Gate' : 'Your parking', links: this.links() }];
    }
    return [
      { label: 'Set up', links: pick('/admin/residents', '/admin/spots', '/admin/metrics') },
      { label: 'Run a period', links: pick('/admin/cycles', '/admin/draw', '/lot') },
      { label: 'Watch and report', links: pick('/gate', '/admin/reports') },
    ].filter((g) => g.links.length > 0);
  });

  readonly themes = [
    { value: 'light' as const, label: 'Light appearance', icon: 'light_mode' },
    { value: 'dark' as const, label: 'Dark appearance', icon: 'dark_mode' },
  ];

  /**
   * Navigation is built from the roles on the principal, so a resident never downloads a
   * link to a screen the server would refuse them.
   */
  readonly links = computed(() => {
    const out: { path: string; label: string; exact: boolean; icon?: string }[] = [];
    /*
     * The resident half, which an administrator does not have. It used to be built from
     * `hasResidentRecord()` alone, so an administrator who also had a register row - the
     * one person who is both, in a small building - was offered "My parking" and their
     * own unit by the product that says they never hold a bay. The lot is not in here:
     * it is shared ground, reached by both roles from the group each of them owns.
     */
    if (this.auth.hasResidentSurface()) {
      out.push({ path: '/', label: 'My parking', exact: true, icon: 'confirmation_number' });
      out.push({ path: '/lot', label: 'The lot', exact: false, icon: 'map' });
      out.push({ path: '/history', label: 'History', exact: false, icon: 'history' });
    }
    /*
     * A gate account gets one link and nothing else. It is a machine role: the only route
     * the server will serve it is `POST /captures`, so offering it the lot or a register
     * would be offering it a 403 with a nicer name.
     */
    if (this.auth.isCamera() && !this.auth.isAdmin()) {
      out.push({ path: '/gate', label: 'Gate camera', exact: false, icon: 'videocam' });
      return out;
    }
    if (this.auth.isAdmin()) {
      /*
       * In the order the work is done, because the order is not obvious and the menu is
       * the only place it is written down. An administrator running their first period
       * has to: enter the people, enter the bays, set the rules that decide how long a
       * period lasts, create the period and open it for entries, draw it, and then look
       * at what came out.
       *
       * Run the draw used to sit above Periods, which read as the first thing to try and
       * is the one thing that cannot be done yet: there is no period to draw.
       */
      /*
       * Each with a glyph, for the sidebar only. Chosen for what the screen is, not for
       * decoration: the draw is a numbered list because the allocation is a stated order
       * with a seeded tie-break, not a lottery - dice would say the opposite of the
       * product. Every name here must also be in index.html's icon_names.
       */
      out.push({ path: '/admin/residents', label: 'Residents', exact: false, icon: 'group' });
      out.push({ path: '/admin/spots', label: 'Bays', exact: false, icon: 'local_parking' });
      // Before Periods because it holds the rules editor, and allocationDuration decides
      // how long the period about to be created will run for. "Fairness" alone hid that:
      // an administrator looking for the period length had no reason to open a page that
      // sounded like a report.
      out.push({
        path: '/admin/metrics',
        label: 'Fairness & rules',
        exact: false,
        icon: 'balance',
      });
      out.push({ path: '/admin/cycles', label: 'Periods', exact: false, icon: 'calendar_month' });
      out.push({
        path: '/admin/draw',
        label: 'Run the draw',
        exact: false,
        icon: 'format_list_numbered',
      });
      // After the draw, because this is where its result is read: who ended up where.
      // The same inventory as Bays seen the other way round, and the one screen the two
      // roles genuinely share - an administrator sees occupants on it, a resident does
      // not.
      out.push({ path: '/lot', label: 'The lot', exact: false, icon: 'map' });
      // One entry for the whole of M-7: the camera, the arrival it produced and the
      // record of every frame are one screen, because they are one job. It sits after
      // the sequence above because it is watched between periods rather than while
      // running one, and far more often than a report is produced.
      out.push({ path: '/gate', label: 'Gate', exact: false, icon: 'videocam' });
      // Last, because it is what an administrator does at the end of a period.
      out.push({
        path: '/admin/reports',
        label: 'Reports',
        exact: false,
        icon: 'description',
      });
    }
    return out;
  });
}
