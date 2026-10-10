/**
 * Development seed: 24 residents, 10 spots and one cycle in REGISTRATION_OPEN.
 *
 * Idempotent - safe to re-run. Reads the connection from DATABASE_URL so no credential
 * is hard-coded or passed on the command line:
 *
 *   pnpm --filter @pacs/api seed
 *
 * Deliberately shaped so the first run is interesting: 24 entrants for 10 spots means 14
 * people on the waitlist, and the spread of participation_started_at values makes the
 * ordering, the history tie-break and the raffle all visible in the very first draw -
 * several residents share an exact anchor, so the raffle really does decide between them.
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

const HOUR = 3_600_000;

const residents = Array.from({ length: 24 }, (_, i) => {
  const first = FIRST[i % FIRST.length]!;
  const last = LAST[Math.floor(i / FIRST.length) % LAST.length]!;
  return {
    email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.test`,
    full_name: `${first} ${last}`,
    unit_number: `${Math.floor(i / 4) + 1}0${(i % 4) + 1}`,
    // Five buckets of waiting time, so residents tie on the hour and the secondary
    // criterion and the raffle both get exercised.
    participation_started_at: new Date(Date.now() - (i % 5) * 500 * HOUR),
    needs_accessible_spot: i === 3 || i === 17,
    has_electric_vehicle: i === 5,
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
    await db
      .insertInto('resident')
      .values({
        email: r.email,
        full_name: r.full_name,
        unit_number: r.unit_number,
        needs_accessible_spot: r.needs_accessible_spot,
        has_electric_vehicle: r.has_electric_vehicle,
        participation_started_at: r.participation_started_at,
      })
      .onConflict((oc) =>
        oc.column('email').doUpdateSet({
          full_name: r.full_name,
          participation_started_at: r.participation_started_at,
        }),
      )
      .execute();
  }

  // One administrator account, to show that it is excluded from candidacy rather than
  // merely discouraged from entering.
  await db
    .insertInto('resident')
    .values({
      email: 'admin@example.test',
      full_name: 'Building Administrator',
      unit_number: 'OFFICE',
      is_admin: true,
    })
    .onConflict((oc) => oc.column('email').doUpdateSet({ is_admin: true }))
    .execute();

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
  // Administrator accounts are never entered: the administrator operates the raffle.
  const all = await db
    .selectFrom('resident')
    .select('id')
    .where('deactivated_at', 'is', null)
    .where('is_admin', '=', false)
    .execute();
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
