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
    title: 'Ingresar · PACS',
    loadComponent: () => import('./features/auth/auth-pages').then((m) => m.LoginPage),
  },
  {
    path: 'callback',
    title: 'Ingresando · PACS',
    loadComponent: () => import('./features/auth/auth-pages').then((m) => m.CallbackPage),
  },
  {
    path: 'forbidden',
    title: 'Sin acceso · PACS',
    loadComponent: () => import('./features/auth/auth-pages').then((m) => m.ForbiddenPage),
  },

  // ----------------------------------------------------------- resident shell
  {
    path: '',
    pathMatch: 'full',
    title: 'Mi estacionamiento · PACS',
    canActivate: [residentGuard],
    loadComponent: () => import('./features/dashboard/dashboard-page'),
  },
  {
    path: 'history',
    title: 'Mi historial · PACS',
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
        title: 'Residentes · PACS',
        loadComponent: () => import('./features/admin/residents-page'),
      },
      {
        path: 'spots',
        title: 'Lugares · PACS',
        loadComponent: () => import('./features/admin/spots-page'),
      },
      {
        path: 'cycles',
        title: 'Ciclos · PACS',
        loadComponent: () => import('./features/admin/cycles-page'),
      },
      {
        path: 'metrics',
        title: 'Equidad · PACS',
        loadComponent: () => import('./features/admin/metrics-page'),
      },
    ],
  },

  { path: '**', canActivate: [authGuard], redirectTo: '' },
];
