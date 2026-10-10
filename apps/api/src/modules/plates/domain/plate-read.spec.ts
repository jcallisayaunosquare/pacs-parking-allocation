import { describe, expect, it } from 'vitest';
import type { RegisteredVehicle } from './access-decision';
import { resolveReview, type PlateRead, type ReviewVerdict } from './plate-read';

/**
 * The review rule. These tests are mostly about the ways a correction could launder a
 * decision the automatic path would have refused.
 */
const read = (over: Partial<PlateRead> = {}): PlateRead => ({
  id: 'pr-1',
  captureId: '01JB3K5Z9Q7M2N4P6R8T0V2X4Y',
  cameraId: 'gate-north',
  capturedAt: new Date('2026-10-09T14:03:11Z'),
  receivedAt: new Date('2026-10-09T14:03:13Z'),
  rawText: '1Z34 ABC',
  plate: '1Z34ABC',
  confidence: 0.74,
  quality: 0.6,
  fused: 0.62,
  status: 'REVIEW',
  vehicleId: null,
  matchKind: 'NONE',
  matchDistance: null,
  candidates: [],
  imageKey: 'raw/gate-north/2026/10/09/01JB.jpg',
  cropKey: null,
  engine: 'rekognition-detect-text',
  engineVersion: '2026-10',
  latencyMs: 611,
  reviewedBy: null,
  reviewedAt: null,
  reviewNote: null,
  correctedPlate: null,
  ...over,
});

const vehicle = (over: Partial<RegisteredVehicle> = {}): RegisteredVehicle => ({
  vehicleId: 'v-1',
  residentId: 'r-1',
  plate: '1234ABC',
  isActive: true,
  residentIsEligible: true,
  ...over,
});

const verdict = (over: Partial<ReviewVerdict> = {}): ReviewVerdict => ({
  decision: 'ALLOW',
  ...over,
});

describe('resolveReview', () => {
  it('records the plate the administrator named as a ground-truth label', () => {
    const r = resolveReview(read(), verdict({ plate: '1234-abc' }), [vehicle()]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Normalised by the same function the register uses, so the label and the register
    // agree about what "the same plate" means.
    expect(r.value.correctedPlate).toBe('1234ABC');
    expect(r.value.plate).toBe('1234ABC');
    expect(r.value.matchKind).toBe('MANUAL');
    expect(r.value.decision).toBe('ALLOW');
    expect(r.value.vehicleId).toBe('v-1');
    expect(r.value.residentId).toBe('r-1');
  });

  it('resolves a typed plate to a vehicle so the reviewer need not know ids', () => {
    const r = resolveReview(read(), verdict({ plate: '1234ABC' }), [vehicle()]);
    expect(r.ok && r.value.vehicleId).toBe('v-1');
  });

  it('refuses an ALLOW that names no plate', () => {
    // An access row that cannot be joined to anything cannot be contested either.
    const r = resolveReview(read(), verdict({}), [vehicle()]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('VALIDATION_FAILED');
    expect(r.error.details?.[0]?.field).toBe('plate');
  });

  it('refuses a vehicle that is not in the register', () => {
    const r = resolveReview(read(), verdict({ vehicleId: 'v-nope' }), [vehicle()]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  it('refuses a vehicle whose registration was removed', () => {
    const r = resolveReview(
      read(),
      verdict({ vehicleId: 'v-1' }),
      [vehicle({ isActive: false })],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
  });

  it('turns an ALLOW for an ineligible resident into a DENY, not a refusal', () => {
    /*
     * The administrator is not wrong about which car it was - they are wrong about
     * whether it may enter. Refusing the whole submission would leave the read unreviewed
     * and the label lost, so the identification is kept and the rule decides the outcome.
     */
    const r = resolveReview(
      read(),
      verdict({ plate: '1234ABC' }),
      [vehicle({ residentIsEligible: false })],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.decision).toBe('DENY');
    expect(r.value.reason).toBe('RESIDENT_NOT_ELIGIBLE');
    expect(r.value.correctedPlate).toBe('1234ABC');
  });

  it('records a manual override for a plate in no registration', () => {
    // A building does wave in a delivery van, and a row saying who decided that is better
    // than no row at all.
    const r = resolveReview(read(), verdict({ plate: '9999XXX' }), [vehicle()]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.decision).toBe('ALLOW');
    expect(r.value.reason).toBe('MANUAL_REVIEW');
    expect(r.value.status).toBe('UNMATCHED');
    expect(r.value.vehicleId).toBeNull();
  });

  it('discards a frame without producing an access event', () => {
    const r = resolveReview(
      read(),
      verdict({ decision: 'DENY', discard: true, note: 'lens splashed' }),
      [vehicle()],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('DISCARDED');
    expect(r.value.decision).toBeNull();
    expect(r.value.note).toBe('lens splashed');
    // Discarding asserts nothing about the plate, so it contributes no label.
    expect(r.value.correctedPlate).toBeNull();
  });

  it('denies an unregistered plate with the automatic reason', () => {
    const r = resolveReview(read(), verdict({ decision: 'DENY' }), [vehicle()]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.decision).toBe('DENY');
    expect(r.value.reason).toBe('PLATE_NOT_REGISTERED');
  });

  it('refuses a second review of the same read', () => {
    // Belt to the database's braces: the real guard is `WHERE reviewed_at IS NULL` on the
    // update, because the window between a read and a write is where the race lives.
    const r = resolveReview(
      read({ reviewedAt: new Date('2026-10-09T15:00:00Z'), reviewedBy: 'r-9' }),
      verdict({ plate: '1234ABC' }),
      [vehicle()],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PLATE_READ_ALREADY_REVIEWED');
  });

  it('refuses a plate that is not a plate', () => {
    const r = resolveReview(read(), verdict({ plate: '-' }), [vehicle()]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.[0]?.field).toBe('plate');
  });

  it('refuses an over-long note instead of truncating it silently', () => {
    const r = resolveReview(
      read(),
      verdict({ plate: '1234ABC', note: 'x'.repeat(2001) }),
      [vehicle()],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.[0]?.field).toBe('note');
  });
});
