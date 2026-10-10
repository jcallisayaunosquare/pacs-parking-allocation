/**
 * The administrator's review, and the only writer of `corrected_plate`.
 *
 * Two things this use case is responsible for beyond applying a verdict:
 *
 *   - **The concurrency guard is the database's, not this code's.** `applyReview` updates
 *     `WHERE reviewed_at IS NULL`. If two administrators open the same doubtful read, the
 *     second one's update matches no row, the repository returns null and the caller gets
 *     409 with the screen reloading. Checking `reviewedAt` here first as well would read
 *     as the guard and would not be one - the window between the read and the write is
 *     exactly where the race lives.
 *   - **Every correction is a label.** `corrected_plate` is a human swearing what the
 *     plate was, against an image still in S3. After a couple of hundred of them the
 *     building has a real evaluation set, which is the number that decides whether the
 *     engine is good enough - and the reason the engine sits behind a port.
 */

import { fail } from '../../../shared/errors';
import { ok, type Result } from '../../../shared/result';
import type { Clock } from '../../../shared/clock';
import { resolveReview, type PlateReadWithDecision, type ReviewVerdict } from '../domain/plate-read';
import type { PlateReadRepository, VehicleLookup } from './ports';
import type { CachePort } from '../../allocation/application/ports';

export class ResolvePlateRead {
  constructor(
    private readonly reads: PlateReadRepository,
    private readonly register: VehicleLookup,
    private readonly clock: Clock,
    private readonly cache: CachePort,
  ) {}

  async execute(input: {
    plateReadId: string;
    reviewedBy: string | null;
    verdict: ReviewVerdict;
    idempotencyKey: string;
  }): Promise<Result<PlateReadWithDecision>> {
    /*
     * The idempotency key, replayed from the cache.
     *
     * A retried click must not produce a second access event - and unlike the draw, this
     * route has no natural uniqueness key to collapse onto, because a read may legitimately
     * be decided twice if a later administrator overturns the first verdict. So the key
     * does the work, for the same five minutes the draw uses.
     */
    const cacheKey = `plate-resolve:${input.idempotencyKey}`;
    const replayed = await this.cache.get<{ plateReadId: string }>(cacheKey);
    if (replayed && replayed.plateReadId === input.plateReadId) {
      const current = await this.reads.findDetail(input.plateReadId);
      if (current) return ok(current);
    }

    const read = await this.reads.findById(input.plateReadId);
    if (!read) return fail('NOT_FOUND', 'Plate read not found.');

    const register = await this.register.allActive();
    const resolved = resolveReview(read, input.verdict, register);
    if (!resolved.ok) return resolved;

    const at = this.clock.now();
    const applied = await this.reads.applyReview({
      plateReadId: read.id,
      reviewedBy: input.reviewedBy,
      reviewedAt: at,
      status: resolved.value.status,
      plate: resolved.value.plate,
      correctedPlate: resolved.value.correctedPlate,
      vehicleId: resolved.value.vehicleId,
      matchKind: resolved.value.matchKind,
      note: resolved.value.note,
      event:
        resolved.value.decision === null
          ? null
          : {
              plate: resolved.value.plate ?? '',
              vehicleId: resolved.value.vehicleId,
              residentId: resolved.value.residentId,
              spotId: resolved.value.spotId,
              decision: resolved.value.decision,
              reason: resolved.value.reason,
              cameraId: read.cameraId,
              occurredAt: read.capturedAt,
            },
    });

    if (applied === null) {
      return fail(
        'PLATE_READ_ALREADY_REVIEWED',
        'Another administrator reviewed this read first. Reload to see their decision.',
      );
    }

    await this.cache.set(cacheKey, { plateReadId: read.id }, 300);
    await this.cache.invalidate('plate-metrics');
    return ok(applied);
  }
}
