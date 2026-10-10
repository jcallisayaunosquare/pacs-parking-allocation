import { describe, expect, it } from 'vitest';
import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { toApiError } from '../core/http/api-error';
import {
  toAccessEvent,
  toCycle,
  toDashboard,
  toHistoryEntry,
  toPage,
  toPlateMetrics,
  toPlateRead,
  toPrincipal,
  toResident,
  toVehicle,
} from './mappers';
import type { DashboardDto, PlateReadDto } from './dto';

/**
 * The boundary is where bugs live: ISO strings that should be Dates, numerics that
 * arrive as strings, and the error shape the whole UI depends on. These are pure
 * functions, so they are tested directly rather than through a component.
 */

describe('mappers', () => {
  it('turns ISO strings into Dates at the boundary', () => {
    const c = toCycle({
      id: 'c1',
      label: '2026-Q1',
      startsOn: '2026-01-01',
      endsOn: '2026-03-31',
      state: 'ACTIVE',
      registrationOpensAt: '2025-12-01T00:00:00Z',
      registrationClosesAt: '2025-12-25T00:00:00Z',
    });

    expect(c.startsOn).toBeInstanceOf(Date);
    expect(c.registrationClosesAt.toISOString()).toBe('2025-12-25T00:00:00.000Z');
    expect(c.label).toBe('2026-Q1');
  });

  it('coerces a numeric that arrived as a string', () => {
    const h = toHistoryEntry({
      cycle: '2025-Q4',
      result: 'WAITLISTED',
      spotCode: null,
      position: 6,
      // numeric(10,2) comes back from pg as a string on some paths.
      effectiveWaitHours: '2160.00' as unknown as number,
      servedCountAtDraw: 1,
      biasApplied: false,
      finalRank: 7,
      recordedAt: '2025-12-26T02:00:00Z',
    });

    expect(h.effectiveWaitHours).toBe(2160);
    expect(typeof h.effectiveWaitHours).toBe('number');
  });

  it('keeps an absent key absent rather than turning it into zero', () => {
    // A run the resident sat out has no stored row, and 0 hours would claim it did.
    const h = toHistoryEntry({
      cycle: '2025-Q3',
      result: 'SKIPPED',
      spotCode: null,
      position: null,
      effectiveWaitHours: null,
      servedCountAtDraw: null,
      biasApplied: null,
      finalRank: null,
      recordedAt: '2025-09-26T02:00:00Z',
    });

    expect(h.effectiveWaitHours).toBeNull();
    expect(h.servedCountAtDraw).toBeNull();
  });

  it('maps a dashboard with an active assignment', () => {
    const dto: DashboardDto = {
      resident: { id: 'r1', fullName: 'A. Rivera', unit: '704', isEligible: true },
      assignment: {
        spotCode: 'B2-14',
        level: 'B2',
        type: 'STANDARD',
        validFrom: '2026-01-01T00:00:00Z',
        validUntil: '2026-03-31T23:59:59Z',
        state: 'ACTIVE',
      },
      waitlist: null,
      fairness: {
        anchorAt: '2026-01-01T00:00:00Z',
        waitingHours: 0,
        effectiveWaitHours: 0,
        servedCount: 3,
        biasApplied: false,
        firstTimeParticipant: false,
        explanation: 'You hold a bay for this period. Your waiting time starts again when it ends.',
      },
      nextCycle: null,
      recentHistory: [],
    };

    const d = toDashboard(dto);
    expect(d.assignment?.spotCode).toBe('B2-14');
    expect(d.assignment?.validUntil).toBeInstanceOf(Date);
    expect(d.waitlist).toBeNull();
    expect(d.fairness.servedCount).toBe(3);
    expect(d.fairness.anchorAt).toBeInstanceOf(Date);
    // The sentence comes from the API verbatim; the UI must not compose it.
    expect(d.fairness.explanation).toContain('starts again');
  });

  it('survives a dashboard with no history array', () => {
    const d = toDashboard({
      resident: { id: 'r1', fullName: 'X', unit: '1', isEligible: true },
      assignment: null,
      waitlist: { position: 4 },
      fairness: {
        anchorAt: '2025-10-01T00:00:00Z',
        waitingHours: 2160,
        effectiveWaitHours: 2160,
        servedCount: 0,
        biasApplied: false,
        firstTimeParticipant: true,
        explanation: 'x',
      },
      nextCycle: null,
      recentHistory: undefined as never,
    });
    expect(d.recentHistory).toEqual([]);
    expect(d.waitlist?.position).toBe(4);
  });

  it('maps a principal without a resident record', () => {
    const p = toPrincipal({ subject: 'abc', email: 'a@b.com', roles: ['ADMIN'], resident: null });
    expect(p.resident).toBeNull();
    expect(p.roles).toEqual(['ADMIN']);
  });

  it('keeps both plate forms, because they answer different questions', () => {
    const v = toVehicle({
      id: 'v1',
      residentId: 'r1',
      // The canonical form, as the server folds it: O became 0 and the dash went.
      plate: 'AB012',
      plateDisplay: 'ABO-12',
      make: 'Toyota',
      model: 'Corolla',
      year: 2019,
      colour: 'Silver',
      notes: null,
      photos: ['veh/v1/front.jpg'],
      isActive: true,
    });

    // The typed form is what the register prints; the canonical one is what the gate
    // matches. Collapsing them would leave a resident unable to find their own plate.
    expect(v.plateDisplay).toBe('ABO-12');
    expect(v.plate).toBe('AB012');
    expect(v.year).toBe(2019);
    expect(v.photos).toEqual(['veh/v1/front.jpg']);
  });

  it('falls back to the canonical plate when the server sends no display form', () => {
    const v = toVehicle({
      id: 'v2',
      residentId: 'r1',
      plate: 'XYZ99',
      plateDisplay: '' as unknown as string,
      make: null,
      model: null,
      year: null,
      colour: null,
      notes: null,
      photos: [],
      isActive: true,
    });
    // A row with no plate at all is unreadable, and the canonical form is still their
    // plate - only punctuated differently.
    expect(v.plateDisplay).toBe('XYZ99');
    expect(v.year).toBeNull();
  });

  it('survives a vehicle with no photos array and no isActive', () => {
    const v = toVehicle({
      id: 'v3',
      residentId: 'r1',
      plate: 'AA11',
      plateDisplay: 'AA-11',
      make: null,
      model: null,
      year: null,
      colour: null,
      notes: null,
      photos: undefined as never,
      isActive: undefined as never,
    });
    // Iterating undefined would break the register; the endpoint only ever returns
    // active rows, so an unlabelled one is current.
    expect(v.photos).toEqual([]);
    expect(v.isActive).toBe(true);
  });

  it('coerces a model year that arrived as a string', () => {
    const v = toVehicle({
      id: 'v4',
      residentId: 'r1',
      plate: 'BB22',
      plateDisplay: 'BB-22',
      make: null,
      model: null,
      year: '2021' as unknown as number,
      colour: null,
      notes: null,
      photos: [],
      isActive: true,
    });
    expect(v.year).toBe(2021);
    expect(typeof v.year).toBe('number');
  });

  // ----------------------------------------------- plate recognition (M-7)

  const readDto = (over: Partial<PlateReadDto> = {}): PlateReadDto => ({
    id: 'pr-1',
    captureId: '01JB3K5Z9Q7M2N4P6R8T0V2X4Y',
    cameraId: 'gate-north',
    capturedAt: '2026-10-09T14:03:11.482Z',
    rawText: '1234 ABC',
    plate: '1234ABC',
    registeredPlate: '1234ABC',
    confidence: 0.96,
    quality: 0.9,
    fused: 0.9216,
    status: 'MATCHED',
    matchKind: 'EXACT',
    matchDistance: 0,
    vehicleId: 'v-1',
    residentId: 'r-1',
    residentName: 'Ana Rojas',
    unitNumber: '402',
    spotCode: 'B1-A07',
    vehicleMake: 'Nissan',
    vehicleModel: 'Sentra',
    vehicleYear: 2018,
    vehicleColour: 'silver',
    decision: 'ALLOW',
    reason: 'EXACT_MATCH',
    imageKey: 'raw/gate-north/2026/10/09/01JB.jpg',
    cropKey: null,
    engine: 'rekognition-detect-text',
    engineVersion: '2026-10',
    latencyMs: 611,
    needsReview: false,
    reviewedAt: null,
    reviewNote: null,
    correctedPlate: null,
    candidates: [{ plate: '1234ABC', raw: '1234 ABC', confidence: 0.96, score: 220.4 }],
    ...over,
  });

  it('turns a plate read into dates and numbers at the boundary', () => {
    const r = toPlateRead(readDto());
    expect(r.capturedAt).toBeInstanceOf(Date);
    expect(r.capturedAt.toISOString()).toBe('2026-10-09T14:03:11.482Z');
    expect(r.plate).toBe('1234ABC');
    expect(r.fused).toBeCloseTo(0.9216, 6);
    expect(r.candidates[0]?.score).toBe(220.4);
  });

  it('keeps all three confidence numbers, because they are three different faults', () => {
    // A blurred crop the engine was certain about and a sharp crop it was not are
    // opposite problems, and only the two inputs beside the product can tell them apart.
    const r = toPlateRead(readDto({ confidence: 0.98, quality: 0.2, fused: 0.6664 }));
    expect(r.confidence).toBe(0.98);
    expect(r.quality).toBe(0.2);
    expect(r.fused).toBeCloseTo(0.6664, 6);
  });

  it('recomputes fused when the server did not send it', () => {
    // The screen sorts and filters on it, so a null there would drop the row out of the
    // view the administrator opened the page for.
    const r = toPlateRead(readDto({ fused: null, confidence: 0.9, quality: 0.5 }));
    expect(r.fused).toBeCloseTo(0.9 * (0.6 + 0.4 * 0.5), 10);
  });

  it('leaves fused unknown when there is no confidence to derive it from', () => {
    const r = toPlateRead(readDto({ fused: null, confidence: null, quality: null }));
    expect(r.fused).toBeNull();
  });

  it('treats an absent quality as no penalty rather than as zero', () => {
    const r = toPlateRead(readDto({ fused: null, confidence: 0.9, quality: null }));
    expect(r.fused).toBeCloseTo(0.9, 10);
  });

  it('derives needsReview when an older API did not send it', () => {
    // A row that is REVIEW and unreviewed needs a human whatever the server labelled it;
    // without this the review filter would come back empty while reads were waiting.
    const r = toPlateRead(
      readDto({ needsReview: undefined as never, status: 'REVIEW', reviewedAt: null }),
    );
    expect(r.needsReview).toBe(true);
  });

  it('keeps a null decision null, because an unreadable frame is not a refused entry', () => {
    const r = toPlateRead(
      readDto({ decision: null, reason: 'UNREADABLE', status: 'REVIEW', needsReview: true }),
    );
    expect(r.decision).toBeNull();
    expect(r.reason).toBe('UNREADABLE');
  });

  it('carries a reason code this build has not heard of rather than dropping it', () => {
    // The API is deployed independently. A reason that silently became null would read as
    // "no decision was made", which is a different and worse claim.
    const r = toPlateRead(readDto({ reason: 'SOME_NEW_REASON' }));
    expect(r.reason).toBe('SOME_NEW_REASON');
  });

  it('survives a read with no candidate array', () => {
    const r = toPlateRead(readDto({ candidates: undefined }));
    expect(r.candidates).toEqual([]);
  });

  it('keeps the correction apart from the plate, because only one is a label', () => {
    const r = toPlateRead(
      readDto({ plate: '1234ABC', correctedPlate: '1234ABC', matchKind: 'MANUAL' }),
    );
    expect(r.correctedPlate).toBe('1234ABC');
    expect(r.matchKind).toBe('MANUAL');
  });

  it('maps an access event and its supersession link', () => {
    const e = toAccessEvent({
      id: 'ae-2',
      plateReadId: 'pr-1',
      captureId: '01JB3K5Z9Q7M2N4P6R8T0V2X4Y',
      plate: '1234ABC',
      residentId: 'r-1',
      residentName: 'Ana Rojas',
      unitNumber: '103',
      spotCode: 'B1-A07',
      decision: 'DENY',
      reason: 'RESIDENT_NOT_ELIGIBLE',
      cameraId: 'gate-north',
      occurredAt: '2026-10-09T14:03:11.482Z',
      supersededBy: null,
    });
    expect(e.occurredAt).toBeInstanceOf(Date);
    expect(e.decision).toBe('DENY');
    expect(e.supersededBy).toBeNull();
  });

  it('keeps an absent plate metric absent rather than turning it into zero', () => {
    // A zero match rate and an unknown match rate are different claims, and at display
    // scale the first one reads as the engine being broken.
    const m = toPlateMetrics({
      windowDays: 30,
      reads: 0,
      matched: 0,
      unmatched: 0,
      pendingReview: 0,
      oldestPendingHours: null,
      allowed: 0,
      denied: 0,
      averageFused: null,
      corrections: 0,
    });
    expect(m.oldestPendingHours).toBeNull();
    expect(m.averageFused).toBeNull();
    expect(m.reads).toBe(0);
  });

  it('coerces plate metrics that arrived as strings', () => {
    const m = toPlateMetrics({
      windowDays: 30,
      reads: '412' as unknown as number,
      matched: '388' as unknown as number,
      unmatched: 18,
      pendingReview: 6,
      oldestPendingHours: '3.4' as unknown as number,
      allowed: 380,
      denied: 20,
      averageFused: '0.9014' as unknown as number,
      corrections: 24,
    });
    expect(m.reads).toBe(412);
    expect(m.oldestPendingHours).toBe(3.4);
    expect(m.averageFused).toBeCloseTo(0.9014, 6);
  });

  it('keeps the cursor when mapping a page', () => {
    const page = toPage(
      {
        items: [
          {
            id: 'r1',
            email: 'a@b.com',
            fullName: 'A',
            unitNumber: '1',
            isEligible: true,
            ineligibleReason: null,
            needsAccessibleSpot: false,
            externalSubject: null,
          },
        ],
        nextCursor: 'abc123',
      },
      toResident,
    );
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('abc123');
  });
});

describe('toApiError', () => {
  const headers = new HttpHeaders({ 'x-trace-id': 'trace-from-header' });

  it('reads the server error contract of §16', () => {
    const e = toApiError(
      new HttpErrorResponse({
        status: 409,
        error: {
          error: 'RAFFLE_IN_PROGRESS',
          message: 'An allocation run is already executing for this cycle.',
          traceId: 'trace-from-body',
        },
        headers,
      }),
    );

    expect(e.code).toBe('RAFFLE_IN_PROGRESS');
    expect(e.status).toBe(409);
    // The body's trace id wins over the header's.
    expect(e.traceId).toBe('trace-from-body');
  });

  it('carries validation details through', () => {
    const e = toApiError(
      new HttpErrorResponse({
        status: 400,
        error: {
          error: 'VALIDATION_FAILED',
          message: 'The request failed validation.',
          details: [{ field: 'email', issue: 'already in use' }],
        },
      }),
    );
    expect(e.details?.[0]?.field).toBe('email');
  });

  it('falls back to the header trace id when the body is not our shape', () => {
    const e = toApiError(new HttpErrorResponse({ status: 502, statusText: 'Bad Gateway', headers }));
    expect(e.code).toBe('HTTP_502');
    expect(e.traceId).toBe('trace-from-header');
  });

  it('names a connectivity failure rather than showing status 0', () => {
    const e = toApiError(new HttpErrorResponse({ status: 0 }));
    expect(e.code).toBe('NETWORK_ERROR');
    expect(e.message).toContain('connection');
  });

  it('handles something that is not an HttpErrorResponse at all', () => {
    const e = toApiError(new Error('boom'));
    expect(e.code).toBe('UNKNOWN');
    expect(e.message).toBe('boom');
  });
});
