import {
  computed,
  effect,
  type EffectRef,
  type Injector,
  type ResourceRef,
  type Signal,
} from '@angular/core';
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

/**
 * Reload resources and resolve once every one of them has finished - with data or with
 * an error, either way.
 *
 * A write is not over when the server accepts it; it is over when the screen shows it.
 * The mutations used to fire `reload()` and return, so the dialog that started the write
 * closed on the old table and the reload's own loader appeared a moment later, under the
 * place the form had been. Awaiting this inside the mutation keeps the pressed button in
 * its pending state, and the form locked, until the row is actually on the table - and
 * the dialog then closes onto a table that is already right.
 *
 * Never rejects: a failed reload is the resource's own error state, which the screen
 * already renders. The write itself succeeded, and that is what the caller is told.
 */
export function reloaded(
  injector: Injector,
  ...resources: ResourceRef<unknown>[]
): Promise<void> {
  for (const r of resources) r.reload();
  return new Promise<void>((resolve) => {
    let done = false;
    const watch: EffectRef = effect(
      () => {
        if (done || resources.some((r) => r.isLoading())) return;
        done = true;
        resolve();
        // Destroyed on the next tick rather than here: the reference is only safe to read
        // once effect() has returned and assigned it.
        queueMicrotask(() => watch.destroy());
      },
      { injector, manualCleanup: true },
    );
  });
}

/** The error of a resource, as the domain's shape, or null. */
export function resourceError<T>(res: ResourceRef<T | undefined>): Signal<ApiError | null> {
  return computed(() => (res.status() === 'error' ? toApiError(res.error()) : null));
}
