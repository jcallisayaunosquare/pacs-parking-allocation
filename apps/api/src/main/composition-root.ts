import { cryptoSeedSource, systemClock } from '../shared/clock';
import { getDb } from '../shared/db/connection';
import { DynamoDbCache, InMemoryCache } from '../shared/cache/dynamodb-cache';
import type { CachePort } from '../modules/allocation/application/ports';

import { WeightedLotteryDraw } from '../modules/allocation/domain/weighted-lottery-draw';
import { ExecuteRun } from '../modules/allocation/application/execute-run';
import { CycleUseCases } from '../modules/allocation/application/cycle.use-cases';
import { KyselyAllocationRepository } from '../modules/allocation/infrastructure/kysely-allocation.repository';
import {
  KyselyAssignmentRepository,
  KyselyCycleRepository,
  KyselyRegistrationRepository,
} from '../modules/allocation/infrastructure/kysely-cycle.repository';

import { ResidentUseCases } from '../modules/residents/application/resident.use-cases';
import { KyselyResidentRepository } from '../modules/residents/infrastructure/kysely-resident.repository';

import { SpotUseCases } from '../modules/inventory/application/spot.use-cases';
import { KyselySpotRepository } from '../modules/inventory/infrastructure/kysely-spot.repository';

import { DashboardUseCases } from '../modules/fairness/application/dashboard.use-cases';
import { KyselyFairnessReadModel } from '../modules/fairness/infrastructure/kysely-fairness.read-model';

import {
  DynamoDbEventBus,
  NoopEventBus,
  type EventBus,
} from '../shared/events/dynamodb-event-bus';

/**
 * The only place in the codebase that calls `new` on an adapter (§10, ADR-012).
 * Everything above this file depends on interfaces, which is what keeps the domain
 * testable without AWS and makes swapping RDS for Aurora an infrastructure-ring change.
 *
 * Built once per container and reused, so a warm invocation pays nothing for wiring.
 */
export interface AppContainer {
  readonly executeRun: ExecuteRun;
  readonly cycles: CycleUseCases;
  readonly residents: ResidentUseCases;
  readonly spots: SpotUseCases;
  readonly dashboard: DashboardUseCases;
  readonly allocationRepo: KyselyAllocationRepository;
  readonly assignmentRepo: KyselyAssignmentRepository;
  readonly residentRepo: KyselyResidentRepository;
  readonly bus: EventBus;
}

let container: Promise<AppContainer> | undefined;

async function build(): Promise<AppContainer> {
  const db = await getDb();

  const cacheTable = process.env.CACHE_TABLE;
  const cache: CachePort = cacheTable ? new DynamoDbCache(cacheTable) : new InMemoryCache();

  const eventsTable = process.env.EVENTS_TABLE;
  const bus: EventBus = eventsTable ? new DynamoDbEventBus(eventsTable) : new NoopEventBus();

  const allocationRepo = new KyselyAllocationRepository(db);
  const cycleRepo = new KyselyCycleRepository(db);
  const registrationRepo = new KyselyRegistrationRepository(db);
  const assignmentRepo = new KyselyAssignmentRepository(db);
  const residentRepo = new KyselyResidentRepository(db);
  const spotRepo = new KyselySpotRepository(db);
  const fairnessRead = new KyselyFairnessReadModel(db);

  return {
    allocationRepo,
    assignmentRepo,
    residentRepo,
    bus,
    executeRun: new ExecuteRun(
      allocationRepo,
      new WeightedLotteryDraw(),
      systemClock,
      cryptoSeedSource,
      cache,
    ),
    cycles: new CycleUseCases(
      cycleRepo,
      registrationRepo,
      residentRepo,
      assignmentRepo,
      systemClock,
      cache,
    ),
    residents: new ResidentUseCases(residentRepo, bus, systemClock),
    spots: new SpotUseCases(spotRepo, systemClock),
    dashboard: new DashboardUseCases(
      residentRepo,
      assignmentRepo,
      cycleRepo,
      fairnessRead,
      cache,
      systemClock,
    ),
  };
}

export function getContainer(): Promise<AppContainer> {
  container ??= build();
  return container;
}
