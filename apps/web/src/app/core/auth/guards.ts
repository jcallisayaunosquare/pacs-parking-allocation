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
      /*
       * Someone who asked for a particular page already knows why they came, so they go
       * straight to the form with their destination remembered. Someone who just opened
       * the product gets the front door instead of a password box.
       */
      return state.url === '/'
        ? router.createUrlTree(['/welcome'])
        : router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
    }

    return decide ? decide(auth, router) : true;
  };
}

export const authGuard: CanActivateFn = signedIn();

export const adminGuard: CanActivateFn = signedIn((auth, router) =>
  // A 403 is a product state, not a crash (§17).
  auth.isAdmin() ? true : router.createUrlTree(['/forbidden']),
);

/**
 * The resident surface: "My parking" (`/`) and "History".
 *
 * An administrator is turned away from both, not merely left without a link to them.
 * PRODUCT.md: "An administrator never holds a bay and never enters the draw: separation
 * of duties, because they operate it." Where one person is both - which a small building
 * allows - the admin role wins and the resident half is hidden; see
 * `AuthStore.hasResidentSurface` for why, and the API refuses the same routes to an
 * ADMIN token, which is where it is actually enforced.
 *
 * `/admin` rather than `/admin/residents`: the admin shell owns its own default, so this
 * guard does not have to know what the admin home is today. There is no loop - `/admin`
 * is behind `adminGuard`, which an administrator passes.
 */
export const residentGuard: CanActivateFn = signedIn((auth, router) => {
  if (auth.isAdmin()) return router.createUrlTree(['/admin']);
  // A gate device signing in lands on `/` like everything else. Without this it was told
  // its account was not linked to a resident, which is true and useless.
  if (auth.isCamera()) return router.createUrlTree(['/gate']);
  if (auth.hasResidentRecord()) return true;
  // Not forbidden — unlinked. A resident whose account exists but is not in the register
  // yet needs to be told that, not refused.
  return router.createUrlTree(['/pending']);
});

/**
 * The lot is shared ground, so it has its own guard rather than the resident one.
 *
 * Both roles belong on it and they see different things there: a resident sees that a bay
 * is occupied, an administrator sees by whom. That difference is the server's to make,
 * not this guard's — occupant identity is omitted from the payload for a resident, so
 * nothing on this screen depends on the client being trusted to hide it.
 */
export const lotGuard: CanActivateFn = signedIn((auth, router) =>
  auth.isAdmin() || auth.hasResidentRecord() ? true : router.createUrlTree(['/pending']),
);

/**
 * The gate client. CAMERA, and an administrator too.
 *
 * A gate account is the only one with `POST /captures`, so the device needs it; the
 * administrator is here because somebody installing a camera signs in as themselves to
 * aim it, and because the account that operates the building should not have to borrow a
 * gate's credential to check that a lane works. Everybody else is refused rather than
 * redirected: a resident has no business opening a capture screen.
 */
export const gateGuard: CanActivateFn = signedIn((auth, router) =>
  auth.isCamera() || auth.isAdmin() ? true : router.createUrlTree(['/forbidden']),
);
