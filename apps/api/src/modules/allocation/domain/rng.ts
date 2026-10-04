/**
 * Seeded RNG for the draw (§12).
 *
 * xorshift128 over four uint32 words. Chosen over Math.random() for the only reason
 * that matters here: a run must be replayable from the seed stored on allocation_run,
 * so a resident can be shown exactly why they lost. All arithmetic is 32-bit integer
 * (`| 0`, `>>> 0`), so the sequence is identical on every runtime and architecture —
 * no floating-point rounding anywhere in the state transition.
 */
export interface Rng {
  /** Uniform uint32 in [0, 2^32). */
  nextUint32(): number;
  /** Uniform integer in [0, maxExclusive), unbiased by rejection sampling. */
  nextInt(maxExclusive: number): number;
}

/** Expands a single seed into four non-zero state words. */
function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = (t ^ (t >>> 16)) >>> 0;
    t = Math.imul(t, 0x21f0aaad) >>> 0;
    t = (t ^ (t >>> 15)) >>> 0;
    t = Math.imul(t, 0x735a2d97) >>> 0;
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export function seededRng(seed: bigint | number): Rng {
  const asBig = typeof seed === 'bigint' ? seed : BigInt(Math.trunc(seed));
  // Fold the full seed into two 32-bit halves so high bits are not discarded.
  const lo = Number(asBig & 0xffff_ffffn) >>> 0;
  const hi = Number((asBig >> 32n) & 0xffff_ffffn) >>> 0;

  const mix = splitmix32((lo ^ hi) >>> 0);
  let x = mix() || 1;
  let y = mix() || 2;
  let z = mix() || 3;
  let w = (mix() ^ lo ^ hi) >>> 0 || 4;

  const nextUint32 = (): number => {
    let t = x ^ ((x << 11) >>> 0);
    t = t >>> 0;
    x = y;
    y = z;
    z = w;
    w = (w ^ (w >>> 19)) >>> 0;
    w = (w ^ t ^ (t >>> 8)) >>> 0;
    return w >>> 0;
  };

  return {
    nextUint32,
    nextInt(maxExclusive: number): number {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError(`nextInt needs a positive integer bound, got ${maxExclusive}`);
      }
      if (maxExclusive === 1) return 0;
      // Rejection sampling: discard the tail that would make low values
      // marginally more likely. Without this the draw carries a small bias,
      // and "the raffle is fair" stops being defensible.
      const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
      let v = nextUint32();
      while (v >= limit) v = nextUint32();
      return v % maxExclusive;
    },
  };
}
