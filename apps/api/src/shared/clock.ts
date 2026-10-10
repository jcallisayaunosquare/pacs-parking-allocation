/**
 * Time and identity as ports. The domain never calls Date.now() or randomUUID()
 * directly, which is what lets the engine tests be fully deterministic (section 27).
 */
export interface Clock {
  now(): Date;
}

/** Bytes of entropy per run seed. 256 bits, which is what commit-reveal needs. */
export const SEED_BYTES = 32;

export interface SeedSource {
  /**
   * A fresh seed for a run, as lowercase hex. Stored on allocation_run.random_seed
   * (bytea) so the run can be replayed, and it is the first field of every raffle
   * token preimage, so a resident can recompute their own token (fairness ADR section 1.8).
   */
  next(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const fixedClock = (iso: string): Clock => {
  const at = new Date(iso);
  return { now: () => at };
};

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const cryptoSeedSource: SeedSource = {
  next: () => {
    // The whole 256 bits, never masked. The previous 52-bit mask was grindable on a
    // laptop in seconds, which made the published commitment theatre rather than a
    // guarantee (fairness ADR, defect D-1).
    const buf = new Uint8Array(SEED_BYTES);
    globalThis.crypto.getRandomValues(buf);
    return toHex(buf);
  },
};

export const fixedSeedSource = (seedHex: string): SeedSource => ({ next: () => seedHex });

/**
 * Serialises a date-only value as `YYYY-MM-DD`.
 *
 * `starts_on` and `ends_on` are `date` columns: a calendar day, with no time and no
 * zone. Sending them as a timestamp makes every client west of UTC render the day
 * before - a quarter beginning on 1 January showed as 31 December in GMT-4. The
 * contract calls these `format: date` for exactly this reason.
 */
export const toDateOnly = (d: Date): string => d.toISOString().slice(0, 10);
