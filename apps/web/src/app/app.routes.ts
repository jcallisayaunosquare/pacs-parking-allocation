import type { Routes } from '@angular/router';
import { adminGuard, authGuard, residentGuard } from './core/auth/guards';

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
    path: 'login',
    title: 'Sign in — PACS',
    loadComponent: () => import('./features/auth/auth-pages').then((m) => m.LoginPage),
  },
  {
    path: 'callback',
    title: 'Signing in — PACS',
    loadComponent: () => import('./features/auth/auth-pages').then((m) => m.CallbackPage),
  },
  {
    path: 'pending',
    title: 'Account not linked — PACS',
    canActivate: [authGuard],
    loadComponent: () => import('./features/auth/auth-pages').then((m) => m.PendingPage),
  },
  {
    path: 'forbidden',
    title: 'No access — PACS',
    loadComponent: () => import('./features/auth/auth-pages').then((m) => m.ForbiddenPage),
  },

  // ----------------------------------------------------------- resident shell
  {
    path: '',
    pathMatch: 'full',
    title: 'My parking — PACS',
    canActivate: [residentGuard],
    loadComponent: () => import('./features/dashboard/dashboard-page'),
  },
  {
    path: 'history',
    title: 'My history — PACS',
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
        title: 'Residents — PACS',
        loadComponent: () => import('./features/admin/residents-page'),
      },
      {
        path: 'spots',
        title: 'Bays — PACS',
        loadComponent: () => import('./features/admin/spots-page'),
      },
      {
        path: 'cycles',
        title: 'Cycles and draws — PACS',
        loadComponent: () => import('./features/admin/cycles-page'),
      },
      {
        path: 'metrics',
        title: 'Fairness — PACS',
        loadComponent: () => import('./features/admin/metrics-page'),
      },
    ],
  },

  { path: '**', canActivate: [authGuard], redirectTo: '' },
];
