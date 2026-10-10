import { describe, expect, it } from 'vitest';
import { normalizePlate } from '../../residents/domain/vehicle';
import { damerauLevenshtein, expandVariants, findFuzzyMatches } from './plate-fuzzy';

/**
 * The fuzzy tier. The register deliberately folds only O/Q/I, because folding more makes
 * two real plates collide in a unique index; everything riskier is considered here, where
 * a confidence score and a review queue stand behind the guess.
 */
describe('expandVariants', () => {
  it('makes one substitution at a time, not the power set', () => {
    const variants = expandVariants('1234A8C');
    expect(variants).toContain('1234A8C'); // the input itself is always first
    expect(variants).toContain('1234ABC'); // 8 -> B
    // Seven characters with several ambiguous ones: a handful of variants, never 2^7.
    expect(variants.length).toBeLessThan(20);
  });

  it('includes the all-ambiguous-letters-to-digits pass', () => {
    // A frame whose contrast is off reads the whole plate in the wrong glyph class, which
    // is a different failure from one dirty character.
    expect(expandVariants('SBZG')).toContain('5826');
  });

  it('never folds the three the register already folded', () => {
    // O, Q and I cannot reach this tier: normalizePlate collapsed them on both sides.
    const variants = expandVariants(normalizePlate('O1I2'));
    expect(variants.every((v) => !/[OQI]/.test(v))).toBe(true);
  });

  it('returns just the input when nothing in it is ambiguous', () => {
    // 1, 3 and 9 are the only digits in no confusable pair, so there is nothing to vary.
    expect(expandVariants('1399')).toEqual(['1399']);
  });
});

describe('damerauLevenshtein', () => {
  it('charges a transposition as one edit, which Levenshtein would call two', () => {
    // "1243ABC" for "1234ABC" is a common OCR error, and charging it as two would push a
    // genuine resident past a distance-1 threshold every time they drove in.
    expect(damerauLevenshtein('1243ABC', '1234ABC')).toBe(1);
  });

  it('measures the other three edits', () => {
    expect(damerauLevenshtein('1234ABC', '1234ABC')).toBe(0);
    expect(damerauLevenshtein('1234ABC', '1234AB')).toBe(1); // deletion
    expect(damerauLevenshtein('1234AB', '1234ABC')).toBe(1); // insertion
    expect(damerauLevenshtein('1234ABX', '1234ABC')).toBe(1); // substitution
  });

  it('respects the cap and stops early', () => {
    // Nothing above 2 is ever acted on, so computing a distance of 8 is wasted work.
    expect(damerauLevenshtein('AAAAAAAA', '99999999', 2)).toBeGreaterThan(2);
  });

  it('handles an empty side without special-casing at the call site', () => {
    expect(damerauLevenshtein('', '1234')).toBe(4);
    expect(damerauLevenshtein('1234', '')).toBe(4);
  });
});

describe('findFuzzyMatches', () => {
  it('returns every tie, nearest first', () => {
    // Returning all ties is the point: more than one match at the same distance is
    // ambiguity, and ambiguity must reach the decision table as ambiguity.
    const matches = findFuzzyMatches('1234ABC', ['1234ABD', '1234ABX', '9999ZZZ'], 1);
    expect(matches.map((m) => m.distance)).toEqual([1, 1]);
  });

  it('orders by distance before plate', () => {
    const matches = findFuzzyMatches('1234ABC', ['1234ABD', '1234AB'], 2);
    expect(matches[0]?.distance).toBeLessThanOrEqual(matches[1]?.distance ?? 99);
  });

  it('is empty when nothing is near enough', () => {
    expect(findFuzzyMatches('1234ABC', ['9999ZZZ'], 1)).toEqual([]);
  });
});
