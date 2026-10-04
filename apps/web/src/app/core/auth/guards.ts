import { inject } from '@angular/core';
import { Router, type CanActivateFn, type GuardResult } from '@angular/router';
import { AuthStore } from './auth.store';

/**
 * Guards for usability, not security (§17). They keep someone off a page that would
 * only return 403; the server decides what anyone may actually read or write.
 *
 * Every dependency is injected synchronously, before the first `await`. That is not a
 * style preference: `inject()` only works inside an injection context, and awaiting
 * leaves it, so an `inject()` after an await throws NG0203. When that happened here the
 * guard died mid-navigation, the router never resolved, and the sign-in callback sat
 * spinning forever with no clue in the UI as to why.
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

/**
 * Builds a guard that is signed in first, then asked `decide`. The dependencies are
 * resolved up front and handed to `decide`, so nothing downstream needs `inject()`.
 */
function signedIn(
  decide?: (auth: AuthStore, router: Router) => GuardResult,
): CanActivateFn {
  return async (_route, state) => {
    const auth = inject(AuthStore);
    const router = inject(Router);

    await waitForCheck(auth);

    if (!auth.authenticated()) {
      // Remember where they were going, so signing in returns them there.
      return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
    }

    return decide ? decide(auth, router) : true;
  };
}

export const authGuard: CanActivateFn = signedIn();

export const adminGuard: CanActivateFn = signedIn((auth, router) =>
  // A 403 is a product state, not a crash (§17).
  auth.isAdmin() ? true : router.createUrlTree(['/forbidden']),
);

/** Keeps an account with no resident record off the resident dashboard. */
export const residentGuard: CanActivateFn = signedIn((auth, router) => {
  if (auth.hasResidentRecord()) return true;
  // Not forbidden — unlinked. An admin has somewhere useful to go; a resident whose
  // account exists but is not in the register yet needs to be told that, not refused.
  return router.createUrlTree(auth.isAdmin() ? ['/admin/residents'] : ['/pending']);
});
