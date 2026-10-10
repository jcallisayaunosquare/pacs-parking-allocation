import type { Kysely } from 'kysely';
import type { Database } from '../../../shared/db/schema';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../domain/access-decision';
import type { PlateThresholdProvider } from '../application/ports';

/**
 * Where the thresholds come from, and in what order of authority.
 *
 *   1. the newest `plate_config` row - what a calibration wrote;
 *   2. the environment variables, which are the deploy's defaults;
 *   3. `DEFAULT_THRESHOLDS`, which is the code's.
 *
 * The database wins because section 8 of MODULO-PLACAS.md is a measurement procedure
 * whose result is an INSERT: moving 0.85 after a week of shadow operation must not need a
 * deploy, or it will not be done.
 *
 * Cached in the container for a minute rather than per request. A recalibration is an
 * event that happens a handful of times in the system's life, and reading a one-row
 * table on every stream record would add a round trip to the hot path for a value that
 * does not move. A minute is also short enough that the operator who ran the UPDATE sees
 * it take effect while they are still watching.
 */
const TTL_MS = 60_000;

export class KyselyPlateThresholdProvider implements PlateThresholdProvider {
  private cached: { value: Thresholds; at: number } | null = null;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly fallback: Thresholds = DEFAULT_THRESHOLDS,
  ) {}

  async current(): Promise<Thresholds> {
    if (this.cached !== null && Date.now() - this.cached.at < TTL_MS) {
      return this.cached.value;
    }

    let value = this.fallback;
    try {
      const row = await this.db
        .selectFrom('plate_config')
        .select(['min_fused', 'review_fused', 'max_fuzzy_distance'])
        .orderBy('version', 'desc')
        .limit(1)
        .executeTakeFirst();

      if (row) {
        value = {
          // numeric(5,4) arrives as a string over the wire; coerced once, here.
          minFused: Number(row.min_fused),
          reviewFused: Number(row.review_fused),
          maxFuzzyDistance: Number(row.max_fuzzy_distance),
        };
      }
    } catch {
      // A missing or unreadable config table must not stop the gate recording entries.
      // Falling back to the deploy's defaults keeps the pipeline running and the reads
      // auditable; the alternative is losing captures over a configuration lookup.
      value = this.fallback;
    }

    this.cached = { value, at: Date.now() };
    return value;
  }
}

/** The environment-variable defaults, read once by the composition root. */
export function thresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): Thresholds {
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    minFused: num('PLATES_MIN_FUSED', DEFAULT_THRESHOLDS.minFused),
    reviewFused: num('PLATES_REVIEW_FUSED', DEFAULT_THRESHOLDS.reviewFused),
    maxFuzzyDistance: num('PLATES_MAX_FUZZY_DISTANCE', DEFAULT_THRESHOLDS.maxFuzzyDistance),
  };
}

/** A provider with no database behind it, for the recogniser outside the VPC. */
export class StaticPlateThresholdProvider implements PlateThresholdProvider {
  constructor(private readonly value: Thresholds) {}
  async current(): Promise<Thresholds> {
    return this.value;
  }
}
