import { Logger } from '@aws-lambda-powertools/logger';
import { cryptoSeedSource, systemClock } from '../shared/clock';
import { getDb } from '../shared/db/connection';
import { DynamoDbCache, InMemoryCache } from '../shared/cache/dynamodb-cache';
import type { CachePort } from '../modules/allocation/application/ports';

import { ExecuteRun } from '../modules/allocation/application/execute-run';
import { CycleUseCases } from '../modules/allocation/application/cycle.use-cases';
import { ConfigUseCases } from '../modules/allocation/application/config.use-cases';
import { KyselyAllocationRepository } from '../modules/allocation/infrastructure/kysely-allocation.repository';
import { KyselyAllocationConfigProvider } from '../modules/allocation/infrastructure/kysely-allocation-config.provider';
import {
  KyselyAssignmentRepository,
  KyselyCycleRepository,
  KyselyRegistrationRepository,
} from '../modules/allocation/infrastructure/kysely-cycle.repository';

import { ResidentUseCases } from '../modules/residents/application/resident.use-cases';
import { VehicleUseCases } from '../modules/residents/application/vehicle.use-cases';
import { KyselyResidentRepository } from '../modules/residents/infrastructure/kysely-resident.repository';
import { KyselyVehicleRepository } from '../modules/residents/infrastructure/kysely-vehicle.repository';

import { SpotUseCases } from '../modules/inventory/application/spot.use-cases';
import { KyselySpotRepository } from '../modules/inventory/infrastructure/kysely-spot.repository';

import { DashboardUseCases } from '../modules/fairness/application/dashboard.use-cases';
import { KyselyFairnessReadModel } from '../modules/fairness/infrastructure/kysely-fairness.read-model';

import { IngestPlateRead } from '../modules/plates/application/ingest-plate-read';
import { PlateReadQueries } from '../modules/plates/application/list-plate-reads';
import { RequestCapture } from '../modules/plates/application/request-capture';
import { ResolvePlateRead } from '../modules/plates/application/resolve-plate-read';
import type { PlateLogger } from '../modules/plates/application/recognize-capture';
import { KyselyAccessEventRepository } from '../modules/plates/infrastructure/kysely-access-event.repository';
import { KyselyPlateReadRepository } from '../modules/plates/infrastructure/kysely-plate-read.repository';
import {
  KyselyPlateThresholdProvider,
  thresholdsFromEnv,
} from '../modules/plates/infrastructure/kysely-plate-thresholds.provider';
import { KyselyVehicleLookupRepository } from '../modules/plates/infrastructure/kysely-vehicle-lookup.repository';
import {
  DynamoCooldownStore,
  InMemoryCooldownStore,
} from '../modules/plates/infrastructure/dynamo-cooldown.store';
import { S3CaptureStorage } from '../modules/plates/infrastructure/s3-capture.storage';
import { UlidCaptureIdSource } from '../modules/plates/infrastructure/ulid-capture-id.source';

import {
  DynamoDbEventBus,
  NoopEventBus,
  type EventBus,
} from '../shared/events/dynamodb-event-bus';

/**
 * The only place in the codebase that calls `new` on an adapter (section 10, ADR-012).
 * Everything above this file depends on interfaces, which is what keeps the domain
 * testable without AWS and makes swapping RDS for Aurora an infrastructure-ring change.
 *
 * Built once per container and reused, so a warm invocation pays nothing for wiring.
 */
export interface AppContainer {
  readonly executeRun: ExecuteRun;
  readonly cycles: CycleUseCases;
  readonly config: ConfigUseCases;
  readonly residents: ResidentUseCases;
  /** The vehicle register, which the plate-recognition module reads through. */
  readonly vehicles: VehicleUseCases;
  readonly spots: SpotUseCases;
  readonly dashboard: DashboardUseCases;
  readonly allocationRepo: KyselyAllocationRepository;
  readonly assignmentRepo: KyselyAssignmentRepository;
  readonly residentRepo: KyselyResidentRepository;
  readonly bus: EventBus;

  // ------------------------------------------------------------- plates (M-7)
  /** The gate log, the review queue, one read's detail and the calibration metrics. */
  readonly plateReads: PlateReadQueries;
  /** The administrator's review. The only writer of `corrected_plate`. */
  readonly resolvePlateRead: ResolvePlateRead;
  /** `POST /captures`: a presigned PUT, and nothing synchronous behind it. */
  readonly captures: RequestCapture;
  /**
   * The stream consumer's use case. On the container rather than built in the handler so
   * the in-VPC function pays for the database connection once per container, the same way
   * every other entry point does.
   */
  readonly ingestPlateRead: IngestPlateRead;
}

/**
 * Powertools behind the application ring's own two-line logging port.
 *
 * The use cases log, because "nothing happened at the gate" has to be explainable, but
 * they must not import a logging library: that would put an infrastructure dependency in
 * the application ring and make every use-case test need a logger double with the right
 * shape. The port is three methods, and this is its one adapter.
 */
const powertools = new Logger({ serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? 'pacs' });

const containerLogger: PlateLogger = {
  info: (message, context) => powertools.info(message, context ?? {}),
  warn: (message, context) => powertools.warn(message, context ?? {}),
  error: (message, context) => powertools.error(message, context ?? {}),
};

let container: Promise<AppContainer> | undefined;

async function build(): Promise<AppContainer> {
  const db = await getDb();

  const cacheTable = process.env.CACHE_TABLE;
  const cache: CachePort = cacheTable ? new DynamoDbCache(cacheTable) : new InMemoryCache();

  const eventsTable = process.env.EVENTS_TABLE;
  const bus: EventBus = eventsTable ? new DynamoDbEventBus(eventsTable) : new NoopEventBus();

  const allocationRepo = new KyselyAllocationRepository(db);
  const configProvider = new KyselyAllocationConfigProvider(db);
  const cycleRepo = new KyselyCycleRepository(db);
  const registrationRepo = new KyselyRegistrationRepository(db);
  const assignmentRepo = new KyselyAssignmentRepository(db);
  const residentRepo = new KyselyResidentRepository(db);
  const vehicleRepo = new KyselyVehicleRepository(db);
  const spotRepo = new KyselySpotRepository(db);
  const fairnessRead = new KyselyFairnessReadModel(db);

  // ----------------------------------------------------------------- plates
  const capturesBucket = process.env.CAPTURES_BUCKET ?? null;
  const plateReadRepo = new KyselyPlateReadRepository(db);
  const accessEventRepo = new KyselyAccessEventRepository(db);
  const vehicleLookup = new KyselyVehicleLookupRepository(db);
  // The stored config wins over the environment; the environment is the cold-start
  // default before the first query. Section 8's whole point is that recalibrating does
  // not need a deploy.
  const plateThresholds = new KyselyPlateThresholdProvider(db, thresholdsFromEnv());
  const cooldown = cacheTable
    ? new DynamoCooldownStore(cacheTable)
    : new InMemoryCooldownStore();
  const captureStorage = new S3CaptureStorage();
  const cooldownSeconds = Number(process.env.PLATES_COOLDOWN_SECONDS ?? 30);

  return {
    allocationRepo,
    assignmentRepo,
    residentRepo,
    bus,
    executeRun: new ExecuteRun(allocationRepo, configProvider, systemClock, cryptoSeedSource, cache),
    config: new ConfigUseCases(configProvider, cache),
    cycles: new CycleUseCases(
      cycleRepo,
      registrationRepo,
      residentRepo,
      assignmentRepo,
      configProvider,
      systemClock,
      cache,
    ),
    residents: new ResidentUseCases(residentRepo, bus, systemClock),
    vehicles: new VehicleUseCases(vehicleRepo, residentRepo, systemClock),
    spots: new SpotUseCases(spotRepo, systemClock),
    dashboard: new DashboardUseCases(
      residentRepo,
      assignmentRepo,
      cycleRepo,
      fairnessRead,
      configProvider,
      cache,
      systemClock,
      registrationRepo,
    ),

    plateReads: new PlateReadQueries(
      plateReadRepo,
      accessEventRepo,
      vehicleLookup,
      captureStorage,
      cache,
      systemClock,
      capturesBucket,
    ),
    resolvePlateRead: new ResolvePlateRead(plateReadRepo, vehicleLookup, systemClock, cache),
    captures: new RequestCapture(
      captureStorage,
      new UlidCaptureIdSource(),
      systemClock,
      capturesBucket,
    ),
    ingestPlateRead: new IngestPlateRead(
      plateReadRepo,
      accessEventRepo,
      vehicleLookup,
      cooldown,
      plateThresholds,
      containerLogger,
      { cooldownSeconds: Number.isFinite(cooldownSeconds) ? cooldownSeconds : 30 },
    ),
  };
}

export function getContainer(): Promise<AppContainer> {
  container ??= build();
  return container;
}
