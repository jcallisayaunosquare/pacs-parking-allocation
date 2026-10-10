import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../../shared/clock';
import type { RegisteredVehicle, Thresholds } from '../domain/access-decision';
import { DEFAULT_THRESHOLDS } from '../domain/access-decision';
import type { PlateRead, PlateReadWithDecision } from '../domain/plate-read';
import { InMemoryCooldownStore } from '../infrastructure/dynamo-cooldown.store';
import { IngestPlateRead, parsePlateRecognized } from './ingest-plate-read';
import type {
  AccessEventInsert,
  AccessEventListQuery,
  AccessEventPage,
  AccessEventRepository,
  AccessEventRow,
  PlateMetrics,
  PlateReadInsert,
  PlateReadListQuery,
  PlateReadPage,
  PlateReadRepository,
  PlateRecognizedEvent,
  PlateThresholdProvider,
  VehicleLookup,
} from './ports';
import type { PlateLogger } from './recognize-capture';
import type { AccessEvent } from '../domain/plate-read';

/**
 * The use case, against fakes. No database, no AWS - which is the point of the ports:
 * idempotency and the cooldown are behaviours of this code, and they are asserted here
 * rather than inferred from a deployed log.
 */
const silentLogger: PlateLogger = { info: () => {}, warn: () => {}, error: () => {} };

const CLOCK = fixedClock('2026-10-09T14:03:11Z');

class FakeReads implements PlateReadRepository {
  readonly rows = new Map<string, PlateRead>();
  private seq = 0;

  async insertIfAbsent(input: PlateReadInsert): Promise<PlateRead | null> {
    // The UNIQUE on capture_id, in a Map. Returning null is what the real
    // `ON CONFLICT DO NOTHING` returns, and it is what makes a stream replay a no-op.
    for (const r of this.rows.values()) if (r.captureId === input.captureId) return null;
    this.seq += 1;
    const row: PlateRead = {
      id: `pr-${this.seq}`,
      captureId: input.captureId,
      cameraId: input.cameraId,
      capturedAt: input.capturedAt,
      receivedAt: CLOCK.now(),
      rawText: input.rawText,
      plate: input.plate,
      confidence: input.confidence,
      quality: input.quality,
      fused: input.confidence,
      status: input.status,
      vehicleId: input.vehicleId,
      matchKind: input.matchKind,
      matchDistance: input.matchDistance,
      candidates: input.candidates,
      imageKey: input.imageKey,
      cropKey: input.cropKey,
      engine: input.engine,
      engineVersion: input.engineVersion,
      latencyMs: input.latencyMs,
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      correctedPlate: null,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async findById(id: string): Promise<PlateRead | null> {
    return this.rows.get(id) ?? null;
  }
  async findByCaptureId(captureId: string): Promise<PlateRead | null> {
    return [...this.rows.values()].find((r) => r.captureId === captureId) ?? null;
  }
  async list(_query: PlateReadListQuery): Promise<PlateReadPage> {
    return { items: [], nextCursor: null };
  }
  async findDetail(_id: string): Promise<PlateReadWithDecision | null> {
    return null;
  }
  async applyReview(): Promise<PlateReadWithDecision | null> {
    return null;
  }
  async metrics(_since: Date): Promise<PlateMetrics> {
    throw new Error('not used');
  }
}

class FakeEvents implements AccessEventRepository {
  readonly written: { plateReadId: string; input: AccessEventInsert }[] = [];

  async insert(plateReadId: string, input: AccessEventInsert): Promise<AccessEvent> {
    this.written.push({ plateReadId, input });
    return {
      id: `ae-${this.written.length}`,
      plateReadId,
      plate: input.plate,
      vehicleId: input.vehicleId,
      residentId: input.residentId,
      spotId: input.spotId,
      decision: input.decision,
      reason: input.reason,
      cameraId: input.cameraId,
      occurredAt: input.occurredAt,
      createdAt: CLOCK.now(),
      supersededBy: null,
    };
  }
  async list(_q: AccessEventListQuery): Promise<AccessEventPage> {
    return { items: [], nextCursor: null };
  }
  async listForResident(): Promise<readonly AccessEventRow[]> {
    return [];
  }
}

const register = (vehicles: readonly RegisteredVehicle[]): VehicleLookup => ({
  async candidatesFor(plate) {
    return vehicles.filter(
      (v) => v.plate === plate || Math.abs(v.plate.length - plate.length) <= 1,
    );
  },
  async allActive() {
    return vehicles.filter((v) => v.isActive);
  },
});

const thresholds = (value: Thresholds = DEFAULT_THRESHOLDS): PlateThresholdProvider => ({
  async current() {
    return value;
  },
});

const event = (over: Partial<PlateRecognizedEvent> = {}): PlateRecognizedEvent => ({
  captureId: 'cap-1',
  cameraId: 'gate-north',
  capturedAt: '2026-10-09T14:03:11.482Z',
  objectKey: 'raw/gate-north/2026/10/09/cap-1.jpg',
  candidates: [{ plate: '1234ABC', raw: '1234 ABC', confidence: 0.96, score: 220 }],
  best: { plate: '1234ABC', confidence: 0.96 },
  quality: 0.9,
  engine: 'rekognition-detect-text',
  engineVersion: '2026-10',
  latencyMs: 611,
  ...over,
});

const registered: RegisteredVehicle = {
  vehicleId: 'v-1',
  residentId: 'r-1',
  plate: '1234ABC',
  isActive: true,
  residentIsEligible: true,
  spotId: 'spot-7',
};

const build = (vehicles: readonly RegisteredVehicle[] = [registered]) => {
  const reads = new FakeReads();
  const events = new FakeEvents();
  const cooldown = new InMemoryCooldownStore();
  const uc = new IngestPlateRead(
    reads,
    events,
    register(vehicles),
    cooldown,
    thresholds(),
    silentLogger,
    { cooldownSeconds: 30 },
  );
  return { uc, reads, events, cooldown };
};

describe('IngestPlateRead', () => {
  it('writes a read and its access event for a confident exact match', async () => {
    const { uc, reads, events } = build();
    const out = await uc.apply(event());

    expect(out.kind).toBe('applied');
    expect(reads.rows.size).toBe(1);
    expect(events.written).toHaveLength(1);
    expect(events.written[0]?.input.decision).toBe('ALLOW');
    expect(events.written[0]?.input.reason).toBe('EXACT_MATCH');
    // The bay the resident holds, carried into the log: it answers the administrator's
    // real question, which is an authorised car parked in somebody else's bay.
    expect(events.written[0]?.input.spotId).toBe('spot-7');
  });

  it('applies the same capture twice as one row and one event', async () => {
    // The DynamoDB stream delivers at least once, so this is the path a shard replay or
    // a redeployed consumer takes.
    const { uc, reads, events } = build();
    await uc.apply(event());
    const second = await uc.apply(event());

    expect(second.kind).toBe('duplicate');
    expect(reads.rows.size).toBe(1);
    expect(events.written).toHaveLength(1);
  });

  it('records the frame but no event for a second arrival inside the cooldown', async () => {
    const { uc, reads, events } = build();
    await uc.apply(event({ captureId: 'cap-1' }));
    const out = await uc.apply(event({ captureId: 'cap-2' }));

    expect(out.kind).toBe('applied');
    if (out.kind !== 'applied') return;
    expect(out.decision.status).toBe('DISCARDED');
    expect(out.decision.reason).toBe('DUPLICATE_WITHIN_COOLDOWN');
    // The frame survives: it is still evidence of what the camera saw.
    expect(reads.rows.size).toBe(2);
    // The log does not get twenty rows for one car creeping towards the barrier.
    expect(events.written).toHaveLength(1);
  });

  it('keys the cooldown on the matched plate, not on the raw read', async () => {
    /*
     * The reason the register is consulted before the cooldown. A car read as "1234ABC"
     * on one frame and "1234A8C" on the next would otherwise escape its own window and
     * write two entries for one arrival - exactly what the cooldown exists to stop.
     */
    const { uc, events } = build();
    await uc.apply(event({ captureId: 'cap-1' }));
    await uc.apply(
      event({
        captureId: 'cap-2',
        candidates: [{ plate: '1234A8C', raw: '1234 A8C', confidence: 0.96, score: 150 }],
        best: { plate: '1234A8C', confidence: 0.96 },
      }),
    );
    expect(events.written).toHaveLength(1);
  });

  it('does not open a cooldown window on a frame that produced no event', async () => {
    // Marking a discarded frame would extend its own window while a car idles at the
    // barrier, and the next genuine arrival would be swallowed too.
    const { uc, cooldown } = build();
    await uc.apply(
      event({
        candidates: [{ plate: '1234ABC', raw: '1234 ABC', confidence: 0.4, score: 150 }],
        best: { plate: '1234ABC', confidence: 0.4 },
        quality: 0.1,
      }),
    );
    expect(await cooldown.check('gate-north', '1234ABC')).toBe(false);
  });

  it('records an unreadable frame with no access event', async () => {
    const { uc, reads, events } = build();
    const out = await uc.apply(event({ candidates: [], best: null, quality: null }));

    expect(out.kind).toBe('applied');
    if (out.kind !== 'applied') return;
    expect(out.decision.reason).toBe('UNREADABLE');
    expect(reads.rows.size).toBe(1);
    expect(events.written).toHaveLength(0);
  });

  it('rejects an event with no capture id rather than writing a row it cannot dedupe', async () => {
    const { uc } = build();
    const out = await uc.apply(event({ captureId: '' }));
    expect(out.kind).toBe('malformed');
  });

  it('stores the engine confidence, not the fused value', async () => {
    // A third copy of a number derived from two others is a number that disagrees with
    // its own inputs the first time either is corrected.
    const { uc, reads } = build();
    await uc.apply(event({ quality: 0.5 }));
    expect([...reads.rows.values()][0]?.confidence).toBe(0.96);
  });
});

describe('parsePlateRecognized', () => {
  it('reads a well-formed stream image', () => {
    const parsed = parsePlateRecognized({ type: 'PlateRecognized', ...event() });
    expect(parsed?.captureId).toBe('cap-1');
    expect(parsed?.candidates[0]?.plate).toBe('1234ABC');
  });

  it('ignores an item that is not a plate event', () => {
    // The stream carries Cognito provisioning and subject links on the same table.
    expect(parsePlateRecognized({ type: 'ResidentCreated', pk: 'evt#1' })).toBeNull();
    expect(parsePlateRecognized({ pk: 'link#abc' })).toBeNull();
    expect(parsePlateRecognized(null)).toBeNull();
  });

  it('coerces a numeric that arrived as a string', () => {
    const parsed = parsePlateRecognized({
      type: 'PlateRecognized',
      captureId: 'cap-9',
      cameraId: 'gate-south',
      objectKey: 'raw/gate-south/x.jpg',
      candidates: [{ plate: '1234ABC', raw: '1234ABC', confidence: '0.9', score: '200' }],
      quality: '0.8',
      latencyMs: '611',
    });
    expect(parsed?.candidates[0]?.confidence).toBe(0.9);
    expect(parsed?.quality).toBe(0.8);
    expect(parsed?.latencyMs).toBe(611);
  });

  it('drops a candidate with no plate instead of storing a blank one', () => {
    const parsed = parsePlateRecognized({
      type: 'PlateRecognized',
      captureId: 'cap-9',
      cameraId: 'gate-south',
      objectKey: 'raw/gate-south/x.jpg',
      candidates: [{ raw: 'noise' }, { plate: '1234ABC', confidence: 0.9, score: 200 }],
    });
    expect(parsed?.candidates).toHaveLength(1);
  });
});
