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

    /*
     * The error branch has to come first, and `value()` must not be touched before it.
     * A resource in an error state throws `ResourceValueError` from `value()` rather
     * than returning undefined, so reading it up front threw out of this computed and
     * the error state below was never reached - every failing screen in the product sat
     * on its loading skeleton for ever, with no message, no trace id and no retry. The
     * symptom looked like a feature that had not been built.
     */
    if (status === 'error') {
      const error = toApiError(res.error());
      return error.status === 403 ? { kind: 'forbidden' } : { kind: 'error', error };
    }

    const value = res.value();

    // No value yet: a genuine first load.
    if (value === undefined) return { kind: 'loading' };

    if (isEmpty(value)) return { kind: 'empty' };

    return { kind: 'ready', stale: status === 'reloading' };
  });
}

/**
 * A resource's value, or undefined when there is not one.
 *
 * `ResourceRef.value()` throws `ResourceValueError` while the resource is in an error
 * state, which means the ubiquitous `res.value() ?? []` does not mean what it reads as:
 * the `??` never runs, the computed throws, and whatever was deriving from it dies with
 * it. Every read of a resource's value in this application goes through here, so that
 * idiom is true.
 */
export function peek<T>(res: ResourceRef<T | undefined>): T | undefined {
  return res.status() === 'error' ? undefined : res.value();
}

/** The error of a resource, as the domain's shape, or null. */
export function resourceError<T>(res: ResourceRef<T | undefined>): Signal<ApiError | null> {
  return computed(() => (res.status() === 'error' ? toApiError(res.error()) : null));
}
