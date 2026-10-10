import { Injectable, computed, inject, signal } from '@angular/core';
import { CognitoService } from './cognito.service';
import { firstValueFrom } from 'rxjs';
import { MeRepository } from '../../domain/repositories';
import type { ApiError, Principal, Role } from '../../domain/models';
import { toApiError } from '../http/api-error';
import { cognitoLogoutUrl } from './auth.config';

/**
 * Session state as signals. The token lives in the OIDC client's memory and is never
 * copied here — only the derived facts the UI needs.
 *
 * Roles come from `cognito:groups` on the access token. They drive navigation and the
 * route guards, which exist for usability: they stop a resident landing on a page that
 * would only 403. The security boundary is the server, always (§17).
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly cognito = inject(CognitoService);
  private readonly me = inject(MeRepository);

  private readonly _principal = signal<Principal | null>(null);
  private readonly _checked = signal(false);
  private readonly _authenticated = signal(false);
  private readonly _principalError = signal<ApiError | null>(null);

  readonly principal = this._principal.asReadonly();
  readonly authenticated = this._authenticated.asReadonly();
  /** False until the first `checkAuth()` resolves, so guards do not bounce too early. */
  readonly checked = this._checked.asReadonly();

  /**
   * Why the principal is missing, when it is.
   *
   * This used to be swallowed, which made two completely different situations look
   * identical: an account that is genuinely not linked to a resident yet, and a
   * `GET /me` that failed. Someone who had just signed in was told their account was
   * not linked when in fact the request never came back.
   */
  readonly principalError = this._principalError.asReadonly();
  readonly principalLoaded = computed(() => this._principal() !== null);

  readonly roles = computed<readonly Role[]>(() => this._principal()?.roles ?? []);
  readonly isAdmin = computed(() => this.roles().includes('ADMIN'));
  readonly isResident = computed(() => this.roles().includes('RESIDENT'));
  /** A gate device. It has one screen and no part of the rest of the product. */
  readonly isCamera = computed(() => this.roles().includes('CAMERA'));
  readonly displayName = computed(
    () => this._principal()?.resident?.fullName ?? this._principal()?.email ?? '',
  );
  /** An admin with no resident row has no dashboard to show. */
  readonly hasResidentRecord = computed(() => this._principal()?.resident != null);

  /**
   * Whether this account has a resident half at all — "My parking" and "History".
   *
   * PRODUCT.md: "An administrator never holds a bay and never enters the draw:
   * separation of duties, because they operate it." In a small building one person may
   * legitimately be both, and the codebase already takes a position on which wins:
   * `resident.is_admin` makes the register row ineligible, the allocation snapshot skips
   * it with `ADMIN_ACCOUNT`, and the API refuses the resident routes to an ADMIN token.
   * So: the admin role wins and the resident surface is hidden, because an account that
   * operates the draw cannot also be a party to it. The lot is not part of this — it is
   * shared ground, and it is where the two roles see deliberately different things.
   *
   * Having a resident row is still required: it is what "my parking" would be about.
   */
  readonly hasResidentSurface = computed(() => this.hasResidentRecord() && !this.isAdmin());

  /** Called once at startup by the app initializer. */
  async restore(): Promise<void> {
    try {
      const signedIn = await this.cognito.restore();
      this._authenticated.set(signedIn);
      if (signedIn) await this.loadPrincipal();
    } catch {
      this._authenticated.set(false);
    } finally {
      this._checked.set(true);
    }
  }

  /**
   * Called by the sign-in form once Cognito has issued a session. Loading the principal
   * here rather than in the form keeps every route guard reading one source of truth.
   */
  async adopt(): Promise<void> {
    this._authenticated.set(true);
    await this.loadPrincipal();
    this._checked.set(true);
  }

  /**
   * `GET /me` is the only source of the principal. The roles could be decoded from the
   * token locally, but the resident record cannot — the server resolves it from the
   * subject, which is also what links a freshly provisioned Cognito user to its row.
   */
  async loadPrincipal(): Promise<void> {
    try {
      this._principal.set(await this.me.principal());
      this._principalError.set(null);
    } catch (e) {
      this._principal.set(null);
      this._principalError.set(toApiError(e));
    }
  }

  /** The form owns sign-in now; this only exists for links that point at it. */
  login(): void {
    window.location.href = '/login';
  }

  logout(): void {
    // Drop local state first, so a failed redirect cannot leave a half-signed-in UI.
    this._principal.set(null);
    this._principalError.set(null);
    this._authenticated.set(false);
    this.cognito.signOut();
    window.location.href = '/login';
  }
}
