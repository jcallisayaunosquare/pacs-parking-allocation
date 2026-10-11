import { describe, expect, it } from 'vitest';
import { CycleUseCases } from './cycle.use-cases';
import { fixedClock } from '../../../shared/clock';
import { InMemoryCache } from '../../../shared/cache/dynamodb-cache';
import { DEFAULT_ALLOCATION_CONFIG } from '../domain/allocation-config';
import type { AllocationConfigProvider, AssignmentRepository, CycleRecord, CycleRepository, RegistrationRepository } from './ports';
import type { Resident, ResidentRepository } from '../../residents/application/resident.use-cases';

/**
 * Separation of duties on the registration path (PRODUCT.md): "An administrator never
 * holds a bay and never enters the draw... because they operate it."
 *
 * Two independent sources say whether the caller is an administrator - the `is_admin`
 * column on their register row, and the ADMIN group on the verified token - and the point
 * of these tests is that both are refused. They used to disagree silently: an account put
 * in the ADMIN group without its row being flagged registered successfully and was then
 * ranked as a candidate.
 */

const CYCLE_ID = '11111111-1111-1111-1111-111111111111';
const RESIDENT_ID = '33333333-3333-3333-3333-333333333333';

const cycle: CycleRecord = {
  id: CYCLE_ID,
  label: '2026-04+3M',
  startsOn: new Date('2026-04-01T00:00:00Z'),
  endsOn: new Date('2026-06-30T23:59:59Z'),
  state: 'REGISTRATION_OPEN',
  registrationOpensAt: new Date('2026-03-01T00:00:00Z'),
  registrationClosesAt: new Date('2026-03-25T00:00:00Z'),
};

const resident = (over: Partial<Resident> = {}): Resident => ({
  id: RESIDENT_ID,
  email: 'a@b.com',
  fullName: 'A. Rivera',
  unitNumber: '503',
  isEligible: true,
  ineligibleReason: null,
  needsAccessibleSpot: false,
  hasElectricVehicle: false,
  currentSpotCode: null,
  isAdmin: false,
  participationStartedAt: new Date('2025-01-01T00:00:00Z'),
  externalSubject: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
  deactivatedAt: null,
  ...over,
});

/** Anything these tests do not exercise is a hard failure rather than a silent stub. */
const unused = (name: string) => (): never => {
  throw new Error(`${name} is not exercised by this spec`);
};

class FakeResidents implements ResidentRepository {
  constructor(private readonly row: Resident) {}
  async findById(): Promise<Resident | null> {
    return this.row;
  }
  findBySubject = unused('findBySubject');
  findByEmail = unused('findByEmail');
  list = unused('list');
  create = unused('create');
  update = unused('update');
  setParticipationStartedAt = unused('setParticipationStartedAt');
  setEligibility = unused('setEligibility');
  linkSubject = unused('linkSubject');
  softDelete = unused('softDelete');
  hardDelete = unused('hardDelete');
  consequences = unused('consequences');
  hasActiveAssignment = unused('hasActiveAssignment');
}

class FakeRegistrations implements RegistrationRepository {
  registered: string[] = [];
  async register(_cycleId: string, residentId: string): Promise<{ created: boolean }> {
    this.registered.push(residentId);
    return { created: true };
  }
  withdrawnAt: Date | null = null;
  async withdraw(_cycleId: string, _residentId: string, at: Date): Promise<boolean> {
    this.withdrawnAt = at;
    return true;
  }
  async isRegistered(): Promise<boolean> {
    return this.registered.length > 0;
  }
}

class FakeCycles implements CycleRepository {
  create = unused('create');
  async list(): Promise<readonly CycleRecord[]> {
    return [cycle];
  }
  transition = unused('transition');
  findByState = unused('findByState');
  findUpcoming = unused('findUpcoming');

  /** Overridden per test where removal is the subject. */
  async findById(): Promise<CycleRecord | null> {
    return cycle;
  }
  rename = unused('rename');
  async consequences(): Promise<{ hasRun: boolean; assignments: number }> {
    return { hasRun: false, assignments: 0 };
  }
  async remove(): Promise<boolean> {
    return true;
  }
  closeNow = unused('closeNow');
}

const configProvider: AllocationConfigProvider = {
  async current() {
    return { ...DEFAULT_ALLOCATION_CONFIG, version: 1 };
  },
  atVersion: unused('atVersion'),
  insert: unused('insert'),
  history: unused('history'),
};

const assignments = {
  findActiveForResident: unused('findActiveForResident'),
  listForRun: unused('listForRun'),
  release: unused('release'),
  expireDue: unused('expireDue'),
} as unknown as AssignmentRepository;

const build = (row: Resident) => {
  const registrations = new FakeRegistrations();
  const useCases = new CycleUseCases(
    new FakeCycles(),
    registrations,
    new FakeResidents(row),
    assignments,
    configProvider,
    fixedClock('2026-03-10T09:00:00Z'),
    new InMemoryCache(),
  );
  return { useCases, registrations };
};

describe('CycleUseCases.register', () => {
  it('registers an ordinary resident', async () => {
    const { useCases, registrations } = build(resident());
    const r = await useCases.register(CYCLE_ID, RESIDENT_ID, false);
    expect(r.ok).toBe(true);
    expect(registrations.registered).toEqual([RESIDENT_ID]);
  });

  it('refuses a register row flagged as an administrator', async () => {
    const { useCases, registrations } = build(resident({ isAdmin: true }));
    const r = await useCases.register(CYCLE_ID, RESIDENT_ID, false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('FORBIDDEN');
    expect(registrations.registered).toEqual([]);
  });

  /*
   * The defect: the row said resident, the token said administrator, and the row won.
   * The token is what actually grants the administrator their powers, so it is refused
   * first - before the cycle is even looked up.
   */
  it('refuses an ADMIN token even when the register row is not flagged', async () => {
    const { useCases, registrations } = build(resident({ isAdmin: false }));
    const r = await useCases.register(CYCLE_ID, RESIDENT_ID, true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('FORBIDDEN');
    expect(registrations.registered).toEqual([]);
  });

  it('defaults to refusing nothing, so an existing caller is unaffected', async () => {
    const { useCases } = build(resident());
    expect((await useCases.register(CYCLE_ID, RESIDENT_ID)).ok).toBe(true);
  });
});

describe('CycleUseCases.withdraw', () => {
  /*
   * The timestamp is the whole point of the rule. Withdrawing counts as having held the
   * bay, so the ranking needs to know *when* it happened - a boolean would say that the
   * resident is out of this draw and nothing about where their waiting restarts.
   */
  it('records the instant of the withdrawal, not merely the fact', async () => {
    const { useCases, registrations } = build(resident());
    const r = await useCases.withdraw(CYCLE_ID, RESIDENT_ID);
    expect(r.ok).toBe(true);
    expect(registrations.withdrawnAt?.toISOString()).toBe('2026-03-10T09:00:00.000Z');
  });
});

describe('CycleUseCases.remove', () => {
  /** A cycles repository whose consequences and existence are set per case. */
  const repoWith = (over: Partial<CycleRepository> = {}): CycleRepository =>
    Object.assign(new FakeCycles(), over);

  const useCasesWith = (cycles: CycleRepository) =>
    new CycleUseCases(
      cycles,
      new FakeRegistrations(),
      new FakeResidents(resident()),
      assignments,
      configProvider,
      fixedClock('2026-03-10T09:00:00Z'),
      new InMemoryCache(),
    );

  it('removes a period that has drawn nothing', async () => {
    let removed = false;
    const useCases = useCasesWith(
      repoWith({
        async remove() {
          removed = true;
          return true;
        },
      }),
    );

    const r = await useCases.remove(CYCLE_ID);
    expect(r.ok).toBe(true);
    expect(removed).toBe(true);
  });

  it('refuses a period that has handed out bays, and never calls the delete', async () => {
    let removed = false;
    const useCases = useCasesWith(
      repoWith({
        async consequences() {
          return { hasRun: true, assignments: 9 };
        },
        async remove() {
          removed = true;
          return true;
        },
      }),
    );

    const r = await useCases.remove(CYCLE_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INVALID_CYCLE_STATE');
      expect(r.error.message).toContain('9 bays');
    }
    // The point of the guard: the row survives the attempt.
    expect(removed).toBe(false);
  });

  it('refuses a period that does not exist', async () => {
    const useCases = useCasesWith(
      repoWith({
        async findById() {
          return null;
        },
      }),
    );

    const r = await useCases.remove(CYCLE_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });
});

describe('CycleUseCases.rename', () => {
  it('trims the new name', async () => {
    let got: string | null = null;
    const useCases = new CycleUseCases(
      Object.assign(new FakeCycles(), {
        async rename(_id: string, label: string) {
          got = label;
          return { ...cycle, label };
        },
      }),
      new FakeRegistrations(),
      new FakeResidents(resident()),
      assignments,
      configProvider,
      fixedClock('2026-03-10T09:00:00Z'),
      new InMemoryCache(),
    );

    const r = await useCases.rename(CYCLE_ID, '  2027-Q2  ');
    expect(r.ok).toBe(true);
    expect(got).toBe('2027-Q2');
  });

  it('refuses a name that is only whitespace', async () => {
    const useCases = new CycleUseCases(
      new FakeCycles(),
      new FakeRegistrations(),
      new FakeResidents(resident()),
      assignments,
      configProvider,
      fixedClock('2026-03-10T09:00:00Z'),
      new InMemoryCache(),
    );

    const r = await useCases.rename(CYCLE_ID, '   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
  });
});
