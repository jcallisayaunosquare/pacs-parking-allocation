import { describe, expect, it } from 'vitest';
import { normalizePlate } from '../../residents/domain/vehicle';
import {
  DEFAULT_BLOCKLIST,
  foldBlocklist,
  matchFormat,
  MIN_ACCEPTABLE_SCORE,
  PLATE_MAX_LENGTH,
  PLATE_MIN_LENGTH,
  scoreCandidate,
} from './bolivian-format';

/**
 * The plate detector, under test. Rekognition reads every string in the frame and has no
 * idea which one is a plate, so this scoring is what does the detecting - which is why it
 * is covered line by line rather than taken on trust.
 */
describe('matchFormat', () => {
  it('recognises the Bolivian series', () => {
    expect(matchFormat('1234ABC')?.name).toBe('UNICA_4_3');
    expect(matchFormat('123ABC')?.name).toBe('UNICA_3_3');
    expect(matchFormat('1234AB')?.name).toBe('MOTO');
    expect(matchFormat('ABC123')?.name).toBe('LEGACY_3_3');
    expect(matchFormat('1234ABC5')?.name).toBe('WITH_CHECK_DIGIT');
  });

  it('recognises nothing in a string that is not a plate', () => {
    expect(matchFormat('WHATEVER')).toBeNull();
    expect(matchFormat('AB12CD34')).toBeNull();
  });
});

describe('scoreCandidate', () => {
  it('ranks a plate in the current series above the same read in no series', () => {
    expect(scoreCandidate('1234ABC', 0.9)).toBeGreaterThan(scoreCandidate('AB12CD34', 0.9));
  });

  it('rejects a candidate with no digits, however confident the engine was', () => {
    // Every Bolivian series carries digits, so a string without one is a word.
    expect(scoreCandidate('ABCDEFG', 0.99)).toBeLessThan(MIN_ACCEPTABLE_SCORE);
  });

  it('penalises a candidate with no letters more gently', () => {
    // All digits is not a plate either, but it is a plausible mis-read of one with the
    // letters lost to glare, so it stays above the no-digit case.
    expect(scoreCandidate('12345678', 0.99)).toBeGreaterThan(scoreCandidate('ABCDEFG', 0.99));
  });

  it(`rejects anything outside ${PLATE_MIN_LENGTH}..${PLATE_MAX_LENGTH} characters`, () => {
    expect(scoreCandidate('1A2', 0.99)).toBeLessThan(0);
    expect(scoreCandidate('123456789', 0.99)).toBeLessThan(0);
  });

  it('scores a blocklisted scene word as impossible, not merely unlikely', () => {
    // "PARQUEO" canonicalises to PAR0UE0 (O folds to 0), which is what the list holds.
    expect(scoreCandidate(normalizePlate('PARQUEO'), 0.99)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('rises with the engine confidence, all else equal', () => {
    expect(scoreCandidate('1234ABC', 0.95)).toBeGreaterThan(scoreCandidate('1234ABC', 0.55));
  });
});

describe('the blocklist', () => {
  it('is folded through normalizePlate rather than written pre-folded', () => {
    // A hand-folded entry that got one glyph wrong is a silent hole in the list, so the
    // list is written as words and folded at load.
    expect(DEFAULT_BLOCKLIST).toContain(normalizePlate('VISITAS'));
    expect(DEFAULT_BLOCKLIST).toContain(normalizePlate('PARQUEO'));
    expect(DEFAULT_BLOCKLIST).not.toContain('VISITAS');
  });

  it('folds a multi-word place name into one canonical token', () => {
    expect(foldBlocklist(['Santa Cruz'])).toEqual([normalizePlate('SANTACRUZ')]);
  });

  it('drops an entry with no alphanumeric content at all', () => {
    expect(foldBlocklist(['---', '', 'STOP'])).toEqual([normalizePlate('STOP')]);
  });
});
