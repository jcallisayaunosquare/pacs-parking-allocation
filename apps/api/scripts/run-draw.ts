/**
 * End-to-end check of the allocation path against a real database.
 *
 * Wires the real Kysely repositories to the real use case - no mocks, no Lambda - so
 * the things only Postgres can prove are actually proven: the partial unique index
 * holding the run lock, the single transaction, the append-only history grant, and
 * idempotent replay. This is the section 27 integration layer, runnable by hand:
 *
 *   pnpm --filter @pacs/api exec tsx scripts/run-draw.ts
 */
import { createHash } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from '../src/shared/db/schema';
import { KyselyAllocationRepository } from '../src/modules/allocation/infrastructure/kysely-allocation.repository';
import { ExecuteRun } from '../src/modules/allocation/application/execute-run';
import { KyselyAllocationConfigProvider } from '../src/modules/allocation/infrastructure/kysely-allocation-config.provider';
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
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '  - ' + extra : ''}`);
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
  await db
    .deleteFrom('allocation_run_candidate')
    .where((eb) =>
      eb(
        'run_id',
        'in',
        eb.selectFrom('allocation_run').select('id').where('cycle_id', '=', cycle.id),
      ),
    )
    .execute();
  await db.deleteFrom('allocation_run').where('cycle_id', '=', cycle.id).execute();
  await db.deleteFrom('event_outbox').execute();
  await db
    .updateTable('allocation_cycle')
    .set({ state: 'REGISTRATION_CLOSED' })
    .where('id', '=', cycle.id)
    .execute();

  // Expectations are derived, never hard-coded: the smoke suites add spots and
  // residents as they run, so a fixed "10 assigned" goes stale the first time
  // anything else touches the database.
  const entrantCount = (
    await db
      .selectFrom('raffle_registration')
      .select('id')
      .where('cycle_id', '=', cycle.id)
      .where('withdrawn', '=', false)
      .execute()
  ).length;

  const spotCount = (
    await db.selectFrom('parking_spot').select('id').where('is_active', '=', true).execute()
  ).length;

  const expectedAssigned = Math.min(entrantCount, spotCount);
  const expectedWaitlisted = entrantCount - expectedAssigned;
  console.log(
    `\n  ${entrantCount} entrants, ${spotCount} active spots ` +
      `-> expecting ${expectedAssigned} assigned, ${expectedWaitlisted} waitlisted\n`,
  );

  const repo = new KyselyAllocationRepository(db);
  const executeRun = new ExecuteRun(
    repo,
    new KyselyAllocationConfigProvider(db),
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

  results.push(
    check('every spot filled', r.assigned === expectedAssigned, `assigned=${r.assigned} of ${spotCount}`),
  );
  results.push(
    check('remainder waitlisted', r.waitlisted === expectedWaitlisted, `waitlisted=${r.waitlisted}`),
  );
  /**
   * NFR-01 is about the run, not about the network between this machine and us-east-2.
   * Measuring the round trip put the check at ~1.99 s against a 2 s limit while the
   * draw itself took milliseconds, so it would have flaked on the next slow link. It
   * now asserts on the server-side duration and reports the round trip for context.
   */
  const serverMs = r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : -1;
  results.push(
    check(
      'NFR-01: the run itself completes inside 2 s',
      serverMs >= 0 && serverMs < 2000,
      `${serverMs} ms server-side - ${elapsed} ms including the round trip from here`,
    ),
  );

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

  results.push(
    check('one assignment row per filled spot', assignments.length === expectedAssigned),
  );
  results.push(
    check(
      'no resident assigned twice',
      new Set(assignments.map((a) => a.resident_id)).size === expectedAssigned,
    ),
  );
  results.push(
    check('no spot assigned twice', new Set(assignments.map((a) => a.spot_id)).size === expectedAssigned),
  );
  results.push(
    check(
      'one history row per participant',
      history.length === entrantCount,
      `${history.length} rows`,
    ),
  );
  results.push(
    check(
      'waitlist positions are contiguous from 1',
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
      accessible.map((a) => `${a.name}->${a.code}`).join(', '),
    ),
  );

  // The contestable record: one row per candidate, ranks contiguous from 1, and the
  // ordering actually monotone in the effective waiting time the run computed.
  const candidates = await db
    .selectFrom('allocation_run_candidate')
    .selectAll()
    .where('run_id', '=', r.runId)
    .orderBy('final_rank')
    .execute();

  results.push(
    check(
      'one candidate key row per entrant',
      candidates.length === entrantCount,
      `${candidates.length} rows`,
    ),
  );
  results.push(
    check(
      'ranks are contiguous from 1',
      candidates.every((c, i) => c.final_rank === i + 1),
    ),
  );
  results.push(
    check(
      'ranking is monotone in effective waiting time',
      candidates.every(
        (c, i) => i === 0 || Number(candidates[i - 1]!.effective_wait_quanta) >= Number(c.effective_wait_quanta),
      ),
    ),
  );
  results.push(
    check(
      'commit-reveal: sha256(seed) matches the published commitment',
      createHash('sha256').update(r.randomSeedHex).digest('hex') === r.seedCommitmentHex,
    ),
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
  const probe = (n: number) => ({
    cycle_id: cycle.id,
    state: 'RUNNING' as const,
    random_seed: Buffer.alloc(32, n),
    seed_commitment: createHash('sha256').update(Buffer.alloc(32, n)).digest(),
    config_version: 1,
    algorithm_version: 'test',
    idempotency_key: `lock-probe-${n}-${Date.now()}`,
  });

  await db.insertInto('allocation_run').values(probe(1)).execute();

  let lockRejected = false;
  try {
    await db.insertInto('allocation_run').values(probe(2)).execute();
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
