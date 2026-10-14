import { describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, maxLength, required } from '@angular/forms/signals';
import { DOTTED_DOMAIN, NOT_BLANK, PLATE_CHARACTER, fieldError } from './limits';

/**
 * The shared rules every form leans on. DOTTED_DOMAIN in particular exists to make the
 * client refuse what the server's zod `.email()` refuses; if it drifted looser the 400
 * would be back, tighter and valid addresses would be turned away.
 */
describe('form limits', () => {
  it('accepts an ordinary address and refuses the ones the server refuses', () => {
    expect(DOTTED_DOMAIN.test('ana.quispe@example.com')).toBe(true);
    expect(DOTTED_DOMAIN.test('ana+parking@mail.example.bo')).toBe(true);
    expect(DOTTED_DOMAIN.test('ana@building')).toBe(false);
    expect(DOTTED_DOMAIN.test('ana quispe@example.com')).toBe(false);
    expect(DOTTED_DOMAIN.test('ana@example.c')).toBe(false);
    expect(DOTTED_DOMAIN.test('@example.com')).toBe(false);
  });

  it('treats a string of spaces as blank', () => {
    expect(NOT_BLANK.test('   ')).toBe(false);
    expect(NOT_BLANK.test(' 4B ')).toBe(true);
  });

  it('wants a letter or digit in a plate', () => {
    expect(PLATE_CHARACTER.test('--  -')).toBe(false);
    expect(PLATE_CHARACTER.test('1234-ABC')).toBe(true);
  });

  it('stays quiet until a field is touched, then gives the first message', () => {
    const model = signal({ name: '' });
    const f = TestBed.runInInjectionContext(() =>
      form(model, (p) => {
        required(p.name, { message: 'Enter a name.' });
        maxLength(p.name, 3, { message: 'Too long.' });
      }),
    );
    expect(fieldError(f.name)).toBeNull();
    f.name().markAsTouched();
    expect(fieldError(f.name)).toBe('Enter a name.');
    model.set({ name: 'abcd' });
    expect(fieldError(f.name)).toBe('Too long.');
    model.set({ name: 'abc' });
    expect(fieldError(f.name)).toBeNull();
  });
});
