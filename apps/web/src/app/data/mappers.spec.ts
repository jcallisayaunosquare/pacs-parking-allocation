import { describe, expect, it } from 'vitest';
import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { toApiError } from '../core/http/api-error';
import { toCycle, toDashboard, toHistoryEntry, toPage, toPrincipal, toResident } from './mappers';
import type { DashboardDto } from './dto';

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
      scoreAtDraw: '2.00' as unknown as number,
      recordedAt: '2025-12-26T02:00:00Z',
    });

    expect(h.scoreAtDraw).toBe(2);
    expect(typeof h.scoreAtDraw).toBe('number');
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
        score: 0,
        consecutiveMisses: 0,
        totalWins: 3,
        drawWeight: 1,
        explanation: 'You hold a spot this quarter, so your score reset to 0.',
      },
      nextCycle: null,
      recentHistory: [],
    };

    const d = toDashboard(dto);
    expect(d.assignment?.spotCode).toBe('B2-14');
    expect(d.assignment?.validUntil).toBeInstanceOf(Date);
    expect(d.waitlist).toBeNull();
    expect(d.fairness.drawWeight).toBe(1);
    // The sentence comes from the API verbatim; the UI must not compose it.
    expect(d.fairness.explanation).toContain('reset to 0');
  });

  it('survives a dashboard with no history array', () => {
    const d = toDashboard({
      resident: { id: 'r1', fullName: 'X', unit: '1', isEligible: true },
      assignment: null,
      waitlist: { position: 4 },
      fairness: { score: 3, consecutiveMisses: 3, totalWins: 0, drawWeight: 4, explanation: 'x' },
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
