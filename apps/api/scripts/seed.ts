/**
 * Development seed: 24 residents, 10 spots and one cycle in REGISTRATION_OPEN.
 *
 * Idempotent — safe to re-run. Reads the connection from DATABASE_URL so no credential
 * is hard-coded or passed on the command line:
 *
 *   pnpm --filter @pacs/api seed
 *
 * Deliberately shaped so the first run is interesting: 24 entrants for 10 spots means
 * 14 people on the waitlist, and the seeded fairness scores make the weighting visible
 * in the very first draw.
 */
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from '../src/shared/db/schema';

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
      max: 2,
    }),
  }),
});

const FIRST = ['Ana', 'Luis', 'Maria', 'Diego', 'Sofia', 'Carla', 'Jorge', 'Elena'];
const LAST = ['Rivera', 'Quispe', 'Flores', 'Vargas', 'Torres', 'Rojas', 'Mendoza', 'Callisaya'];

const residents = Array.from({ length: 24 }, (_, i) => {
  const first = FIRST[i % FIRST.length]!;
  const last = LAST[Math.floor(i / FIRST.length) % LAST.length]!;
  return {
    email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.test`,
    full_name: `${first} ${last}`,
    unit_number: `${Math.floor(i / 4) + 1}0${(i % 4) + 1}`,
    // A spread of fairness scores so the weighted draw has something to work with.
    score: i % 5,
    needs_accessible_spot: i === 3 || i === 17,
  };
});

const spots = [
  ...Array.from({ length: 7 }, (_, i) => ({
    spot_code: `B1-${String(i + 1).padStart(2, '0')}`,
    level: 'B1',
    type: 'STANDARD' as const,
  })),
  { spot_code: 'B1-08', level: 'B1', type: 'ACCESSIBLE' as const },
  { spot_code: 'B2-01', level: 'B2', type: 'ACCESSIBLE' as const },
  { spot_code: 'B2-02', level: 'B2', type: 'EV' as const },
];

async function main(): Promise<void> {
  // ------------------------------------------------------------- residents
  for (const r of residents) {
    const row = await db
      .insertInto('resident')
      .values({
        email: r.email,
        full_name: r.full_name,
        unit_number: r.unit_number,
        needs_accessible_spot: r.needs_accessible_spot,
      })
      .onConflict((oc) => oc.column('email').doUpdateSet({ full_name: r.full_name }))
      .returning('id')
      .executeTakeFirstOrThrow();

    await db
      .insertInto('fairness_state')
      .values({
        resident_id: row.id,
        score: r.score,
        consecutive_misses: r.score,
        total_registrations: r.score,
      })
      .onConflict((oc) =>
        oc.column('resident_id').doUpdateSet({
          score: r.score,
          consecutive_misses: r.score,
        }),
      )
      .execute();
  }

  // ----------------------------------------------------------------- spots
  for (const s of spots) {
    await db
      .insertInto('parking_spot')
      .values(s)
      .onConflict((oc) => oc.column('spot_code').doUpdateSet({ level: s.level, type: s.type }))
      .execute();
  }

  // ----------------------------------------------------------------- cycle
  const cycle = await db
    .insertInto('allocation_cycle')
    .values({
      label: '2026-Q4',
      starts_on: new Date('2026-10-01T00:00:00Z'),
      ends_on: new Date('2026-12-31T23:59:59Z'),
      state: 'REGISTRATION_OPEN',
      registration_opens_at: new Date('2026-09-01T00:00:00Z'),
      registration_closes_at: new Date('2026-09-25T23:59:59Z'),
    })
    .onConflict((oc) => oc.column('label').doUpdateSet({ state: 'REGISTRATION_OPEN' }))
    .returning(['id', 'label'])
    .executeTakeFirstOrThrow();

  // ---------------------------------------------------------- registrations
  const all = await db.selectFrom('resident').select('id').where('deactivated_at', 'is', null).execute();
  for (const r of all) {
    await db
      .insertInto('raffle_registration')
      .values({ cycle_id: cycle.id, resident_id: r.id, withdrawn: false })
      .onConflict((oc) => oc.constraint('uq_registration_per_cycle').doUpdateSet({ withdrawn: false }))
      .execute();
  }

  const counts = {
    residents: all.length,
    spots: (await db.selectFrom('parking_spot').select('id').where('is_active', '=', true).execute())
      .length,
    registrations: (
      await db
        .selectFrom('raffle_registration')
        .select('id')
        .where('cycle_id', '=', cycle.id)
        .where('withdrawn', '=', false)
        .execute()
    ).length,
  };

  console.log('seeded', { cycle: cycle.label, cycleId: cycle.id, ...counts });
  console.log(
    `\nNext: close registration, then run the draw.\n` +
      `  POST /cycles/${cycle.id}/close-registration\n` +
      `  POST /cycles/${cycle.id}/runs   (Idempotency-Key required)\n`,
  );

  await db.destroy();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  await db.destroy();
  process.exit(1);
});
