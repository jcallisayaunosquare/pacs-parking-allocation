import { randomBytes } from 'node:crypto';
import type { CaptureIdSource } from '../application/ports';

/**
 * ULIDs, without a dependency.
 *
 * A ULID rather than a UUID because the id is also the last segment of the S3 key, and a
 * ULID sorts lexicographically by the instant it was minted: a prefix listing of a day's
 * captures comes back in arrival order with no index and no metadata read. A v4 UUID
 * would give the same uniqueness and scatter the order, so recovering the sequence of a
 * morning's frames would mean a HeadObject per key.
 *
 * 48 bits of timestamp in milliseconds plus 80 bits of entropy, in Crockford's base32 -
 * the format's own alphabet, which excludes I, L, O and U so a human reading an id off a
 * log cannot confuse it with a digit. `crypto.randomBytes`, not `Math.random`: the id is
 * a public identifier that appears in a URL, and a guessable one lets somebody enumerate
 * other buildings' captures.
 *
 * Not monotonic within a millisecond, which the ULID specification allows as the simpler
 * variant: two captures minted in the same millisecond may sort either way between
 * themselves. Nothing here depends on sub-millisecond ordering - the frames of one car
 * are hundreds of milliseconds apart - and the alternative is per-container state that is
 * wrong across containers anyway.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const encode = (value: number, length: number): string => {
  let out = '';
  let v = value;
  for (let i = 0; i < length; i += 1) {
    out = (ALPHABET[v % 32] as string) + out;
    v = Math.floor(v / 32);
  }
  return out;
};

export class UlidCaptureIdSource implements CaptureIdSource {
  next(at: Date): string {
    const time = encode(at.getTime(), 10);
    const bytes = randomBytes(10);
    let random = '';
    // 80 bits in 16 base32 characters: five bits at a time, taken across byte boundaries.
    let acc = 0;
    let bits = 0;
    for (const b of bytes) {
      acc = (acc << 8) | b;
      bits += 8;
      while (bits >= 5) {
        random += ALPHABET[(acc >>> (bits - 5)) & 31] as string;
        bits -= 5;
      }
    }
    return time + random;
  }
}

/** Fixed ids for tests, so a key and a partition key can be asserted literally. */
export const fixedCaptureIdSource = (id: string): CaptureIdSource => ({ next: () => id });
