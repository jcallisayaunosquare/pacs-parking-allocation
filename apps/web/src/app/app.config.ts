import {
  type ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { providePrimeNG } from 'primeng/config';
import Aura from '@primeuix/themes/aura';
import { ConfirmationService, MessageService } from 'primeng/api';
import { provideAuth } from 'angular-auth-oidc-client';

import { routes } from './app.routes';
import { authConfig } from './core/auth/auth.config';
import { AuthStore } from './core/auth/auth.store';
import { authInterceptor, traceInterceptor } from './core/http/interceptors';

import {
  CycleRepository,
  DashboardRepository,
  MeRepository,
  MetricsRepository,
  ResidentRepository,
  RunRepository,
  SpotRepository,
} from './domain/repositories';
import {
  HttpCycleRepository,
  HttpDashboardRepository,
  HttpMeRepository,
  HttpMetricsRepository,
  HttpResidentRepository,
  HttpRunRepository,
  HttpSpotRepository,
} from './data/http.repositories';

/**
 * The composition root of the frontend (§10): the one place that binds the domain's
 * abstract repository contracts to their HTTP implementations. Swap a line here and the
 * whole app runs against fakes — which is exactly what the unit tests do.
 *
 * Nothing above the data ring imports HttpClient, and nothing below `features/` imports
 * PrimeNG.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),

    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'top' }),
    ),

    // `withFetch` so requests are abortable — `resource()` cancels in-flight loads
    // when its params change, which is what stops a fast filter from racing itself.
    provideHttpClient(withFetch(), withInterceptors([authInterceptor, traceInterceptor])),

    provideAuth(authConfig),

    providePrimeNG({
      theme: {
        preset: Aura,
        options: {
          // Scope the dark selector to something we never set, so the app stays light
          // and predictable instead of following the OS at random.
          darkModeSelector: '.pacs-dark',
          cssLayer: { name: 'primeng', order: 'base, primeng' },
        },
      },
      ripple: false,
    }),
    MessageService,
    ConfirmationService,

    // ------------------------------------------------- domain → data bindings
    { provide: MeRepository, useClass: HttpMeRepository },
    { provide: DashboardRepository, useClass: HttpDashboardRepository },
    { provide: ResidentRepository, useClass: HttpResidentRepository },
    { provide: SpotRepository, useClass: HttpSpotRepository },
    { provide: CycleRepository, useClass: HttpCycleRepository },
    { provide: RunRepository, useClass: HttpRunRepository },
    { provide: MetricsRepository, useClass: HttpMetricsRepository },

    /**
     * Resolve the session before the first route renders. Without this a reload on a
     * guarded URL bounces to /login for a frame before the token is known, which looks
     * like a bug even though it corrects itself.
     */
    provideAppInitializer(() => inject(AuthStore).restore()),
  ],
};
