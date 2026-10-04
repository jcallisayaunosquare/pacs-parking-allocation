import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../shared/db/schema';
import type { FairnessReadModel, HistoryEntry } from '../application/dashboard.use-cases';
import type { FairnessState } from '../domain/fairness';

export class KyselyFairnessReadModel implements FairnessReadModel {
  constructor(private readonly db: Kysely<Database>) {}

  async getState(residentId: string): Promise<FairnessState | null> {
    const r = await this.db
      .selectFrom('fairness_state')
      .selectAll()
      .where('resident_id', '=', residentId)
      .executeTakeFirst();
    if (!r) return null;
    return {
      residentId: r.resident_id,
      score: Number(r.score),
      consecutiveMisses: r.consecutive_misses,
      totalRegistrations: r.total_registrations,
      totalWins: r.total_wins,
      lastWonCycleId: r.last_won_cycle_id,
    };
  }

  /** Served by ix_history_resident_recent — a single index scan (§11). */
  async getHistory(residentId: string, limit: number): Promise<readonly HistoryEntry[]> {
    const rows = await this.db
      .selectFrom('allocation_history as ah')
      .innerJoin('allocation_cycle as ac', 'ac.id', 'ah.cycle_id')
      .leftJoin('parking_spot as ps', 'ps.id', 'ah.spot_id')
      .select([
        'ac.label as cycle',
        'ah.result as result',
        'ps.spot_code as spotCode',
        'ah.waitlist_position as position',
        'ah.fairness_score_at_draw as scoreAtDraw',
        'ah.recorded_at as recordedAt',
      ])
      .where('ah.resident_id', '=', residentId)
      .orderBy('ah.recorded_at', 'desc')
      .limit(limit)
      .execute();

    return rows.map((r) => ({
      cycle: r.cycle,
      result: r.result,
      spotCode: r.spotCode ?? null,
      position: r.position ?? null,
      scoreAtDraw: Number(r.scoreAtDraw),
      recordedAt: new Date(r.recordedAt).toISOString(),
    }));
  }

  async getWaitlistPosition(residentId: string) {
    const r = await this.db
      .selectFrom('waitlist_entry as we')
      .innerJoin('allocation_cycle as ac', 'ac.id', 'we.cycle_id')
      .select(['we.cycle_id as cycleId', 'we.position as position'])
      .where('we.resident_id', '=', residentId)
      .where('we.state', '=', 'WAITING')
      .where('ac.state', '=', 'ACTIVE')
      .executeTakeFirst();
    return r ?? null;
  }

  async getMetrics() {
    const agg = await this.db
      .selectFrom('fairness_state as fs')
      .innerJoin('resident as r', 'r.id', 'fs.resident_id')
      .select((eb) => [
        eb.fn.countAll<string>().as('residents'),
        sql<string>`coalesce(avg(fs.score), 0)`.as('avg_score'),
        sql<string>`coalesce(max(fs.score), 0)`.as('max_score'),
        sql<string>`count(*) filter (where fs.total_wins = 0)`.as('never_won'),
      ])
      .where('r.deactivated_at', 'is', null)
      .executeTakeFirst();

    const distribution = await this.db
      .selectFrom('fairness_state as fs')
      .innerJoin('resident as r', 'r.id', 'fs.resident_id')
      .select((eb) => [
        sql<string>`floor(fs.score)`.as('score'),
        eb.fn.countAll<string>().as('residents'),
      ])
      .where('r.deactivated_at', 'is', null)
      .groupBy(sql`floor(fs.score)`)
      .orderBy(sql`floor(fs.score)`)
      .execute();

    return {
      residents: Number(agg?.residents ?? 0),
      averageScore: Number(Number(agg?.avg_score ?? 0).toFixed(2)),
      maxScore: Number(agg?.max_score ?? 0),
      neverWon: Number(agg?.never_won ?? 0),
      distribution: distribution.map((d) => ({
        score: Number(d.score),
        residents: Number(d.residents),
      })),
    };
  }

  async getRunAssignments(runId: string) {
    return this.db
      .selectFrom('spot_assignment as sa')
      .innerJoin('resident as r', 'r.id', 'sa.resident_id')
      .innerJoin('parking_spot as ps', 'ps.id', 'sa.spot_id')
      .select(['sa.resident_id as residentId', 'r.full_name as fullName', 'ps.spot_code as spotCode'])
      .where('sa.run_id', '=', runId)
      .orderBy('ps.spot_code')
      .execute();
  }

  /** UC-07 — the quarterly export. One row per participant, assigned or not. */
  async getQuarterlyReport(cycleId: string) {
    const rows = await this.db
      .selectFrom('allocation_history as ah')
      .innerJoin('resident as r', 'r.id', 'ah.resident_id')
      .leftJoin('parking_spot as ps', 'ps.id', 'ah.spot_id')
      .select([
        'ah.resident_id as residentId',
        'r.full_name as fullName',
        'r.unit_number as unitNumber',
        'ah.result as result',
        'ps.spot_code as spotCode',
        'ah.waitlist_position as position',
        'ah.fairness_score_at_draw as scoreAtDraw',
      ])
      .where('ah.cycle_id', '=', cycleId)
      .orderBy('ah.result')
      .orderBy('r.unit_number')
      .execute();

    return rows.map((r) => ({
      ...r,
      spotCode: r.spotCode ?? null,
      position: r.position ?? null,
      scoreAtDraw: Number(r.scoreAtDraw),
    }));
  }
}
