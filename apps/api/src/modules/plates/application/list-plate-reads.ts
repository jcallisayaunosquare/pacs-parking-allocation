/**
 * Reads: the gate log, the review queue, one read's detail, the access log, a resident's
 * own entries, and the metrics behind the calibration decision.
 *
 * Two policies live here rather than in the HTTP adapter, because they are rules rather
 * than transport:
 *
 *   - **Presigned URLs are minted only on the detail route, and only for five minutes.**
 *     The API never serves an image. A list of fifty rows does not sign fifty URLs either:
 *     signing is cheap but a log page carrying fifty five-minute credentials to a frame of
 *     somebody's car is a worse artefact than one extra request.
 *   - **A resident's own entries come from the token's resident id, never a parameter.**
 *     Same rule as the rest of the resident surface.
 */

import { fail } from '../../../shared/errors';
import { ok, type Result } from '../../../shared/result';
import type { Clock } from '../../../shared/clock';
import { fuseConfidence } from '../domain/plate-candidate';
import { findFuzzyMatches } from '../domain/plate-fuzzy';
import type { PlateReadWithDecision } from '../domain/plate-read';
import type { RegisteredVehicle } from '../domain/access-decision';
import type { CachePort } from '../../allocation/application/ports';
import type {
  AccessEventListQuery,
  AccessEventPage,
  AccessEventRow,
  CaptureStorage,
  PlateMetrics,
  PlateReadListQuery,
  PlateReadPage,
  PlateReadRepository,
  AccessEventRepository,
  VehicleLookup,
} from './ports';

/** How long a review-screen image URL is good for. Long enough to look, not to share. */
export const IMAGE_URL_TTL_SECONDS = 300;

/** The window the plate metrics are computed over. */
export const METRICS_WINDOW_DAYS = 30;
const METRICS_TTL_SECONDS = 600;

/** A nearby registered plate, offered to the reviewer as a one-click answer. */
export interface NearbyPlate {
  readonly vehicleId: string;
  readonly plate: string;
  readonly residentId: string;
  readonly distance: number;
}

export interface PlateReadDetail extends PlateReadWithDecision {
  readonly fused: number;
  readonly imageUrl: string | null;
  readonly cropUrl: string | null;
  /**
   * Active registrations within two edits of the read, nearest first.
   *
   * Offered because an administrator looking at a frame usually recognises the car before
   * they can read the plate, and the fastest correct answer is the one they can point at.
   */
  readonly nearby: readonly NearbyPlate[];
}

export class PlateReadQueries {
  constructor(
    private readonly reads: PlateReadRepository,
    private readonly events: AccessEventRepository,
    private readonly register: VehicleLookup,
    private readonly storage: CaptureStorage,
    private readonly cache: CachePort,
    private readonly clock: Clock,
    private readonly bucket: string | null,
  ) {}

  async list(query: PlateReadListQuery): Promise<Result<PlateReadPage>> {
    return ok(await this.reads.list(query));
  }

  /** The review queue: oldest first, because a doubtful read ages badly. */
  async reviewQueue(limit: number): Promise<Result<PlateReadPage>> {
    return ok(await this.reads.list({ limit, needsReview: true }));
  }

  async detail(id: string): Promise<Result<PlateReadDetail>> {
    const found = await this.reads.findDetail(id);
    if (!found) return fail('NOT_FOUND', 'Plate read not found.');

    const read = found.read;
    const [imageUrl, cropUrl] = await Promise.all([
      this.sign(read.imageKey),
      read.cropKey === null ? Promise.resolve(null) : this.sign(read.cropKey),
    ]);

    const nearby =
      read.plate === null ? [] : await this.nearbyPlates(read.plate);

    return ok({
      ...found,
      fused: fuseConfidence(read.confidence, read.quality),
      imageUrl,
      cropUrl,
      nearby,
    });
  }

  async accessEvents(query: AccessEventListQuery): Promise<Result<AccessEventPage>> {
    return ok(await this.events.list(query));
  }

  async ownAccessEvents(
    residentId: string,
    limit: number,
  ): Promise<Result<readonly AccessEventRow[]>> {
    return ok(await this.events.listForResident(residentId, limit));
  }

  /**
   * The numbers section 8's calibration is argued from: match rate, queue depth and age,
   * the mean fused confidence, and how many corrections exist - which is the size of the
   * evaluation set.
   *
   * Cached for ten minutes, like the fairness dashboard: it is read by one screen and
   * aggregates the whole window.
   */
  async metrics(): Promise<Result<PlateMetrics & { windowDays: number }>> {
    const key = 'plate-metrics:30d';
    const hit = await this.cache.get<PlateMetrics>(key);
    if (hit) return ok({ ...hit, windowDays: METRICS_WINDOW_DAYS });

    const since = new Date(
      this.clock.now().getTime() - METRICS_WINDOW_DAYS * 24 * 3600 * 1000,
    );
    const value = await this.reads.metrics(since);
    await this.cache.set(key, value, METRICS_TTL_SECONDS);
    return ok({ ...value, windowDays: METRICS_WINDOW_DAYS });
  }

  private async nearbyPlates(plate: string): Promise<readonly NearbyPlate[]> {
    const active = await this.register.allActive();
    const byPlate = new Map<string, RegisteredVehicle>(active.map((v) => [v.plate, v]));
    return findFuzzyMatches(
      plate,
      active.map((v) => v.plate),
      2,
    )
      .flatMap((m) => {
        const v = byPlate.get(m.plate);
        return v === undefined
          ? []
          : [{ vehicleId: v.vehicleId, plate: v.plate, residentId: v.residentId, distance: m.distance }];
      })
      .slice(0, 5);
  }

  /** Null rather than a throw when no bucket is configured: the log still reads. */
  private async sign(key: string): Promise<string | null> {
    if (this.bucket === null) return null;
    try {
      return await this.storage.presignDownload({
        bucket: this.bucket,
        key,
        expiresInSeconds: IMAGE_URL_TTL_SECONDS,
      });
    } catch {
      return null;
    }
  }
}
