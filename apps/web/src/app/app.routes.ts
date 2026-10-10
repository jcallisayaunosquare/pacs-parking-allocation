import type { Routes } from '@angular/router';
import { adminGuard, authGuard, gateGuard, lotGuard, residentGuard } from './core/auth/guards';

/**
 * The route map of Figure 17.1. Every feature is lazy-loaded, so a resident never
 * downloads the admin screens — that is what keeps the initial bundle inside the
 * budget in angular.json (§17).
 *
 * The guards are for usability, not security: they stop someone landing on a page that
 * would only 403. The server is the boundary.
 */
export const routes: Routes = [
  {
    path: 'welcome',
    title: 'PACS',
    loadComponent: () => import('./features/auth/auth-pages').then((m) => m.WelcomePage),
  },
  {
    path: 'login',
    title: 'Sign in - PACS',
    loadComponent: () => import('./features/auth/auth-pages').then((m) => m.LoginPage),
  },
  {
    path: 'callback',
    title: 'Signing in - PACS',
    loadComponent: () => import('./features/auth/auth-pages').then((m) => m.CallbackPage),
  },
  {
    path: 'pending',
    title: 'Account not linked - PACS',
    canActivate: [authGuard],
    loadComponent: () => import('./features/auth/auth-pages').then((m) => m.PendingPage),
  },
  {
    path: 'forbidden',
    title: 'No access - PACS',
    loadComponent: () => import('./features/auth/auth-pages').then((m) => m.ForbiddenPage),
  },

  // ----------------------------------------------------------- resident shell
  {
    path: '',
    pathMatch: 'full',
    title: 'My parking - PACS',
    canActivate: [residentGuard],
    loadComponent: () => import('./features/dashboard/dashboard-page'),
  },
  /*
   * The lot sits in neither shell. Both roles reach it and see different things there,
   * so it is guarded by neither the resident guard (which now turns an administrator
   * away) nor the admin guard.
   */
  {
    path: 'lot',
    title: 'The lot - PACS',
    canActivate: [lotGuard],
    loadComponent: () => import('./features/lot/lot-page'),
  },
  /*
   * The gate, outside both shells, because one of the two people who open it is not a
   * person: a CAMERA account is a device, and this is its whole app. An administrator
   * gets the same route with the verdict and the log on it, which is the entire M-7
   * surface in one screen.
   */
  {
    path: 'gate',
    title: 'Gate - PACS',
    canActivate: [gateGuard],
    loadComponent: () => import('./features/gate/gate-page'),
  },
  {
    path: 'history',
    title: 'My history - PACS',
    canActivate: [residentGuard],
    loadComponent: () => import('./features/history/history-page'),
  },

  // -------------------------------------------------------------- admin shell
  {
    path: 'admin',
    canActivate: [adminGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'residents' },
      {
        path: 'residents',
        title: 'Residents - PACS',
        loadComponent: () => import('./features/admin/residents-page'),
      },
      {
        path: 'spots',
        title: 'Bays - PACS',
        loadComponent: () => import('./features/admin/spots-page'),
      },
      {
        path: 'draw',
        title: 'Run the draw - PACS',
        loadComponent: () => import('./features/admin/draw-page'),
      },
      {
        path: 'cycles',
        title: 'Periods - PACS',
        loadComponent: () => import('./features/admin/cycles-page'),
      },
      {
        path: 'metrics',
        title: 'Fairness and rules - PACS',
        loadComponent: () => import('./features/admin/metrics-page'),
      },
      /*
       * M-7 had three admin routes - a live board, a log, and a camera outside the shell.
       * They are one job and they are now one screen at `/gate`. These two stay as
       * redirects rather than being deleted: they were linked from the navigation and
       * from the documents, and a bookmark that 404s is a worse answer than a forward.
       */
      { path: 'arrivals', pathMatch: 'full', redirectTo: '/gate' },
      { path: 'plates', pathMatch: 'full', redirectTo: '/gate' },
      /*
       * Reports sits in the admin shell rather than beside the lot: it is the record an
       * administrator is asked to produce for the building, and PRODUCT.md lists
       * "export the record of a period" as their job, not a resident's.
       */
      {
        path: 'reports',
        title: 'Reports - PACS',
        loadComponent: () => import('./features/reports/reports-page'),
      },
    ],
  },

  { path: '**', canActivate: [authGuard], redirectTo: '' },
];
