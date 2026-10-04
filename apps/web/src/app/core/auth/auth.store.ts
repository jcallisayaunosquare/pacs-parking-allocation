import { Injectable, computed, inject, signal } from '@angular/core';
import { OidcSecurityService } from 'angular-auth-oidc-client';
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
  private readonly oidc = inject(OidcSecurityService);
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
  readonly displayName = computed(
    () => this._principal()?.resident?.fullName ?? this._principal()?.email ?? '',
  );
  /** An admin with no resident row has no dashboard to show. */
  readonly hasResidentRecord = computed(() => this._principal()?.resident != null);

  /** Called once at startup by the app initializer. */
  async restore(): Promise<void> {
    try {
      const result = await firstValueFrom(this.oidc.checkAuth());
      this._authenticated.set(result.isAuthenticated);
      if (result.isAuthenticated) await this.loadPrincipal();
    } catch {
      this._authenticated.set(false);
    } finally {
      this._checked.set(true);
    }
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

  login(): void {
    this.oidc.authorize();
  }

  logout(): void {
    // Drop local state first, so a failed redirect cannot leave a half-signed-in UI.
    this._principal.set(null);
    this._principalError.set(null);
    this._authenticated.set(false);
    this.oidc.logoffLocal();
    window.location.href = cognitoLogoutUrl();
  }
}
