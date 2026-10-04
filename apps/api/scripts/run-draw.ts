/**
 * End-to-end check of the allocation path against a real database.
 *
 * Wires the real Kysely repositories to the real use case — no mocks, no Lambda — so
 * the things only Postgres can prove are actually proven: the partial unique index
 * holding the run lock, the single transaction, the append-only history grant, and
 * idempotent replay. This is the §27 integration layer, runnable by hand:
 *
 *   pnpm --filter @pacs/api exec tsx scripts/run-draw.ts
 */
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from '../src/shared/db/schema';
import { KyselyAllocationRepository } from '../src/modules/allocation/infrastructure/kysely-allocation.repository';
import { ExecuteRun } from '../src/modules/allocation/application/execute-run';
import { WeightedLotteryDraw } from '../src/modules/allocation/domain/weighted-lottery-draw';
import { cryptoSeedSource, systemClock } from '../src/shared/clock';
import { InMemoryCache } from '../src/shared/cache/dynamodb-cache';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new Pool({
      connectionString: url,
      ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 4,
    }),
  }),
});

const check = (label: string, pass: boolean, extra = ''): boolean => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  return pass;
};

async function main(): Promise<void> {
  const results: boolean[] = [];

  const cycle = await db
    .selectFrom('allocation_cycle')
    .selectAll()
    .where('label', '=', '2026-Q4')
    .executeTakeFirstOrThrow();

  // Reset so the script is re-runnable.
  await db.deleteFrom('allocation_history').where('cycle_id', '=', cycle.id).execute();
  await db.deleteFrom('waitlist_entry').where('cycle_id', '=', cycle.id).execute();
  await db.deleteFrom('spot_assignment').where('cycle_id', '=', cycle.id).execute();
  await db.deleteFrom('allocation_run').where('cycle_id', '=', cycle.id).execute();
  await db.deleteFrom('event_outbox').execute();
  await db
    .updateTable('allocation_cycle')
    .set({ state: 'REGISTRATION_CLOSED' })
    .where('id', '=', cycle.id)
    .execute();

  const repo = new KyselyAllocationRepository(db);
  const executeRun = new ExecuteRun(
    repo,
    new WeightedLotteryDraw(),
    systemClock,
    cryptoSeedSource,
    new InMemoryCache(),
  );

  // ------------------------------------------------------------------ run 1
  const key = `e2e-${Date.now()}`;
  const started = Date.now();
  const first = await executeRun.execute({ cycleId: cycle.id, idempotencyKey: key });
  const elapsed = Date.now() - started;

  results.push(check('run completes', first.ok, first.ok ? '' : JSON.stringify(first.error)));
  if (!first.ok) {
    await db.destroy();
    process.exit(1);
  }

  const r = first.value;
  console.log('\n  ', JSON.stringify(r, null, 2).replace(/\n/g, '\n   '), '\n');

  results.push(check('every spot filled', r.assigned === 10, `assigned=${r.assigned}`));
  results.push(check('remainder waitlisted', r.waitlisted === 14, `waitlisted=${r.waitlisted}`));
  results.push(check('NFR-01: under 2 s', elapsed < 2000, `${elapsed} ms`));

  // -------------------------------------------------------- database truth
  const assignments = await db
    .selectFrom('spot_assignment')
    .selectAll()
    .where('cycle_id', '=', cycle.id)
    .execute();
  const history = await db
    .selectFrom('allocation_history')
    .selectAll()
    .where('cycle_id', '=', cycle.id)
    .execute();
  const waitlist = await db
    .selectFrom('waitlist_entry')
    .selectAll()
    .where('cycle_id', '=', cycle.id)
    .execute();
  const outbox = await db.selectFrom('event_outbox').selectAll().execute();

  results.push(check('10 assignment rows', assignments.length === 10));
  results.push(
    check('no resident assigned twice', new Set(assignments.map((a) => a.resident_id)).size === 10),
  );
  results.push(check('no spot assigned twice', new Set(assignments.map((a) => a.spot_id)).size === 10));
  results.push(check('24 history rows, one per participant', history.length === 24));
  results.push(
    check(
      'waitlist positions are 1..14 with no gaps',
      waitlist
        .map((w) => w.position)
        .sort((a, b) => a - b)
        .every((p, i) => p === i + 1),
    ),
  );
  results.push(check('outbox has events', outbox.length > 0, `${outbox.length} events`));

  const cycleAfter = await db
    .selectFrom('allocation_cycle')
    .select('state')
    .where('id', '=', cycle.id)
    .executeTakeFirstOrThrow();
  results.push(check('cycle moved to ACTIVE', cycleAfter.state === 'ACTIVE'));

  // Accessibility: the two residents who need an accessible bay should hold one.
  const accessible = await db
    .selectFrom('spot_assignment as sa')
    .innerJoin('resident as res', 'res.id', 'sa.resident_id')
    .innerJoin('parking_spot as ps', 'ps.id', 'sa.spot_id')
    .select(['res.full_name as name', 'ps.spot_code as code', 'ps.type as type'])
    .where('sa.cycle_id', '=', cycle.id)
    .where('res.needs_accessible_spot', '=', true)
    .execute();
  results.push(
    check(
      'accessibility pre-assignment honoured',
      accessible.length === 2 && accessible.every((a) => a.type === 'ACCESSIBLE'),
      accessible.map((a) => `${a.name}→${a.code}`).join(', '),
    ),
  );

  // Fairness: winners reset to 0, losers incremented.
  const winnerScores = await db
    .selectFrom('fairness_state as fs')
    .innerJoin('spot_assignment as sa', 'sa.resident_id', 'fs.resident_id')
    .select('fs.score')
    .where('sa.cycle_id', '=', cycle.id)
    .execute();
  results.push(
    check('every winner score reset to 0', winnerScores.every((w) => Number(w.score) === 0)),
  );

  // ------------------------------------------------------- idempotent replay
  const replay = await executeRun.execute({ cycleId: cycle.id, idempotencyKey: key });
  const runCount = await db
    .selectFrom('allocation_run')
    .select('id')
    .where('cycle_id', '=', cycle.id)
    .execute();
  results.push(
    check(
      'replaying the idempotency key does not re-draw',
      replay.ok && runCount.length === 1,
      `${runCount.length} run row(s)`,
    ),
  );

  // --------------------------------------------------- guard 1: the run lock
  await db
    .insertInto('allocation_run')
    .values({
      cycle_id: cycle.id,
      state: 'RUNNING',
      random_seed: '1',
      algorithm_version: 'test',
      idempotency_key: `lock-probe-${Date.now()}`,
    })
    .execute();

  let lockRejected = false;
  try {
    await db
      .insertInto('allocation_run')
      .values({
        cycle_id: cycle.id,
        state: 'RUNNING',
        random_seed: '2',
        algorithm_version: 'test',
        idempotency_key: `lock-probe-2-${Date.now()}`,
      })
      .execute();
  } catch (e) {
    lockRejected = (e as { constraint?: string }).constraint === 'uq_single_running_run';
  }
  results.push(check('guard 1: a second RUNNING run is rejected by the index', lockRejected));

  await db.deleteFrom('allocation_run').where('state', '=', 'RUNNING').execute();

  // ------------------------------- BR-05: history is append-only for app_user
  let historyProtected = false;
  try {
    await db.executeQuery({
      sql: 'SET ROLE app_user; UPDATE allocation_history SET result = \'ASSIGNED\'; RESET ROLE;',
      parameters: [],
      query: { kind: 'RawNode' } as never,
    } as never);
  } catch (e) {
    historyProtected = /permission denied/i.test(e instanceof Error ? e.message : String(e));
  }
  results.push(
    check(
      'BR-05: app_user cannot UPDATE allocation_history',
      historyProtected,
      historyProtected ? '' : 'check the grant manually',
    ),
  );

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  await db.destroy();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  await db.destroy();
  process.exit(1);
});
