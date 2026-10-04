/**
 * Time and identity as ports. The domain never calls Date.now() or randomUUID()
 * directly, which is what lets the engine tests be fully deterministic (§27).
 */
export interface Clock {
  now(): Date;
}

export interface SeedSource {
  /** A fresh seed for a run. Stored on allocation_run so the draw can be replayed (§12). */
  next(): bigint;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const fixedClock = (iso: string): Clock => {
  const at = new Date(iso);
  return { now: () => at };
};

export const cryptoSeedSource: SeedSource = {
  next: () => {
    // 52 bits keeps the value exactly representable as a JS number on the way out,
    // while still being far larger than the number of runs this system will ever do.
    const buf = new Uint8Array(8);
    globalThis.crypto.getRandomValues(buf);
    let v = 0n;
    for (const b of buf) v = (v << 8n) | BigInt(b);
    return v & 0x000f_ffff_ffff_ffffn;
  },
};

export const fixedSeedSource = (seed: bigint): SeedSource => ({ next: () => seed });
