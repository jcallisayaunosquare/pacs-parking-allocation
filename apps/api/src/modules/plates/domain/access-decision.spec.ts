import { describe, expect, it } from 'vitest';
import { normalizePlate } from '../../residents/domain/vehicle';
import { rankCandidates } from './plate-candidate';
import { decide, DEFAULT_THRESHOLDS, type RegisteredVehicle } from './access-decision';

/**
 * The threshold table of MODULO-PLACAS.md section 5, row by row.
 *
 * This is the argument for keeping `decide()` pure: the whole table is verified in
 * milliseconds with no database and no AWS, the same way the allocation engine is
 * verified 10 000 times without touching the cloud.
 */
const vehicle = (over: Partial<RegisteredVehicle> = {}): RegisteredVehicle => ({
  vehicleId: 'v-1',
  residentId: 'r-1',
  plate: '1234ABC',
  isActive: true,
  residentIsEligible: true,
  ...over,
});

const bestOf = (plate: string, confidence: number) =>
  rankCandidates([{ text: plate, confidence }])[0] ?? null;

describe('decide', () => {
  it('ALLOWs a confident exact match', () => {
    const d = decide({
      best: bestOf('1234ABC', 0.98),
      quality: 0.9,
      registered: [vehicle()],
      withinCooldown: false,
    });
    expect(d.decision).toBe('ALLOW');
    expect(d.reason).toBe('EXACT_MATCH');
    expect(d.matchKind).toBe('EXACT');
    expect(d.matchDistance).toBe(0);
    expect(d.vehicleId).toBe('v-1');
    expect(d.status).toBe('MATCHED');
  });

  it('ALLOWs a confident lone fuzzy match at distance 1', () => {
    // "1234ABD" is itself a valid series, so the ranker does not silently repair it; the
    // fuzzy tier is what connects it to the registered 1234ABC.
    const d = decide({
      best: bestOf('1234ABD', 0.99),
      quality: 1,
      registered: [vehicle()],
      withinCooldown: false,
    });
    expect(d.decision).toBe('ALLOW');
    expect(d.reason).toBe('FUZZY_MATCH_SINGLE');
    expect(d.matchDistance).toBe(1);
  });

  it('sends an ambiguous fuzzy match to review and attributes it to nobody', () => {
    // Opening here would mean picking at random whose entry this was, and the log would
    // then assert something untrue.
    const d = decide({
      best: bestOf('1234ABD', 0.99),
      quality: 1,
      registered: [vehicle(), vehicle({ vehicleId: 'v-2', residentId: 'r-2', plate: '1234ABX' })],
      withinCooldown: false,
    });
    expect(d.decision).toBe('REVIEW');
    expect(d.reason).toBe('FUZZY_MATCH_AMBIGUOUS');
    expect(d.vehicleId).toBeNull();
    expect(d.residentId).toBeNull();
    expect(d.ambiguousWith).toHaveLength(2);
  });

  it('DENIES a clear read that is in no registration, rather than reviewing it', () => {
    // A visitor or an intruder is a fact, not a doubt. A visitor lane is a separate
    // feature - a temporary plate with an expiry - not a loosened threshold.
    const d = decide({
      best: bestOf('9876ZYX', 0.99),
      quality: 1,
      registered: [vehicle()],
      withinCooldown: false,
    });
    expect(d.decision).toBe('DENY');
    expect(d.reason).toBe('PLATE_NOT_REGISTERED');
    expect(d.status).toBe('UNMATCHED');
  });

  it('reviews a read whose fused confidence falls between the two thresholds', () => {
    const d = decide({
      best: bestOf('9876ZYX', 0.8),
      quality: 0.8,
      registered: [],
      withinCooldown: false,
    });
    expect(d.fused).toBeGreaterThan(DEFAULT_THRESHOLDS.reviewFused);
    expect(d.fused).toBeLessThan(DEFAULT_THRESHOLDS.minFused);
    expect(d.decision).toBe('REVIEW');
    expect(d.reason).toBe('LOW_CONFIDENCE');
  });

  it('reviews an identified car it is not confident enough about', () => {
    const d = decide({
      best: bestOf('1234ABC', 0.8),
      quality: 0.8,
      registered: [vehicle()],
      withinCooldown: false,
    });
    expect(d.decision).toBe('REVIEW');
    expect(d.reason).toBe('LOW_CONFIDENCE');
    // Identified all the same, so the reviewer confirms in one click.
    expect(d.vehicleId).toBe('v-1');
  });

  it('produces NO access event below the floor', () => {
    /*
     * An unreadable frame is not a denied entry. A DENY here would fill the log with
     * refusals belonging to nobody, and the denial metric would then be measuring lens
     * dirt rather than refused cars.
     */
    const d = decide({
      best: bestOf('1234ABC', 0.5),
      quality: 0.1,
      registered: [vehicle()],
      withinCooldown: false,
    });
    expect(d.decision).toBeNull();
    expect(d.reason).toBe('UNREADABLE');
    expect(d.status).toBe('REVIEW');
  });

  it('produces no event when there was no candidate at all', () => {
    const d = decide({
      best: null,
      quality: null,
      registered: [vehicle()],
      withinCooldown: false,
    });
    expect(d.decision).toBeNull();
    expect(d.reason).toBe('UNREADABLE');
    expect(d.fused).toBe(0);
  });

  it('discards a duplicate within the cooldown but still records the read', () => {
    const d = decide({
      best: bestOf('1234ABC', 0.99),
      quality: 1,
      registered: [vehicle()],
      withinCooldown: true,
    });
    expect(d.status).toBe('DISCARDED');
    expect(d.decision).toBeNull();
    expect(d.reason).toBe('DUPLICATE_WITHIN_COOLDOWN');
  });

  it('identifies an ineligible resident and denies them by name', () => {
    const d = decide({
      best: bestOf('1234ABC', 0.99),
      quality: 1,
      registered: [vehicle({ residentIsEligible: false })],
      withinCooldown: false,
    });
    expect(d.decision).toBe('DENY');
    expect(d.reason).toBe('RESIDENT_NOT_ELIGIBLE');
    // The log must still say who it was: that is the difference between this and an
    // unregistered plate, and it is the conversation the administrator has to have.
    expect(d.residentId).toBe('r-1');
  });

  it('denies a vehicle whose registration was removed', () => {
    const d = decide({
      best: bestOf('1234ABC', 0.99),
      quality: 1,
      registered: [vehicle({ isActive: false })],
      withinCooldown: false,
    });
    expect(d.decision).toBe('DENY');
    expect(d.reason).toBe('VEHICLE_INACTIVE');
    expect(d.status).toBe('UNMATCHED');
  });

  it('opens for the current registration of a plate that was registered before', () => {
    /*
     * Both rows are the same plate, which the register permits: uniqueness is partial on
     * is_active so a car sold to a neighbour, or a registration removed by mistake, can be
     * registered again. The removed row is listed first, which is what the lookup returned
     * in dev - and the gate denied the car at the barrier with VEHICLE_INACTIVE while its
     * owner's active registration sat in the same list.
     */
    const d = decide({
      best: bestOf('1234ABC', 0.99),
      quality: 1,
      registered: [
        vehicle({ vehicleId: 'v-old', residentId: 'r-old', isActive: false }),
        vehicle({ vehicleId: 'v-now', residentId: 'r-now', isActive: true }),
      ],
      withinCooldown: false,
    });
    expect(d.decision).toBe('ALLOW');
    expect(d.reason).toBe('EXACT_MATCH');
    expect(d.vehicleId).toBe('v-now');
    expect(d.residentId).toBe('r-now');
  });

  it('matches a plate registered with an O against a read of a zero', () => {
    // The register stored normalizePlate("O123ABC") = "0123ABC", and the read is folded
    // by the same function. Two definitions here would refuse a car that is registered.
    const d = decide({
      best: bestOf('0123ABC', 0.99),
      quality: 1,
      registered: [vehicle({ plate: normalizePlate('O123ABC') })],
      withinCooldown: false,
    });
    expect(d.reason).toBe('EXACT_MATCH');
  });

  it('carries the held bay into the decision, for the log', () => {
    const d = decide({
      best: bestOf('1234ABC', 0.99),
      quality: 1,
      registered: [vehicle({ spotId: 'spot-7' })],
      withinCooldown: false,
    });
    expect(d.spotId).toBe('spot-7');
  });

  it('honours recalibrated thresholds rather than the compiled defaults', () => {
    // Section 8's whole point: moving the numbers is an UPDATE, not a deploy.
    const strict = decide({
      best: bestOf('1234ABC', 0.9),
      quality: 1,
      registered: [vehicle()],
      withinCooldown: false,
      thresholds: { minFused: 0.95, reviewFused: 0.55, maxFuzzyDistance: 1 },
    });
    expect(strict.decision).toBe('REVIEW');

    const lenient = decide({
      best: bestOf('1234ABC', 0.9),
      quality: 1,
      registered: [vehicle()],
      withinCooldown: false,
      thresholds: { minFused: 0.6, reviewFused: 0.3, maxFuzzyDistance: 1 },
    });
    expect(lenient.decision).toBe('ALLOW');
  });

  it('refuses to fuzzy-match beyond the configured distance', () => {
    const d = decide({
      best: bestOf('1299ABC', 0.99),
      quality: 1,
      registered: [vehicle()],
      withinCooldown: false,
      thresholds: { ...DEFAULT_THRESHOLDS, maxFuzzyDistance: 1 },
    });
    expect(d.reason).toBe('PLATE_NOT_REGISTERED');
  });

  it('never opens a gate on a blocklisted scene word', () => {
    // The end-to-end version of the blocklist regression: no candidate survives, so the
    // frame is unreadable and nothing is decided.
    const d = decide({
      best: rankCandidates([{ text: 'VISITAS', confidence: 0.99 }])[0] ?? null,
      quality: 1,
      registered: [vehicle()],
      withinCooldown: false,
    });
    expect(d.decision).toBeNull();
    expect(d.reason).toBe('UNREADABLE');
  });
});
