/**
 * The API, in memory, for working on the interface.
 *
 *   node scripts/local-api.mjs          # listens on 4300, the dev apiBaseUrl
 *
 * Why this exists: every screen in `apps/web` reads the real contract, and the only
 * other implementation of it is a VPC Lambda talking to RDS. So reviewing a layout
 * change meant deploying, or it meant nothing. This serves the same shapes
 * (`packages/contracts/openapi.yaml`, mirrored in `apps/web/src/app/data/dto.ts`) from
 * a seeded object graph, so the whole flow — register, close, draw, allocate, release —
 * can be driven in a browser with no AWS at all.
 *
 * It is a fixture, not a second implementation: no SQL, no fairness arithmetic beyond
 * what a screen needs to look truthful, and the state dies with the process. When a
 * shape here disagrees with the YAML, the YAML wins and this file is the bug.
 *
 * Authorisation is a stub on purpose. The browser sends `Bearer local.<base64 json>`
 * from the dev sign-in stub (`core/auth/cognito.service.ts`, behind
 * `environment.localAuth`); this reads the roles out of it and never verifies a
 * signature. Nothing about it is deployed — the production build replaces the
 * environment file that turns the stub on, and this script is not in the Lambda bundle.
 */
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const docsHtml = readFileSync(new URL('../src/main/docs.html', import.meta.url), 'utf8');
const openapiYaml = readFileSync(new URL('../../../packages/contracts/openapi.yaml', import.meta.url), 'utf8');

const PORT = Number(process.env.PORT ?? 4300);
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------------- state */

const iso = (d) => new Date(d).toISOString();
const now = () => Date.now();

/** A fixed seed, so a screenshot taken twice shows the same lot. */
let seq = 1;
const nextId = () => `0000${seq++}`.slice(-5);

const FIRST = ['Ana', 'Luis', 'Marta', 'Diego', 'Sofia', 'Pablo', 'Elena', 'Hugo',
  'Carmen', 'Mateo', 'Lucia', 'Javier', 'Rosa', 'Andres', 'Paula', 'Tomas',
  'Irene', 'Victor', 'Nuria', 'Alberto', 'Clara', 'Ruben', 'Silvia', 'Oscar'];
const LAST = ['Rojas', 'Quispe', 'Mendoza', 'Villarroel', 'Arce', 'Flores', 'Camacho',
  'Terceros', 'Vaca', 'Zambrana', 'Suarez', 'Ortiz'];

/*
 * More residents than bays, deliberately. A building where everyone who registers gets
 * a bay has no waitlist, no order to read and nothing for the product to be about, so a
 * fixture without scarcity would flatter every screen that exists to handle it.
 */
const residents = [];
for (let i = 0; i < 72; i += 1) {
  const fullName = `${FIRST[i % FIRST.length]} ${LAST[(i + Math.floor(i / FIRST.length)) % LAST.length]}`;
  const unit = `${Math.floor(i / 4) + 1}0${(i % 4) + 1}`;
  residents.push({
    id: `r-${nextId()}`,
    email: `${fullName.toLowerCase().replace(/\s+/g, '.')}.${i}@example.test`,
    fullName,
    unitNumber: unit,
    isEligible: i % 11 !== 0,
    ineligibleReason: i % 11 === 0 ? 'ADMIN_ACCOUNT' : null,
    needsAccessibleSpot: i === 5,
    externalSubject: `sub-${i}`,
    currentSpotCode: null,
    createdAt: iso(now() - (900 - i * 11) * DAY),
    deactivatedAt: null,
    /* The register row an administrator works in; waiting time is derived, never stored
       as a counter (PRODUCT.md), so the anchor is what is kept. Spread across two and a
       half years so the board has a real spread of waits to rank. */
    anchorAt: now() - (880 - i * 12) * DAY,
    servedCount: i % 5 === 0 ? 0 : (i % 3) + 1,
  });
}

/** The resident the dev stub signs in as, so "My parking" is never an empty screen. */
const ME = residents[2];

/*
 * The same 56 bays, with the same codes, as the lot layout the web app generates in
 * `apps/web/src/app/data/seed-lot.repository.ts`: one level B1, four aisles of fourteen,
 * `B1-A01` through `B1-D14`. The direction contract's ONE ADDRESSABLE SPACE raise means
 * a board row and a bay on the plan have to be the same object — two fixtures that
 * disagree on the codes make that impossible to see, however correct each one is alone.
 */
const AISLES = ['A', 'B', 'C', 'D'];
const BAYS_PER_AISLE = 14;
const spots = [];
for (let i = 0; i < 56; i += 1) {
  const level = 'B1';
  const aisle = AISLES[Math.floor(i / BAYS_PER_AISLE)];
  spots.push({
    id: `s-${nextId()}`,
    spotCode: `${level}-${aisle}${`0${(i % BAYS_PER_AISLE) + 1}`.slice(-2)}`,
    level,
    type: i === 0 || i === 28 ? 'ACCESSIBLE' : i % 17 === 0 ? 'EV' : 'STANDARD',
    isActive: i !== 41,
    notes: i === 41 ? 'Column damage, out of service' : null,
    createdAt: iso(now() - 500 * DAY),
  });
}

/**
 * Quarters relative to today, not to a year written into the file.
 *
 * A fixed 2026 calendar drifts: the period marked REGISTRATION_OPEN kept a registration
 * window that had already passed, so the dashboard said "Registration is open" and
 * "Registration has closed" in the same breath - the state came from the fixture and
 * the sentence from the dates. Offset 0 is the quarter we are in now.
 */
const quarter = (offset) => {
  const today = new Date();
  const start = new Date(
    Date.UTC(today.getUTCFullYear(), Math.floor(today.getUTCMonth() / 3) * 3 + offset * 3, 1),
  );
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 3);
  end.setUTCDate(0);
  return { start, end };
};

const cycles = [-1, 0, 1, 2].map((offset, i) => {
  const { start, end } = quarter(offset);
  // Behind us, in effect, taking entries, and not yet opened.
  const states = ['CLOSED', 'ACTIVE', 'REGISTRATION_OPEN', 'DRAFT'];
  return {
    id: `c-${nextId()}`,
    label: `${start.getUTCFullYear()} Q${Math.floor(start.getUTCMonth() / 3) + 1}`,
    startsOn: iso(start).slice(0, 10),
    endsOn: iso(end).slice(0, 10),
    state: states[i],
    /*
     * The open period's window has to straddle today, or the screen's date copy and its
     * state contradict each other. The others keep the building's ordinary rule: three
     * weeks before the quarter starts, closing one week before.
     */
    registrationOpensAt: offset === 1 ? iso(now() - 5 * DAY) : iso(start.getTime() - 21 * DAY),
    registrationClosesAt: offset === 1 ? iso(now() + 9 * DAY) : iso(start.getTime() - 7 * DAY),
  };
});

/** Registrations, keyed by cycle id. The open cycle has most of the building in it. */
const registrations = new Map(cycles.map((c) => [c.id, new Set()]));
const openCycle = () => cycles.find((c) => c.state === 'REGISTRATION_OPEN');
const activeCycle = () => cycles.find((c) => c.state === 'ACTIVE');
for (const r of residents.slice(0, 64)) registrations.get(openCycle().id).add(r.id);

/** The active period: every active bay is held, and the rest of the register waits. */
const assignments = new Map();
const eligible = residents.filter((r) => r.isEligible);
eligible.slice(0, 55).forEach((r, i) => {
  const spot = spots.filter((s) => s.isActive)[i];
  r.currentSpotCode = spot.spotCode;
  assignments.set(r.id, {
    spotCode: spot.spotCode,
    level: spot.level,
    type: spot.type,
    validFrom: `${activeCycle().startsOn}T00:00:00.000Z`,
    validUntil: `${activeCycle().endsOn}T23:59:59.000Z`,
    state: 'ACTIVE',
  });
});
const waitlist = eligible.slice(55).map((r) => r.id);

let config = {
  version: 4,
  allocationDurationMonths: 3,
  earlyWaitingBiasHours: 720,
  waitQuantumMinutes: 60,
  absenceResetPeriods: 1,
  totalBays: 56,
};
const configHistory = [
  { ...config, changedAt: iso(now() - 40 * DAY), changedBy: 'admin@example.test' },
  { ...config, version: 3, earlyWaitingBiasHours: 480, changedAt: iso(now() - 140 * DAY), changedBy: 'admin@example.test' },
];

const runs = [];

/* --------------------------------------------------------------- the draw */

const waitHours = (r) => Math.max(0, Math.round((now() - r.anchorAt) / HOUR));
const effectiveWait = (r) =>
  waitHours(r) + (r.servedCount === 0 ? config.earlyWaitingBiasHours : 0);

/**
 * The ordering of PRODUCT.md, kept deliberately thin: longest effective wait, then
 * fewest past allocations, then a token a resident can recompute. The real one lives in
 * `src/modules/allocation/domain/priority-key.ts` and is tested there; this only has to
 * rank a fixture the same way so the explanation screen reads correctly.
 */
const token = (seedHex, runId, residentId) =>
  createHash('sha256').update(`${seedHex}:${runId}:${residentId}`).digest('hex');

function executeRun(cycle) {
  const runId = randomUUID();
  const seedHex = createHash('sha256').update(runId).digest('hex').slice(0, 16);
  const entered = [...(registrations.get(cycle.id) ?? [])]
    .map((id) => residents.find((r) => r.id === id))
    .filter(Boolean);

  const ranked = entered
    .map((r) => ({
      r,
      eligible: r.isEligible,
      wait: waitHours(r),
      eff: effectiveWait(r),
      tok: token(seedHex, runId, r.id),
    }))
    .sort((a, b) => {
      if (!a.eligible !== !b.eligible) return a.eligible ? -1 : 1;
      if (b.eff !== a.eff) return b.eff - a.eff;
      if (a.r.servedCount !== b.r.servedCount) return a.r.servedCount - b.r.servedCount;
      return a.tok < b.tok ? -1 : 1;
    });

  const free = spots.filter((s) => s.isActive);
  const items = [];
  let given = 0;
  ranked.forEach((row, i) => {
    const outcome = !row.eligible ? 'SKIPPED' : given < free.length ? 'ASSIGNED' : 'WAITLISTED';
    const spot = outcome === 'ASSIGNED' ? free[given++] : null;
    items.push({
      residentId: row.r.id,
      unit: row.r.unitNumber,
      anchorAt: iso(row.r.anchorAt),
      waitHours: row.wait,
      effectiveWaitHours: row.eff,
      biasApplied: row.r.servedCount === 0,
      firstTimeParticipant: row.r.servedCount === 0,
      servedCount: row.r.servedCount,
      rank: i + 1,
      outcome,
      spotCode: spot?.spotCode ?? null,
      decidedBy: !row.eligible
        ? 'WAITING_TIME'
        : row.r.servedCount === 0
          ? 'EARLY_WAITING_BIAS'
          : 'WAITING_TIME',
      explanation:
        outcome === 'SKIPPED'
          ? 'Not eligible for this period'
          : outcome === 'ASSIGNED'
            ? `Ranked ${i + 1} of ${ranked.length} on ${row.eff} effective wait hours`
            : `Ranked ${i + 1}; the bays ran out at ${free.length}`,
    });
  });

  const run = {
    runId,
    cycleId: cycle.id,
    cycleLabel: cycle.label,
    state: items.length === 0 ? 'COMPLETED_EMPTY' : 'COMPLETED',
    algorithmVersion: 'wait-order-1',
    configVersion: config.version,
    randomSeed: Number.parseInt(seedHex.slice(0, 8), 16),
    randomSeedHex: seedHex,
    entrants: items.length,
    spots: free.length,
    assigned: given,
    waitlisted: items.filter((i) => i.outcome === 'WAITLISTED').length,
    startedAt: iso(now()),
    finishedAt: iso(now() + 700),
    decidedAt: iso(now()),
    errorDetail: null,
    items,
  };
  runs.unshift(run);

  // Commit it: the register now shows what the board shows.
  assignments.clear();
  waitlist.length = 0;
  for (const r of residents) r.currentSpotCode = null;
  for (const it of items) {
    const r = residents.find((x) => x.id === it.residentId);
    if (it.outcome === 'ASSIGNED') {
      r.currentSpotCode = it.spotCode;
      r.servedCount += 1;
      r.anchorAt = now();
      const spot = spots.find((s) => s.spotCode === it.spotCode);
      assignments.set(r.id, {
        spotCode: spot.spotCode,
        level: spot.level,
        type: spot.type,
        validFrom: `${cycle.startsOn}T00:00:00.000Z`,
        validUntil: `${cycle.endsOn}T23:59:59.000Z`,
        state: 'ACTIVE',
      });
    } else if (it.outcome === 'WAITLISTED') {
      waitlist.push(r.id);
    }
  }
  cycle.state = 'ACTIVE';
  for (const c of cycles) if (c !== cycle && c.state === 'ACTIVE') c.state = 'CLOSED';
  return run;
}

/* ------------------------------------------------------------------ views */

const toRunResult = (run) => ({
  runId: run.runId,
  cycleId: run.cycleId,
  state: run.state,
  algorithmVersion: run.algorithmVersion,
  randomSeed: run.randomSeed,
  entrants: run.entrants,
  spots: run.spots,
  assigned: run.assigned,
  waitlisted: run.waitlisted,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  errorDetail: run.errorDetail,
});

const toRunSummary = (run) => ({
  runId: run.runId,
  cycleId: run.cycleId,
  cycleLabel: run.cycleLabel,
  state: run.state,
  algorithmVersion: run.algorithmVersion,
  configVersion: run.configVersion,
  randomSeedHex: run.randomSeedHex,
  decidedAt: run.decidedAt,
  entrants: run.entrants,
  spots: run.spots,
  assigned: run.assigned,
  finishedAt: run.finishedAt,
  errorDetail: run.errorDetail,
});

const publicResident = (r) => ({
  id: r.id,
  email: r.email,
  fullName: r.fullName,
  unitNumber: r.unitNumber,
  isEligible: r.isEligible,
  ineligibleReason: r.ineligibleReason,
  needsAccessibleSpot: r.needsAccessibleSpot,
  externalSubject: r.externalSubject,
  currentSpotCode: r.currentSpotCode,
  createdAt: r.createdAt,
  deactivatedAt: r.deactivatedAt,
  // The detail view carries them; the list route does not need to, and does not pay for it.
  vehicles: liveVehicles(r.id),
});

const historyOf = (residentId) =>
  runs
    .flatMap((run) => {
      const it = run.items.find((i) => i.residentId === residentId);
      if (!it) return [];
      return [{
        cycle: run.cycleLabel ?? run.cycleId,
        result: it.outcome,
        spotCode: it.spotCode,
        position: it.outcome === 'WAITLISTED' ? it.rank - run.assigned : null,
        effectiveWaitHours: it.effectiveWaitHours,
        servedCountAtDraw: it.servedCount,
        biasApplied: it.biasApplied,
        finalRank: it.rank,
        recordedAt: run.decidedAt ?? run.startedAt,
      }];
    })
    // Two closed periods of seeded history, so History is never a blank screen on boot.
    .concat(
      runs.length > 0
        ? []
        : [
            {
              cycle: cycles[0].label,
              result: 'ASSIGNED',
              spotCode: 'B1-A07',
              position: null,
              effectiveWaitHours: 2160,
              servedCountAtDraw: 1,
              biasApplied: false,
              finalRank: 7,
              recordedAt: iso(now() - 120 * DAY),
            },
            {
              cycle: '2025 Q4',
              result: 'WAITLISTED',
              spotCode: null,
              position: 3,
              effectiveWaitHours: 980,
              servedCountAtDraw: 0,
              biasApplied: true,
              finalRank: 17,
              recordedAt: iso(now() - 210 * DAY),
            },
          ],
    );

function dashboard(r) {
  const pos = waitlist.indexOf(r.id);
  const next = openCycle() ?? cycles.find((c) => c.state === 'DRAFT') ?? null;
  return {
    resident: { id: r.id, fullName: r.fullName, unit: r.unitNumber, isEligible: r.isEligible },
    assignment: assignments.get(r.id) ?? null,
    waitlist: pos >= 0 ? { position: pos + 1 } : null,
    fairness: {
      anchorAt: iso(r.anchorAt),
      waitingHours: waitHours(r),
      effectiveWaitHours: effectiveWait(r),
      servedCount: r.servedCount,
      biasApplied: r.servedCount === 0,
      firstTimeParticipant: r.servedCount === 0,
      explanation:
        r.servedCount === 0
          ? 'Never allocated, so the early-waiting bias is added to the wait'
          : `Allocated ${r.servedCount} time(s); the wait has run since the last one ended`,
    },
    nextCycle: next,
    // The screen cannot work this out for itself: an entry is a row the server holds.
    registeredForNextCycle: next ? (registrations.get(next.id)?.has(r.id) ?? false) : false,
    recentHistory: historyOf(r.id).slice(0, 5),
  };
}

function fairnessMetrics() {
  const waits = residents.map(waitHours);
  const dist = new Map();
  for (const r of residents) dist.set(r.servedCount, (dist.get(r.servedCount) ?? 0) + 1);
  return {
    residents: residents.length,
    averageWaitHours: Math.round(waits.reduce((a, b) => a + b, 0) / waits.length),
    maxWaitHours: Math.max(...waits),
    neverServed: residents.filter((r) => r.servedCount === 0).length,
    distribution: [...dist.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([servedCount, n]) => ({ servedCount, residents: n })),
  };
}

/* ----------------------------------------------------------------- routing */

/** The stub principal, read out of the unverified dev token. */
function principalOf(req) {
  const header = req.headers.authorization ?? '';
  const raw = header.replace(/^Bearer\s+/i, '');
  if (!raw.startsWith('local.')) return null;
  try {
    const claims = JSON.parse(Buffer.from(raw.slice(6), 'base64url').toString('utf8'));
    const roles = Array.isArray(claims.roles) ? claims.roles : ['RESIDENT'];
    const resident = roles.includes('ADMIN')
      ? null
      : residents.find((r) => r.id === claims.residentId) ?? ME;
    return { subject: claims.sub ?? 'local-sub', email: claims.email ?? null, roles, resident };
  } catch {
    return null;
  }
}

const ROUTES = [];
const on = (method, pattern, handler) => {
  const names = [];
  const rx = new RegExp(
    `^${pattern.replace(/\{(\w+)\}/g, (_m, n) => (names.push(n), '([^/]+)'))}$`,
  );
  ROUTES.push({ method, rx, names, handler });
};

const ok = (body = null, status = 200) => ({ status, body });
const err = (status, code, message) => ({ status, body: { code, message } });

const needAdmin = (p) => (p?.roles.includes('ADMIN') ? null : err(403, 'FORBIDDEN', 'Administrators only'));
const needResident = (p) =>
  p?.resident ? null : err(403, 'FORBIDDEN', 'This is a resident route');

on('GET', '/health', () => ok({ status: 'ok', stub: true }));

on('GET', '/me', (_q, _b, p) =>
  p
    ? ok({ subject: p.subject, email: p.email, roles: p.roles, resident: p.resident ? publicResident(p.resident) : null })
    : err(401, 'UNAUTHENTICATED', 'No token'));

on('GET', '/me/dashboard', (_q, _b, p) => needResident(p) ?? ok(dashboard(p.resident)));

on('GET', '/me/history', (q, _b, p) => {
  const bad = needResident(p);
  if (bad) return bad;
  const limit = Number(q.get('limit') ?? 20);
  return ok({ items: historyOf(p.resident.id).slice(0, limit), nextCursor: null });
});

on('POST', '/me/assignment/release', (_q, _b, p) => {
  const bad = needResident(p);
  if (bad) return bad;
  if (!assignments.has(p.resident.id)) return err(409, 'NO_ASSIGNMENT', 'Nothing to release');
  assignments.delete(p.resident.id);
  p.resident.currentSpotCode = null;
  const promoted = waitlist.shift() ?? null;
  if (promoted) {
    const r = residents.find((x) => x.id === promoted);
    r.currentSpotCode = spots[0].spotCode;
  }
  return ok({ promotedResidentId: promoted });
});

on('POST', '/cycles/{id}/registrations', (_q, _b, p, params) => {
  const bad = needResident(p);
  if (bad) return bad;
  const set = registrations.get(params.id);
  if (!set) return err(404, 'NOT_FOUND', 'No such period');
  set.add(p.resident.id);
  return ok(null, 204);
});

on('DELETE', '/cycles/{id}/registrations/me', (_q, _b, p, params) => {
  const bad = needResident(p);
  if (bad) return bad;
  registrations.get(params.id)?.delete(p.resident.id);
  return ok(null, 204);
});

on('GET', '/residents', (q, _b, p) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const search = (q.get('search') ?? '').toLowerCase();
  const sort = q.get('sort') ?? 'fullName';
  const dir = q.get('direction') ?? 'asc';
  const limit = Number(q.get('limit') ?? 15);
  const offset = Number(q.get('cursor') ?? 0);
  let rows = residents.filter(
    (r) =>
      !search ||
      r.fullName.toLowerCase().includes(search) ||
      r.unitNumber.includes(search) ||
      r.email.toLowerCase().includes(search),
  );
  rows = [...rows].sort((a, b) => {
    const pick = (r) => (sort === 'unitNumber' ? r.unitNumber : sort === 'email' ? r.email : r.fullName);
    return (dir === 'desc' ? -1 : 1) * String(pick(a)).localeCompare(String(pick(b)));
  });
  const page = rows.slice(offset, offset + limit);
  return ok({
    items: page.map(publicResident),
    nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
    total: rows.length,
  });
});

on('POST', '/residents', (_q, body, p) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  if (!body?.email || !body?.fullName || !body?.unitNumber)
    return err(422, 'VALIDATION', 'email, fullName and unitNumber are required');
  if (residents.some((r) => r.email === body.email))
    return err(409, 'CONFLICT', 'That email is already on the register');
  const r = {
    id: `r-${nextId()}`,
    email: body.email,
    fullName: body.fullName,
    unitNumber: body.unitNumber,
    isEligible: true,
    ineligibleReason: null,
    needsAccessibleSpot: Boolean(body.needsAccessibleSpot),
    externalSubject: null,
    currentSpotCode: null,
    createdAt: iso(now()),
    deactivatedAt: null,
    anchorAt: now(),
    servedCount: 0,
    vehicles: [],
  };
  residents.push(r);
  return ok(publicResident(r), 201);
});

on('GET', '/residents/{id}', (_q, _b, p, params) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const r = residents.find((x) => x.id === params.id);
  return r ? ok(publicResident(r)) : err(404, 'NOT_FOUND', 'No such resident');
});

on('PATCH', '/residents/{id}', (_q, body, p, params) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const r = residents.find((x) => x.id === params.id);
  if (!r) return err(404, 'NOT_FOUND', 'No such resident');
  for (const k of ['fullName', 'unitNumber', 'email', 'needsAccessibleSpot'])
    if (body?.[k] !== undefined) r[k] = body[k];
  return ok(publicResident(r));
});

on('PATCH', '/residents/{id}/eligibility', (_q, body, p, params) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const r = residents.find((x) => x.id === params.id);
  if (!r) return err(404, 'NOT_FOUND', 'No such resident');
  r.isEligible = Boolean(body?.isEligible);
  r.ineligibleReason = r.isEligible ? null : (body?.reason ?? 'MANUAL');
  return ok(publicResident(r));
});

on('PATCH', '/residents/{id}/participation-start', (_q, body, p, params) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const r = residents.find((x) => x.id === params.id);
  if (!r) return err(404, 'NOT_FOUND', 'No such resident');
  r.anchorAt = new Date(body?.participationStartedAt ?? now()).getTime();
  return ok(publicResident(r));
});

on('DELETE', '/residents/{id}', (_q, _b, p, params) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const r = residents.find((x) => x.id === params.id);
  if (!r) return err(404, 'NOT_FOUND', 'No such resident');
  // "Remove", never delete: the allocation history has to stay explainable.
  r.deactivatedAt = iso(now());
  r.isEligible = false;
  r.ineligibleReason = 'REMOVED';
  return ok(null, 204);
});

/* --------------------------------------------------------------- vehicles */

/**
 * The same folding rule as `src/modules/residents/domain/vehicle.ts`: strip diacritics,
 * drop separators, uppercase, then O/Q to zero and I to one. Repeated here rather than
 * imported because this file is plain ESM with no build step — if the two ever disagree,
 * the domain is right and this is the bug.
 */
const normalizePlate = (raw) => {
  const stripped = String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^0-9a-zA-Z]/g, '')
    .toUpperCase();
  return [...stripped].map((c) => (c === 'O' || c === 'Q' ? '0' : c === 'I' ? '1' : c)).join('');
};

const vehicles = [];
const MAKES = [
  ['Toyota', 'Corolla', 'white'],
  ['Nissan', 'Versa', 'grey'],
  ['Suzuki', 'Vitara', 'red'],
  ['Hyundai', 'Tucson', 'black'],
  ['Kia', 'Rio', 'blue'],
];
residents.slice(0, 40).forEach((r, i) => {
  const [make, model, colour] = MAKES[i % MAKES.length];
  const display = `${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i + 7) % 26))}${String.fromCharCode(65 + ((i + 13) % 26))}-${`00${i + 101}`.slice(-3)}`;
  vehicles.push({
    id: `v-${nextId()}`,
    residentId: r.id,
    plate: normalizePlate(display),
    plateDisplay: display,
    make,
    model,
    year: 2014 + (i % 11),
    colour,
    notes: null,
    photos: [],
    isActive: true,
    createdAt: iso(now() - (200 - i) * DAY),
    updatedAt: iso(now() - (200 - i) * DAY),
  });
});

/** An ADMIN acts on anyone's; a RESIDENT only on their own, and a mismatch is a 404. */
const vehicleScope = (p, id) => {
  if (!p) return { bad: err(401, 'UNAUTHENTICATED', 'No token') };
  if (p.roles.includes('ADMIN')) {
    return residents.some((r) => r.id === id)
      ? { residentId: id }
      : { bad: err(404, 'NOT_FOUND', 'No such resident') };
  }
  // Not 403: confirming the record exists would turn this into a way of enumerating ids.
  return p.resident?.id === id
    ? { residentId: id }
    : { bad: err(404, 'NOT_FOUND', 'No such resident') };
};

// A declaration, not a const: `publicResident` above is defined before this point and
// calls it, and a const arrow would still be in its temporal dead zone there.
function liveVehicles(residentId) {
  return vehicles.filter((v) => v.residentId === residentId && v.isActive);
}

on('GET', '/residents/{id}/vehicles', (_q, _b, p, params) => {
  const scope = vehicleScope(p, params.id);
  return scope.bad ?? ok({ items: liveVehicles(scope.residentId) });
});

on('POST', '/residents/{id}/vehicles', (_q, body, p, params) => {
  const scope = vehicleScope(p, params.id);
  if (scope.bad) return scope.bad;
  const plate = normalizePlate(body?.plate ?? '');
  if (!/^[A-Z0-9]{2,20}$/.test(plate))
    return err(422, 'VALIDATION', 'A plate is 2 to 20 letters and digits');
  if (vehicles.some((v) => v.isActive && v.plate === plate))
    return err(409, 'CONFLICT', 'That plate is already registered in this building');
  const v = {
    id: `v-${nextId()}`,
    residentId: scope.residentId,
    plate,
    plateDisplay: String(body.plate).trim().toUpperCase(),
    make: body?.make ?? null,
    model: body?.model ?? null,
    year: body?.year ?? null,
    colour: body?.colour ?? null,
    notes: body?.notes ?? null,
    photos: body?.photos ?? [],
    isActive: true,
    createdAt: iso(now()),
    updatedAt: iso(now()),
  };
  vehicles.push(v);
  return ok(v, 201);
});

on('PATCH', '/residents/{id}/vehicles/{vehicleId}', (_q, body, p, params) => {
  const scope = vehicleScope(p, params.id);
  if (scope.bad) return scope.bad;
  const v = vehicles.find(
    (x) => x.id === params.vehicleId && x.residentId === scope.residentId && x.isActive,
  );
  if (!v) return err(404, 'NOT_FOUND', 'No such vehicle');
  if (body?.plate !== undefined) {
    const plate = normalizePlate(body.plate);
    if (!/^[A-Z0-9]{2,20}$/.test(plate))
      return err(422, 'VALIDATION', 'A plate is 2 to 20 letters and digits');
    if (vehicles.some((x) => x.isActive && x.plate === plate && x.id !== v.id))
      return err(409, 'CONFLICT', 'That plate is already registered in this building');
    v.plate = plate;
    v.plateDisplay = String(body.plate).trim().toUpperCase();
  }
  for (const k of ['make', 'model', 'year', 'colour', 'notes', 'photos'])
    if (body?.[k] !== undefined) v[k] = body[k];
  v.updatedAt = iso(now());
  return ok(v);
});

on('DELETE', '/residents/{id}/vehicles/{vehicleId}', (_q, _b, p, params) => {
  const scope = vehicleScope(p, params.id);
  if (scope.bad) return scope.bad;
  const v = vehicles.find(
    (x) => x.id === params.vehicleId && x.residentId === scope.residentId && x.isActive,
  );
  if (!v) return err(404, 'NOT_FOUND', 'No such vehicle');
  // Deactivated, not dropped: a past gate event still resolves to a car.
  v.isActive = false;
  v.updatedAt = iso(now());
  return ok(null, 204);
});

on('GET', '/vehicles/by-plate/{plate}', (_q, _b, p, params) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const plate = normalizePlate(params.plate);
  const v = vehicles.find((x) => x.isActive && x.plate === plate);
  return v ? ok(v) : err(404, 'NOT_FOUND', 'No vehicle with that plate');
});

/* ----------------------------------------------------------------- plates */

/**
 * The gate log, seeded (M-7).
 *
 * The reads are built FROM the vehicle seed above rather than from fresh strings, which
 * is the whole point of having them in one file: a matched read has to name a car that is
 * really in the register, or the screen shows a resident and a bay that the register page
 * would deny. The two unmatched plates are deliberately outside it.
 *
 * Mix on purpose: most reads are clean allows, a few are refusals with a real reason, and
 * five sit in the review queue — one per reason an administrator will actually meet.
 * A fixture with no review queue would flatter the one screen that exists to work it.
 */
const CAMERAS = ['gate-north', 'gate-south'];

/** Crockford base32, like the ULIDs the real `POST /captures` mints. */
const captureId = (at, n) => {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = '';
  let v = at;
  for (let i = 0; i < 10; i += 1) {
    t = A[v % 32] + t;
    v = Math.floor(v / 32);
  }
  // Deterministic tail, so a screenshot taken twice shows the same ids.
  let tail = '';
  for (let i = 0; i < 16; i += 1) tail += A[(n * 31 + i * 17) % 32];
  return t + tail;
};

const fuse = (confidence, quality) =>
  Number((confidence * (0.6 + 0.4 * (quality ?? 1))).toFixed(4));

const plateReads = [];
const accessEvents = [];

/**
 * One read, with its decision derived from the same table the domain uses
 * (`src/modules/plates/domain/access-decision.ts`). Kept thin: the stub only has to be
 * truthful about the shapes and about which combinations can occur, not to re-implement
 * the rule.
 */
function seedRead(i, over) {
  const at = now() - (i * 47 + 11) * 60_000;
  const cameraId = CAMERAS[i % CAMERAS.length];
  const confidence = over.confidence ?? 0.9 + ((i % 9) / 100);
  const quality = over.quality ?? 0.7 + ((i % 7) / 40);
  const fused = fuse(confidence, quality);
  const vehicle = over.vehicle ?? null;
  const resident = vehicle ? residents.find((r) => r.id === vehicle.residentId) : null;

  const read = {
    id: `pl-${nextId()}`,
    captureId: captureId(at, i),
    cameraId,
    capturedAt: iso(at),
    rawText: over.rawText ?? (vehicle ? vehicle.plateDisplay : over.plate),
    plate: over.plate ?? (vehicle ? vehicle.plate : null),
    registeredPlate: vehicle ? vehicle.plate : null,
    confidence: Number(confidence.toFixed(4)),
    quality: Number(quality.toFixed(4)),
    fused,
    status: over.status,
    matchKind: over.matchKind ?? (vehicle ? 'EXACT' : 'NONE'),
    matchDistance: over.matchDistance ?? (vehicle ? 0 : null),
    vehicleId: vehicle?.id ?? null,
    residentId: resident?.id ?? null,
    residentName: resident?.fullName ?? null,
    spotCode: resident?.currentSpotCode ?? null,
    decision: over.decision ?? null,
    reason: over.reason,
    imageKey: `raw/${cameraId}/${iso(at).slice(0, 10).replace(/-/g, '/')}/${captureId(at, i)}.jpg`,
    cropKey: null,
    engine: 'rekognition-detect-text',
    engineVersion: iso(at).slice(0, 7),
    latencyMs: 480 + ((i * 37) % 320),
    needsReview: over.status === 'REVIEW',
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
    correctedPlate: null,
    candidates: over.candidates ?? [
      {
        plate: over.plate ?? vehicle?.plate ?? '',
        raw: over.rawText ?? vehicle?.plateDisplay ?? '',
        confidence: Number(confidence.toFixed(4)),
        score: Number((confidence * 100 + 134).toFixed(2)),
      },
    ],
  };
  plateReads.push(read);

  // An UNREADABLE or DISCARDED read produces no access event, which is the rule rather
  // than an omission: a frame nobody could read is not a refused entry, and a log full of
  // refusals belonging to nobody makes the denial count meaningless.
  if (read.decision !== null) {
    accessEvents.push({
      id: `ae-${nextId()}`,
      plateReadId: read.id,
      captureId: read.captureId,
      plate: read.plate ?? '',
      vehicleId: read.vehicleId,
      residentId: read.residentId,
      residentName: read.residentName,
      unitNumber: resident?.unitNumber ?? null,
      spotCode: read.spotCode,
      decision: read.decision,
      reason: read.reason,
      cameraId,
      occurredAt: read.capturedAt,
      supersededBy: null,
    });
  }
  return read;
}

// Clean allows, from cars that really are in the register.
for (let i = 0; i < 24; i += 1) {
  seedRead(i, {
    vehicle: vehicles[i % 20],
    status: 'MATCHED',
    decision: 'ALLOW',
    reason: 'EXACT_MATCH',
  });
}

// A visitor, read clearly and registered nowhere. A fact, not a doubt — so DENY.
seedRead(24, {
  plate: '7781XKM',
  rawText: '7781 XKM',
  status: 'UNMATCHED',
  decision: 'DENY',
  reason: 'PLATE_NOT_REGISTERED',
});

// Known car, resident marked ineligible. Identified AND denied: the log has to say who.
{
  const ineligible = residents.find((r) => !r.isEligible);
  const theirs = vehicles.find((v) => v.residentId === ineligible?.id) ?? vehicles[0];
  seedRead(25, {
    vehicle: theirs,
    status: 'MATCHED',
    decision: 'DENY',
    reason: 'RESIDENT_NOT_ELIGIBLE',
  });
}

// A car creeping towards the barrier: the frame is kept, the event is not.
seedRead(26, {
  vehicle: vehicles[3],
  status: 'DISCARDED',
  reason: 'DUPLICATE_WITHIN_COOLDOWN',
});

// ---- the review queue: one per reason an administrator will actually meet ----

// Identified, but not confidently enough to open on its own.
seedRead(27, {
  vehicle: vehicles[5],
  confidence: 0.78,
  quality: 0.55,
  status: 'REVIEW',
  decision: 'REVIEW',
  reason: 'LOW_CONFIDENCE',
});

// Two registered plates equally close. Opening would pick at random whose entry it was.
{
  const a = vehicles[7];
  const b = vehicles[8];
  seedRead(28, {
    plate: a.plate,
    rawText: a.plateDisplay,
    confidence: 0.94,
    quality: 0.8,
    status: 'REVIEW',
    decision: 'REVIEW',
    reason: 'FUZZY_MATCH_AMBIGUOUS',
    matchKind: 'FUZZY',
    matchDistance: 1,
    candidates: [
      { plate: a.plate, raw: a.plateDisplay, confidence: 0.94, score: 228.0 },
      { plate: b.plate, raw: a.plateDisplay, confidence: 0.94, score: 226.0 },
    ],
  });
}

// Nothing readable. No access event at all — a dirty lens is not a denied entry.
seedRead(29, {
  plate: null,
  rawText: null,
  confidence: 0.41,
  quality: 0.18,
  status: 'REVIEW',
  reason: 'UNREADABLE',
  candidates: [],
});

// A plate the register folded differently from the camera: O vs zero, which the canonical
// form is supposed to resolve. Here with low confidence, so it lands in the queue.
seedRead(30, {
  plate: '0932BQL',
  rawText: 'O932 BQL',
  confidence: 0.71,
  quality: 0.62,
  status: 'REVIEW',
  decision: 'REVIEW',
  reason: 'LOW_CONFIDENCE',
});

// One already reviewed, so the screen has a corrected row to show from boot. A correction
// is a ground-truth label, which is the thing the evaluation set is made of.
{
  const r = seedRead(31, {
    vehicle: vehicles[11],
    confidence: 0.76,
    quality: 0.58,
    status: 'MATCHED',
    decision: 'ALLOW',
    reason: 'MANUAL_REVIEW',
    matchKind: 'MANUAL',
  });
  r.needsReview = false;
  r.reviewedAt = iso(now() - 40 * 60_000);
  r.reviewedBy = null;
  r.reviewNote = 'Confirmed against the second camera';
  r.correctedPlate = r.plate;
}

plateReads.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));

/** Keyset paging, the same shape the real repository encodes. */
const pageOf = (rows, limit, cursor) => {
  const start = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0;
  const slice = rows.slice(start, start + limit);
  const last = slice[slice.length - 1];
  const more = start + limit < rows.length;
  return { items: slice, nextCursor: more && last ? last.id : null };
};

const plateFilters = (q) => {
  const status = q.get('status');
  const cameraId = q.get('cameraId');
  const plate = q.get('plate') ? normalizePlate(q.get('plate')) : null;
  const from = q.get('from') ? new Date(q.get('from')).getTime() : null;
  const to = q.get('to') ? new Date(q.get('to')).getTime() : null;
  return plateReads.filter(
    (r) =>
      (!status || r.status === status) &&
      (!cameraId || r.cameraId === cameraId) &&
      (!plate || r.plate === plate) &&
      (from === null || new Date(r.capturedAt).getTime() >= from) &&
      (to === null || new Date(r.capturedAt).getTime() <= to),
  );
};

on('POST', '/captures', (_q, body, p) => {
  // CAMERA or ADMIN. The stub's dev token only mints ADMIN and RESIDENT, so this is
  // reachable offline as an administrator — which is also how the smoke test drives it.
  if (!p) return err(401, 'UNAUTHENTICATED', 'No token');
  if (!p.roles.includes('ADMIN') && !p.roles.includes('CAMERA'))
    return err(403, 'FORBIDDEN', 'Cameras and administrators only');
  const cameraId = body?.cameraId ?? '';
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(cameraId))
    return err(400, 'VALIDATION_FAILED', 'cameraId is lowercase letters, digits and hyphens');
  const contentType = body?.contentType ?? 'image/jpeg';
  if (!['image/jpeg', 'image/png'].includes(contentType))
    return err(400, 'VALIDATION_FAILED', 'contentType must be image/jpeg or image/png');

  // The key comes from the SERVER's clock, never from capturedAt: a camera with a drifting
  // clock would otherwise file frames under the wrong day prefix.
  const at = now();
  const id = captureId(at, plateReads.length + 1);
  const day = iso(at).slice(0, 10).replace(/-/g, '/');
  const ext = contentType === 'image/png' ? 'png' : 'jpg';
  return ok(
    {
      captureId: id,
      objectKey: `raw/${cameraId}/${day}/${id}.${ext}`,
      // No S3 offline, so the URL is a stub that says so rather than pretending to work.
      uploadUrl: `http://localhost:${PORT}/__stub-upload/${id}`,
      expiresIn: 300,
    },
    201,
  );
});

on('GET', '/plate-reads/review', (q, _b, p) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  // Oldest first, unlike the log: a doubtful read loses its value once the car has gone.
  const rows = plateReads
    .filter((r) => r.needsReview)
    .slice()
    .sort((a, b) => (a.capturedAt > b.capturedAt ? 1 : -1));
  return ok(pageOf(rows, Number(q.get('limit') ?? 25), q.get('cursor')));
});

on('GET', '/plate-reads', (q, _b, p) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const rows =
    q.get('needsReview') === 'true'
      ? plateFilters(q)
          .filter((r) => r.needsReview)
          .slice()
          .sort((a, b) => (a.capturedAt > b.capturedAt ? 1 : -1))
      : plateFilters(q);
  return ok(pageOf(rows, Number(q.get('limit') ?? 25), q.get('cursor')));
});

on('GET', '/plate-reads/{id}', (_q, _b, p, params) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const r = plateReads.find((x) => x.id === params.id);
  if (!r) return err(404, 'NOT_FOUND', 'No such read');
  // Plates within two edits, so the reviewer can point rather than type. The real
  // implementation computes Damerau-Levenshtein; same-length agreement is close enough
  // for a fixture and keeps this file free of a distance function.
  const nearby = vehicles
    .filter((v) => v.isActive && r.plate && v.plate.length === r.plate.length)
    .map((v) => ({
      vehicleId: v.id,
      plate: v.plate,
      residentId: v.residentId,
      distance: [...v.plate].filter((c, i) => c !== r.plate[i]).length,
    }))
    .filter((n) => n.distance > 0 && n.distance <= 2)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5);
  return ok({ ...r, imageUrl: null, cropUrl: null, nearby });
});

on('POST', '/plate-reads/{id}/resolve', (_q, body, p, params) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const r = plateReads.find((x) => x.id === params.id);
  if (!r) return err(404, 'NOT_FOUND', 'No such read');
  // The real guard is `WHERE reviewed_at IS NULL` in one transaction; here it is the same
  // rule, so the screen meets the same 409 it will meet in the deployed API.
  if (r.reviewedAt) return err(409, 'PLATE_READ_ALREADY_REVIEWED', 'Already reviewed');

  const decision = body?.decision;
  if (!['ALLOW', 'DENY'].includes(decision))
    return err(400, 'VALIDATION_FAILED', 'decision must be ALLOW or DENY');

  const plate = body?.plate ? normalizePlate(body.plate) : null;
  if (decision === 'ALLOW' && !body?.discard && !plate)
    return err(400, 'VALIDATION_FAILED', 'Allowing an entry requires naming the plate');

  const vehicle =
    vehicles.find((v) => v.isActive && v.id === body?.vehicleId) ??
    vehicles.find((v) => v.isActive && plate && v.plate === plate) ??
    null;
  const resident = vehicle ? residents.find((x) => x.id === vehicle.residentId) : null;

  r.reviewedAt = iso(now());
  r.reviewedBy = p.resident?.id ?? null;
  r.reviewNote = body?.note ?? null;
  r.needsReview = false;
  r.matchKind = 'MANUAL';
  r.correctedPlate = plate;

  if (body?.discard) {
    r.status = 'DISCARDED';
    r.decision = null;
    r.reason = 'UNREADABLE';
    return ok(r);
  }

  r.plate = plate ?? r.plate;
  r.vehicleId = vehicle?.id ?? null;
  r.residentId = resident?.id ?? null;
  r.residentName = resident?.fullName ?? null;
  r.spotCode = resident?.currentSpotCode ?? null;

  // An ALLOW for an ineligible resident becomes a DENY, not a refusal: the administrator
  // is right about which car it was and wrong about whether it may enter.
  const ineligible = resident && !resident.isEligible;
  r.decision = decision === 'ALLOW' && !ineligible ? 'ALLOW' : 'DENY';
  r.reason = ineligible
    ? 'RESIDENT_NOT_ELIGIBLE'
    : vehicle
      ? 'MANUAL_REVIEW'
      : decision === 'ALLOW'
        ? 'MANUAL_REVIEW'
        : 'PLATE_NOT_REGISTERED';
  r.status = vehicle ? 'MATCHED' : 'UNMATCHED';

  // Append-only: the standing row is superseded, never edited.
  const previous = accessEvents.find((e) => e.plateReadId === r.id && !e.supersededBy);
  const fresh = {
    id: `ae-${nextId()}`,
    plateReadId: r.id,
    captureId: r.captureId,
    plate: r.plate ?? '',
    vehicleId: r.vehicleId,
    residentId: r.residentId,
    residentName: r.residentName,
    unitNumber: resident?.unitNumber ?? null,
    spotCode: r.spotCode,
    decision: r.decision,
    reason: r.reason,
    cameraId: r.cameraId,
    occurredAt: r.capturedAt,
    supersededBy: null,
  };
  if (previous) previous.supersededBy = fresh.id;
  accessEvents.push(fresh);

  return ok(r);
});

on('GET', '/access-events', (q, _b, p) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const decision = q.get('decision');
  const residentId = q.get('residentId');
  const rows = accessEvents
    .filter((e) => (!decision || e.decision === decision) && (!residentId || e.residentId === residentId))
    .slice()
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  return ok(pageOf(rows, Number(q.get('limit') ?? 25), q.get('cursor')));
});

on('GET', '/me/access-events', (q, _b, p) => {
  const bad = needResident(p);
  if (bad) return bad;
  // Superseded rows excluded: a resident sees what the building concluded, not the
  // administrator's working.
  const rows = accessEvents
    .filter((e) => e.residentId === p.resident.id && !e.supersededBy)
    .slice()
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
    .slice(0, Number(q.get('limit') ?? 25));
  return ok({ items: rows, nextCursor: null });
});

on('GET', '/metrics/plates', (_q, _b, p) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const pending = plateReads.filter((r) => r.needsReview);
  const oldest = pending.reduce(
    (acc, r) => Math.min(acc, new Date(r.capturedAt).getTime()),
    Number.POSITIVE_INFINITY,
  );
  const live = accessEvents.filter((e) => !e.supersededBy);
  const byCamera = CAMERAS.map((cameraId) => ({
    cameraId,
    reads: plateReads.filter((r) => r.cameraId === cameraId).length,
    matched: plateReads.filter((r) => r.cameraId === cameraId && r.status === 'MATCHED').length,
  }));
  return ok({
    windowDays: 30,
    reads: plateReads.length,
    matched: plateReads.filter((r) => r.status === 'MATCHED').length,
    unmatched: plateReads.filter((r) => r.status === 'UNMATCHED').length,
    pendingReview: pending.length,
    oldestPendingHours:
      pending.length === 0
        ? null
        : Math.round(((now() - oldest) / 3_600_000) * 10) / 10,
    allowed: live.filter((e) => e.decision === 'ALLOW').length,
    denied: live.filter((e) => e.decision === 'DENY').length,
    // The mean of the FUSED value, not of the raw confidence: the raw one reads higher
    // than anything the gate ever decided on.
    averageFused:
      plateReads.length === 0
        ? null
        : Number(
            (plateReads.reduce((a, r) => a + r.fused, 0) / plateReads.length).toFixed(4),
          ),
    corrections: plateReads.filter((r) => r.correctedPlate).length,
    byCamera,
  });
});

on('GET', '/spots', (q, _b, p) => {
  if (!p) return err(401, 'UNAUTHENTICATED', 'No token');
  const level = q.get('level');
  return ok({ items: spots.filter((s) => !level || s.level === level) });
});

on('POST', '/spots', (_q, body, p) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  if (!body?.spotCode || !body?.level) return err(422, 'VALIDATION', 'spotCode and level are required');
  if (spots.some((s) => s.spotCode === body.spotCode))
    return err(409, 'CONFLICT', 'That bay code already exists');
  const s = {
    id: `s-${nextId()}`,
    spotCode: body.spotCode,
    level: body.level,
    type: body.type ?? 'STANDARD',
    isActive: body.isActive ?? true,
    notes: body.notes ?? null,
    createdAt: iso(now()),
  };
  spots.push(s);
  return ok(s, 201);
});

on('PATCH', '/spots/{id}', (_q, body, p, params) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const s = spots.find((x) => x.id === params.id);
  if (!s) return err(404, 'NOT_FOUND', 'No such bay');
  for (const k of ['spotCode', 'level', 'type', 'isActive', 'notes'])
    if (body?.[k] !== undefined) s[k] = body[k];
  return ok(s);
});

on('GET', '/cycles', (_q, _b, p) => (p ? ok({ items: cycles }) : err(401, 'UNAUTHENTICATED', 'No token')));

on('POST', '/cycles', (_q, body, p) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const c = {
    id: `c-${nextId()}`,
    label: body?.label ?? 'New period',
    startsOn: body?.startsOn ?? iso(now()).slice(0, 10),
    endsOn: body?.endsOn ?? iso(now() + 90 * DAY).slice(0, 10),
    state: 'DRAFT',
    registrationOpensAt: body?.registrationOpensAt ?? iso(now()),
    registrationClosesAt: body?.registrationClosesAt ?? iso(now() + 14 * DAY),
  };
  cycles.push(c);
  registrations.set(c.id, new Set());
  return ok(c, 201);
});

on('PATCH', '/cycles/{id}', (_q, body, p, params) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const c = cycles.find((x) => x.id === params.id);
  if (!c) return err(404, 'NOT_FOUND', 'No such period');
  if (body?.label !== undefined) c.label = body.label;
  return ok(c);
});

on('DELETE', '/cycles/{id}', (_q, _b, p, params) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const i = cycles.findIndex((x) => x.id === params.id);
  if (i < 0) return err(404, 'NOT_FOUND', 'No such period');
  if (cycles[i].state !== 'DRAFT') return err(409, 'CONFLICT', 'Only a draft period can be removed');
  cycles.splice(i, 1);
  return ok(null, 204);
});

on('POST', '/cycles/{id}/open-registration', (_q, _b, p, params) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const c = cycles.find((x) => x.id === params.id);
  if (!c) return err(404, 'NOT_FOUND', 'No such period');
  if (c.state !== 'DRAFT') return err(409, 'ILLEGAL_TRANSITION', `Cannot open from ${c.state}`);
  c.state = 'REGISTRATION_OPEN';
  return ok(c);
});

on('POST', '/cycles/{id}/close-registration', (_q, _b, p, params) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const c = cycles.find((x) => x.id === params.id);
  if (!c) return err(404, 'NOT_FOUND', 'No such period');
  if (c.state !== 'REGISTRATION_OPEN')
    return err(409, 'ILLEGAL_TRANSITION', `Cannot close from ${c.state}`);
  c.state = 'REGISTRATION_CLOSED';
  return ok(c);
});

/*
 * Ending the period in effect. Mirrors the real route rather than approximating it,
 * because the stub is what the screens are built against: a Close period that works here
 * and 404s on the deployed API would be found by a person rather than by a test.
 */
on('POST', '/cycles/{id}/close', (_q, _b, p, params) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const c = cycles.find((x) => x.id === params.id);
  if (!c) return err(404, 'NOT_FOUND', 'No such period');
  if (c.state !== 'ACTIVE')
    return err(409, 'ILLEGAL_TRANSITION', `Only a period in effect can be closed; this is ${c.state}`);
  c.state = 'CLOSED';
  /*
   * The stub keeps one assignment per resident, keyed by resident and with no cycle on
   * it, because it only ever has one period in effect. Closing that period ends them
   * all, and the register has to forget the bay too - currentSpotCode is what the screens
   * read, and a resident still showing a bay in a closed period is the inconsistency this
   * whole rule exists to prevent.
   */
  for (const a of assignments.values()) {
    if (a.state === 'ACTIVE') a.state = 'EXPIRED';
  }
  for (const r of residents) r.currentSpotCode = null;
  return ok(c);
});

on('POST', '/cycles/{id}/runs', (_q, _b, p, params) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const c = cycles.find((x) => x.id === params.id);
  if (!c) return err(404, 'NOT_FOUND', 'No such period');
  if (c.state !== 'REGISTRATION_CLOSED')
    return err(409, 'ILLEGAL_TRANSITION', 'Registration must be closed before the draw');
  return ok(toRunResult(executeRun(c)), 201);
});

on('GET', '/runs', (q, _b, p) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  return ok({ items: runs.slice(0, Number(q.get('limit') ?? 20)).map(toRunSummary) });
});

on('GET', '/runs/{id}', (_q, _b, p, params) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const run = runs.find((r) => r.runId === params.id);
  return run ? ok(toRunResult(run)) : err(404, 'NOT_FOUND', 'No such run');
});

on('GET', '/runs/{id}/explanation', (_q, _b, p, params) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const run = runs.find((r) => r.runId === params.id);
  if (!run) return err(404, 'NOT_FOUND', 'No such run');
  return ok({
    runId: run.runId,
    configVersion: run.configVersion,
    policy: {
      earlyWaitingBiasHours: config.earlyWaitingBiasHours,
      waitQuantumMinutes: config.waitQuantumMinutes,
      allocationDurationMonths: config.allocationDurationMonths,
    },
    ordering: 'effective waiting time desc, then allocations asc, then draw token asc',
    tokenRecipe: 'sha256(seed:runId:residentId)',
    items: run.items,
  });
});

on('GET', '/runs/{id}/assignments', (_q, _b, p, params) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const run = runs.find((r) => r.runId === params.id);
  if (!run) return err(404, 'NOT_FOUND', 'No such run');
  return ok({
    items: run.items
      .filter((i) => i.outcome === 'ASSIGNED')
      .map((i) => ({
        residentId: i.residentId,
        fullName: residents.find((r) => r.id === i.residentId)?.fullName ?? '',
        spotCode: i.spotCode,
      })),
  });
});

on('GET', '/metrics/fairness', (_q, _b, p) => needAdmin(p) ?? ok(fairnessMetrics()));

const configView = () => {
  const warnings = [];
  if (config.totalBays !== spots.filter((s) => s.isActive).length)
    warnings.push(
      `totalBays is ${config.totalBays} but ${spots.filter((s) => s.isActive).length} bays are active`,
    );
  return { config, warnings };
};

on('GET', '/config/allocation', (_q, _b, p) => (p ? ok(configView()) : err(401, 'UNAUTHENTICATED', 'No token')));

on('PATCH', '/config/allocation', (_q, body, p) => {
  const bad = needAdmin(p);
  if (bad) return bad;
  const next = { ...config, ...body, version: config.version + 1 };
  if (next.allocationDurationMonths < 1 || next.allocationDurationMonths > 24)
    return err(422, 'VALIDATION', 'allocationDurationMonths must be between 1 and 24');
  if (next.totalBays < 1) return err(422, 'VALIDATION', 'totalBays must be at least 1');
  config = next;
  configHistory.unshift({ ...config, changedAt: iso(now()), changedBy: p.email ?? 'local' });
  return ok(configView());
});

on('GET', '/config/allocation/history', (_q, _b, p) => needAdmin(p) ?? ok({ items: configHistory }));

/* ------------------------------------------------------------------ server */

const CORS = {
  'access-control-allow-origin': '*',
  // The same three the deployed HTTP API allows (serverless.yml `cors.allowedHeaders`).
  // `Idempotency-Key` is not optional: the draw sends it, and a preflight that omits it
  // fails before the POST is ever made.
  'access-control-allow-headers': 'authorization,content-type,idempotency-key',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-max-age': '600',
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, body) => {
    const headers = { ...CORS, 'x-trace-id': randomUUID() };
    if (body === null || status === 204) {
      res.writeHead(status, headers);
      res.end();
    } else {
      const json = JSON.stringify(body);
      res.writeHead(status, { ...headers, 'content-type': 'application/json' });
      res.end(json);
    }
    const mark = status >= 400 ? '!' : ' ';
    process.stdout.write(`${mark} ${status} ${req.method} ${url.pathname}\n`);
  };

  if (req.method === 'OPTIONS') return send(204, null);
  if (req.method === 'GET' && ['/docs', '/docs/', '/openapi.yaml'].includes(url.pathname)) {
    const isUi = url.pathname !== '/openapi.yaml';
    res.writeHead(200, {
      ...CORS,
      'content-type': isUi ? 'text/html; charset=utf-8' : 'application/yaml; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(isUi ? docsHtml : openapiYaml);
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = null;
    if (chunks.length > 0) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { code: 'BAD_JSON', message: 'Body is not JSON' });
      }
    }

    const principal = principalOf(req);
    for (const route of ROUTES) {
      if (route.method !== req.method) continue;
      const m = route.rx.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      try {
        const out = route.handler(url.searchParams, body, principal, params);
        return send(out.status, out.body);
      } catch (e) {
        return send(500, { code: 'STUB_ERROR', message: String(e?.message ?? e) });
      }
    }
    send(404, { code: 'NOT_FOUND', message: `No route for ${req.method} ${url.pathname}` });
  });
});

server.listen(PORT, () => {
  process.stdout.write(
    `PACS stub API on http://localhost:${PORT}\n` +
      `  ${residents.length} residents, ${spots.length} bays, ${cycles.length} periods\n` +
      `  ${plateReads.length} plate reads, ${plateReads.filter((r) => r.needsReview).length} waiting for review\n` +
      `  signed-in resident: ${ME.fullName} (${ME.id})\n`,
  );
});
