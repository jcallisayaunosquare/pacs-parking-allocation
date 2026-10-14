import { describe, expect, it } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { of } from 'rxjs';
import type { ApiError } from '../../domain/models';
import { ToastService, toastFacadeErrors } from './toast';

/**
 * The stack's rules: notices pile up rather than replace each other, the pile is capped
 * so it cannot bury the page, a dismissed one goes, and a facade's refusal arrives as a
 * toast exactly once.
 */
describe('ToastService', () => {
  it('stacks notices in arrival order', () => {
    const toasts = TestBed.inject(ToastService);
    toasts.error('first');
    toasts.error('second');
    expect(toasts.toasts().map((t) => t.message)).toEqual(['first', 'second']);
  });

  it('keeps at most four, dropping the oldest', () => {
    const toasts = TestBed.inject(ToastService);
    for (const m of ['a', 'b', 'c', 'd', 'e']) toasts.info(m);
    expect(toasts.toasts().map((t) => t.message)).toEqual(['b', 'c', 'd', 'e']);
  });

  it('removes a dismissed notice and only that one', () => {
    const toasts = TestBed.inject(ToastService);
    toasts.error('keep');
    toasts.error('drop');
    const drop = toasts.toasts()[1]!;
    toasts.dismiss(drop.id);
    expect(toasts.toasts().map((t) => t.message)).toEqual(['keep']);
  });
});

describe('toastFacadeErrors', () => {
  const refusal: ApiError = {
    status: 409,
    code: 'INVALID_CYCLE_STATE',
    message: 'This period has handed out 1 bay.',
    traceId: 'd3dca8e4',
  } as ApiError;

  const setup = () => {
    const error = signal<ApiError | null>(null);
    const facade = { error: error.asReadonly(), dismissError: () => error.set(null) };

    @Component({ template: '' })
    class Host {
      readonly ref = toastFacadeErrors(facade);
    }

    TestBed.configureTestingModule({
      providers: [
        {
          provide: MatDialog,
          useValue: { afterOpened: of(), openDialogs: [] },
        },
      ],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return { error, fixture, toasts: TestBed.inject(ToastService) };
  };

  it('turns a refusal into one toast, with its reference, and clears the facade', () => {
    const { error, fixture, toasts } = setup();
    error.set(refusal);
    fixture.detectChanges();
    TestBed.tick();
    expect(toasts.toasts()).toHaveLength(1);
    expect(toasts.toasts()[0]).toMatchObject({
      tone: 'error',
      message: 'This period has handed out 1 bay.',
      reference: 'd3dca8e4',
    });
    expect(error()).toBeNull();

    TestBed.tick();
    expect(toasts.toasts()).toHaveLength(1);
  });
});
