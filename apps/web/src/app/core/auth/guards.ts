import { inject } from '@angular/core';
import { Router, type CanActivateFn, type UrlTree } from '@angular/router';
import { AuthStore } from './auth.store';

/**
 * Guards for usability, not security (§17). They keep a resident off a page that would
 * only return 403; the server decides what anyone may actually read or write.
 *
 * The shared check is a plain async function rather than one guard calling another:
 * `CanActivateFn` may return an Observable, so awaiting another guard gives a union
 * that cannot be compared to `true`. Composing the helper keeps the types honest.
 */

const waitForCheck = async (auth: AuthStore): Promise<void> => {
  if (auth.checked()) return;
  // The app initializer runs checkAuth() before bootstrap finishes, so this covers a
  // deep link arriving mid-flight rather than being a busy wait in the normal case.
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      if (auth.checked()) resolve();
      else setTimeout(tick, 25);
    };
    tick();
  });
};

/** True when signed in, otherwise the UrlTree to send them to. */
async function requireAuth(returnUrl: string): Promise<true | UrlTree> {
  const auth = inject(AuthStore);
  const router = inject(Router);
  await waitForCheck(auth);

  if (auth.authenticated()) return true;
  // Remember where they were going, so login returns them there.
  return router.createUrlTree(['/login'], { queryParams: { returnUrl } });
}

export const authGuard: CanActivateFn = (_route, state) => requireAuth(state.url);

export const adminGuard: CanActivateFn = async (_route, state) => {
  const authed = await requireAuth(state.url);
  if (authed !== true) return authed;

  const auth = inject(AuthStore);
  if (auth.isAdmin()) return true;
  // A 403 is a product state, not a crash (§17).
  return inject(Router).createUrlTree(['/forbidden']);
};

/** Keeps an admin without a resident row off the resident dashboard. */
export const residentGuard: CanActivateFn = async (_route, state) => {
  const authed = await requireAuth(state.url);
  if (authed !== true) return authed;

  const auth = inject(AuthStore);
  if (auth.hasResidentRecord()) return true;
  return inject(Router).createUrlTree(auth.isAdmin() ? ['/admin/residents'] : ['/forbidden']);
};
