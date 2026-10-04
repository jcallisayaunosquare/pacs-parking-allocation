import { computed, type ResourceRef, type Signal } from '@angular/core';
import type { ApiError, ViewState } from '../domain/models';
import { toApiError } from '../core/http/api-error';

/**
 * Turns a `resource()` into the five states §17 requires every screen to handle.
 *
 * The one worth spelling out is `stale`: while a resource is reloading it keeps the
 * previous value, so the page renders the old data dimmed instead of flashing a
 * skeleton on every focus. That is the stale-while-revalidate behaviour of §17, and it
 * comes free from `resource` — the trick is not throwing it away by checking
 * `isLoading()` and showing a spinner.
 */
export function viewState<T>(
  res: ResourceRef<T | undefined>,
  isEmpty: (value: T) => boolean = () => false,
): Signal<ViewState> {
  return computed<ViewState>(() => {
    const status = res.status();
    const value = res.value();

    if (status === 'error') {
      const error = toApiError(res.error());
      return error.status === 403 ? { kind: 'forbidden' } : { kind: 'error', error };
    }

    // No value yet: a genuine first load.
    if (value === undefined) {
      return status === 'loading' || status === 'idle' ? { kind: 'loading' } : { kind: 'loading' };
    }

    if (isEmpty(value)) return { kind: 'empty' };

    return { kind: 'ready', stale: status === 'reloading' };
  });
}

/** The error of a resource, as the domain's shape, or null. */
export function resourceError<T>(res: ResourceRef<T | undefined>): Signal<ApiError | null> {
  return computed(() => (res.status() === 'error' ? toApiError(res.error()) : null));
}
