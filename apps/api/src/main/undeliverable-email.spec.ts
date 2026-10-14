import { describe, expect, it } from 'vitest';
import { isUndeliverable } from './undeliverable-email';

describe('isUndeliverable', () => {
  it.each([
    'smoke-resident-1791974192251@example.test',
    'someone@EXAMPLE.TEST',
    'a@b.example',
    'a@nowhere.invalid',
    'a@localhost',
    'a@example.com',
    'a@mail.example.org',
  ])('treats %s as reserved', (email) => {
    expect(isUndeliverable(email)).toBe(true);
  });

  it.each(['resident@gmail.com', 'a@notexample.com', 'a@example.co', 'a@testing.io'])(
    'invites %s',
    (email) => {
      expect(isUndeliverable(email)).toBe(false);
    },
  );
});
