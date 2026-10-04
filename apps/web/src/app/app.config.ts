import {
  type ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
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
 * whole app runs against fakes, which is what the unit tests do.
 *
 * There is no UI component library in this list. PrimeNG was the original choice in §10,
 * from when it was MIT; version 22 is part of PrimeUI, a commercial family that requires
 * a license key and annual eligibility renewal even on its free tier, and it prints a
 * license notice without one. The controls are native elements with our own classes
 * instead — no key, no renewal, and the design is not fighting a vendor theme's tokens.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),

    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'top' }),
    ),

    // `withFetch` so requests are abortable — `resource()` cancels an in-flight load
    // when its params change, which is what stops a fast filter from racing itself.
    provideHttpClient(withFetch(), withInterceptors([authInterceptor, traceInterceptor])),

    provideAuth(authConfig),

    // ------------------------------------------------- domain → data bindings
    { provide: MeRepository, useClass: HttpMeRepository },
    { provide: DashboardRepository, useClass: HttpDashboardRepository },
    { provide: ResidentRepository, useClass: HttpResidentRepository },
    { provide: SpotRepository, useClass: HttpSpotRepository },
    { provide: CycleRepository, useClass: HttpCycleRepository },
    { provide: RunRepository, useClass: HttpRunRepository },
    { provide: MetricsRepository, useClass: HttpMetricsRepository },

    /**
     * Resolve the session before the first route renders. Without this, a reload on a
     * guarded URL bounces to /login for a frame before the token is known, which looks
     * like a bug even though it corrects itself.
     */
    provideAppInitializer(() => inject(AuthStore).restore()),
  ],
};
