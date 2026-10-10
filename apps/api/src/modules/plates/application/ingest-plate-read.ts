/**
 * The in-VPC half: a `PlateRecognized` event in, a `plate_read` row and - usually - an
 * `access_event` row out.
 *
 * This is where the decision actually happens, because this is the only side that can
 * reach the register. It calls the same pure `decide()` the recogniser logged a preview
 * with, so the two can never disagree about the rule; what differs is that here the
 * registered vehicles are real.
 *
 * Idempotency, in the order the three layers fire:
 *
 *   1. the recogniser's conditional write on `plateread#<captureId>` (upstream);
 *   2. `INSERT ... ON CONFLICT (capture_id) DO NOTHING` here, which is the one that
 *      matters - the DynamoDB stream delivers at least once, and a shard replay or a
 *      redeployed consumer both land on this statement;
 *   3. the business cooldown, which is not idempotency at all but dedupe: a car creeping
 *      towards the barrier is one arrival, and twenty log rows for it would make the
 *      access log unreadable. The frames are all kept; only the events are suppressed.
 */

import type { ScoredCandidate } from '../domain/plate-candidate';
import { decide, type Decision } from '../domain/access-decision';
import type { PlateRead } from '../domain/plate-read';
import type {
  AccessEventRepository,
  CooldownStore,
  PlateReadRepository,
  PlateRecognizedEvent,
  PlateThresholdProvider,
  VehicleLookup,
} from './ports';
import type { PlateLogger } from './recognize-capture';

export interface IngestConfig {
  readonly cooldownSeconds: number;
}

export type IngestOutcome =
  | { readonly kind: 'applied'; readonly read: PlateRead; readonly decision: Decision }
  | { readonly kind: 'duplicate'; readonly captureId: string }
  | { readonly kind: 'malformed'; readonly detail: string };

export class IngestPlateRead {
  constructor(
    private readonly reads: PlateReadRepository,
    private readonly events: AccessEventRepository,
    private readonly register: VehicleLookup,
    private readonly cooldown: CooldownStore,
    private readonly thresholds: PlateThresholdProvider,
    private readonly logger: PlateLogger,
    private readonly config: IngestConfig,
  ) {}

  async apply(event: PlateRecognizedEvent): Promise<IngestOutcome> {
    if (!event.captureId || !event.cameraId || !event.objectKey) {
      return { kind: 'malformed', detail: 'captureId, cameraId and objectKey are required' };
    }

    const candidates: ScoredCandidate[] = (event.candidates ?? []).map((c) => ({
      plate: c.plate,
      raw: c.raw,
      confidence: c.confidence,
      score: c.score,
      box: c.box,
    }));
    const best = candidates[0] ?? null;

    /*
     * The register is read before the cooldown is consulted, not after.
     *
     * The cooldown is keyed on the plate, and the plate the cooldown should be keyed on is
     * the one the match resolves to - not the raw read. Otherwise a car whose plate is
     * read as "1234ABC" on one frame and "1234A8C" on the next escapes its own cooldown
     * and writes two entries for one arrival, which is exactly the problem the cooldown
     * exists to prevent.
     */
    const registered = best === null ? [] : await this.register.candidatesFor(best.plate);
    const thresholds = await this.thresholds.current();

    const provisional = decide({
      best,
      quality: event.quality,
      registered,
      withinCooldown: false,
      thresholds,
    });

    const cooldownKey = provisional.plate ?? best?.plate ?? null;
    const withinCooldown =
      cooldownKey === null ? false : await this.cooldown.check(event.cameraId, cooldownKey);

    const decision = withinCooldown
      ? decide({ best, quality: event.quality, registered, withinCooldown: true, thresholds })
      : provisional;

    const read = await this.reads.insertIfAbsent({
      captureId: event.captureId,
      cameraId: event.cameraId,
      capturedAt: new Date(event.capturedAt),
      rawText: best?.raw ?? null,
      plate: decision.plate,
      // The stored confidence is the engine's, not the fused value: the fused number is
      // derived from these two and is recomputed on read, so storing it would create a
      // third copy that can disagree with its own inputs after a recalibration.
      confidence: best?.confidence ?? 0,
      quality: event.quality,
      status: decision.status,
      vehicleId: decision.vehicleId,
      matchKind: decision.matchKind,
      matchDistance: decision.matchDistance,
      candidates,
      imageKey: event.objectKey,
      cropKey: null,
      engine: event.engine,
      engineVersion: event.engineVersion,
      latencyMs: event.latencyMs,
    });

    if (read === null) {
      this.logger.info('capture already applied', { captureId: event.captureId });
      return { kind: 'duplicate', captureId: event.captureId };
    }

    if (decision.decision !== null) {
      await this.events.insert(read.id, {
        plate: decision.plate ?? best?.plate ?? '',
        vehicleId: decision.vehicleId,
        residentId: decision.residentId,
        spotId: decision.spotId,
        decision: decision.decision,
        reason: decision.reason,
        cameraId: event.cameraId,
        occurredAt: new Date(event.capturedAt),
      });
    }

    // Marked after the write, and only for a read that produced an event: marking a
    // discarded frame would extend its own window indefinitely while a car idles at the
    // barrier, and the second real arrival would then be swallowed too.
    if (cooldownKey !== null && !withinCooldown && decision.decision !== null) {
      await this.cooldown.mark(event.cameraId, cooldownKey, this.config.cooldownSeconds);
    }

    this.logger.info('plate read applied', {
      captureId: event.captureId,
      plateReadId: read.id,
      plate: decision.plate,
      status: decision.status,
      decision: decision.decision,
      reason: decision.reason,
      fused: decision.fused,
      matchKind: decision.matchKind,
      matchDistance: decision.matchDistance,
    });

    return { kind: 'applied', read, decision };
  }
}

/**
 * Pulls a `PlateRecognized` event out of an unmarshalled DynamoDB stream image.
 *
 * Lives in the application ring rather than the handler because it is the event
 * contract's shape, and the contract is the module's, not the runtime's. The handler
 * stays a few lines of AWS plumbing.
 */
export function parsePlateRecognized(item: unknown): PlateRecognizedEvent | null {
  if (typeof item !== 'object' || item === null) return null;
  const o = item as Record<string, unknown>;
  if (o.type !== 'PlateRecognized') return null;
  if (typeof o.captureId !== 'string' || typeof o.cameraId !== 'string') return null;
  if (typeof o.objectKey !== 'string') return null;

  const asNumber = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return {
    captureId: o.captureId,
    cameraId: o.cameraId,
    capturedAt:
      typeof o.capturedAt === 'string' ? o.capturedAt : new Date().toISOString(),
    objectKey: o.objectKey,
    candidates: Array.isArray(o.candidates)
      ? o.candidates.flatMap((c) => {
          if (typeof c !== 'object' || c === null) return [];
          const r = c as Record<string, unknown>;
          if (typeof r.plate !== 'string') return [];
          return [
            {
              plate: r.plate,
              raw: typeof r.raw === 'string' ? r.raw : r.plate,
              confidence: asNumber(r.confidence) ?? 0,
              score: asNumber(r.score) ?? 0,
              box: (r.box ?? undefined) as PlateRecognizedEvent['candidates'][number]['box'],
            },
          ];
        })
      : [],
    best:
      typeof o.best === 'object' && o.best !== null
        ? {
            plate: String((o.best as Record<string, unknown>).plate ?? ''),
            confidence: asNumber((o.best as Record<string, unknown>).confidence) ?? 0,
          }
        : null,
    quality: asNumber(o.quality),
    engine: typeof o.engine === 'string' ? o.engine : 'unknown',
    engineVersion: typeof o.engineVersion === 'string' ? o.engineVersion : null,
    latencyMs: asNumber(o.latencyMs) ?? 0,
  };
}
