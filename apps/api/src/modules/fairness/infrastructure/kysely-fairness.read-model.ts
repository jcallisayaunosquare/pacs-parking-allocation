import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../shared/db/schema';
import type {
  FairnessFacts,
  FairnessReadModel,
  HistoryEntry,
  RunCandidateRowRaw,
} from '../application/dashboard.use-cases';

/**
 * The read model. It emits facts - anchors, counts, stored keys - and never computes a
 * priority key: that formula exists once, in the domain. Duplicating it here would
 * guarantee the dashboard and the run page drift apart, and the drift would surface as a
 * resident noticing before we did.
 */
export class KyselyFairnessReadModel implements FairnessReadModel {
  constructor(private readonly db: Kysely<Database>) {}

  /** Served by ix_assignment_served_end and ix_assignment_served_count. */
  async getFacts(residentId: string): Promise<FairnessFacts | null> {
    const r = await this.db
      .selectFrom('resident as r')
      .select((eb) => [
        'r.participation_started_at as participationStartedAt',
        eb
          .selectFrom('spot_assignment as sa')
          .select(sql<Date | null>`max(sa.benefit_ended_at)`.as('v'))
          .whereRef('sa.resident_id', '=', 'r.id')
          .where('sa.counts_as_served', '=', true)
          .as('lastBenefitEndAt'),
        eb
          .selectFrom('spot_assignment as sa2')
          .select(sql<string>`count(*)`.as('v'))
          .whereRef('sa2.resident_id', '=', 'r.id')
          .where('sa2.counts_as_served', '=', true)
          .as('servedCount'),
        eb
          .selectFrom('allocation_history as ah')
          .select(sql<string>`count(distinct ah.run_id)`.as('v'))
          .whereRef('ah.resident_id', '=', 'r.id')
          .as('priorParticipations'),
      ])
      .where('r.id', '=', residentId)
      .executeTakeFirst();

    if (!r) return null;
    return {
      participationStartedAt: new Date(r.participationStartedAt),
      lastBenefitEndAt: r.lastBenefitEndAt === null ? null : new Date(r.lastBenefitEndAt),
      servedCount: Number(r.servedCount ?? 0),
      priorParticipations: Number(r.priorParticipations ?? 0),
    };
  }

  /**
   * Served by ix_history_resident_recent, joined to the stored priority key so a past
   * outcome is explained by the numbers that decided it rather than by today's.
   */
  async getHistory(residentId: string, limit: number): Promise<readonly HistoryEntry[]> {
    const rows = await this.db
      .selectFrom('allocation_history as ah')
      .innerJoin('allocation_cycle as ac', 'ac.id', 'ah.cycle_id')
      .leftJoin('parking_spot as ps', 'ps.id', 'ah.spot_id')
      .leftJoin('allocation_run_candidate as arc', (join) =>
        join.onRef('arc.run_id', '=', 'ah.run_id').onRef('arc.resident_id', '=', 'ah.resident_id'),
      )
      .innerJoin('allocation_run as ar', 'ar.id', 'ah.run_id')
      .innerJoin('allocation_config as cfg', 'cfg.version', 'ar.config_version')
      .select([
        'ac.label as cycle',
        'ah.result as result',
        'ps.spot_code as spotCode',
        'ah.waitlist_position as position',
        sql<string | null>`arc.effective_wait_quanta * cfg.wait_quantum_minutes / 60`.as(
          'effectiveWaitHours',
        ),
        'arc.served_count as servedCountAtDraw',
        'arc.bias_applied as biasApplied',
        'arc.final_rank as finalRank',
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
      effectiveWaitHours: r.effectiveWaitHours === null ? null : Number(r.effectiveWaitHours),
      servedCountAtDraw: r.servedCountAtDraw === null ? null : Number(r.servedCountAtDraw),
      biasApplied: r.biasApplied ?? null,
      finalRank: r.finalRank ?? null,
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

  /**
   * FR-22. Every number here is computed from timestamps at query time, so the admin
   * dashboard cannot disagree with a run: there is no materialised score to go stale.
   */
  async getMetrics(now: Date) {
    const agg = await this.db
      .selectFrom('resident as r')
      .select((eb) => [
        eb.fn.countAll<string>().as('residents'),
        sql<string>`coalesce(avg(extract(epoch from (${now} - greatest(
          r.participation_started_at,
          coalesce((select max(sa.benefit_ended_at) from spot_assignment sa
                    where sa.resident_id = r.id and sa.counts_as_served),
                   r.participation_started_at)
        ))) / 3600), 0)`.as('avg_wait_hours'),
        sql<string>`coalesce(max(extract(epoch from (${now} - greatest(
          r.participation_started_at,
          coalesce((select max(sa.benefit_ended_at) from spot_assignment sa
                    where sa.resident_id = r.id and sa.counts_as_served),
                   r.participation_started_at)
        ))) / 3600), 0)`.as('max_wait_hours'),
        sql<string>`count(*) filter (where not exists (
          select 1 from spot_assignment sa where sa.resident_id = r.id and sa.counts_as_served
        ))`.as('never_served'),
      ])
      .where('r.deactivated_at', 'is', null)
      .where('r.is_admin', '=', false)
      .executeTakeFirst();

    const distribution = await this.db
      .selectFrom('resident as r')
      .select((eb) => [
        sql<string>`(select count(*) from spot_assignment sa
                     where sa.resident_id = r.id and sa.counts_as_served)`.as('served_count'),
        eb.fn.countAll<string>().as('residents'),
      ])
      .where('r.deactivated_at', 'is', null)
      .where('r.is_admin', '=', false)
      .groupBy(
        sql`(select count(*) from spot_assignment sa
             where sa.resident_id = r.id and sa.counts_as_served)`,
      )
      .orderBy(
        sql`(select count(*) from spot_assignment sa
             where sa.resident_id = r.id and sa.counts_as_served)`,
      )
      .execute();

    return {
      residents: Number(agg?.residents ?? 0),
      averageWaitHours: Math.round(Number(agg?.avg_wait_hours ?? 0)),
      maxWaitHours: Math.round(Number(agg?.max_wait_hours ?? 0)),
      neverServed: Number(agg?.never_served ?? 0),
      distribution: distribution.map((d) => ({
        servedCount: Number(d.served_count),
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

  /** UC-07 - the period export. One row per participant, assigned or not. */
  async getPeriodReport(cycleId: string) {
    const rows = await this.db
      .selectFrom('allocation_history as ah')
      .innerJoin('resident as r', 'r.id', 'ah.resident_id')
      .leftJoin('parking_spot as ps', 'ps.id', 'ah.spot_id')
      .leftJoin('allocation_run_candidate as arc', (join) =>
        join.onRef('arc.run_id', '=', 'ah.run_id').onRef('arc.resident_id', '=', 'ah.resident_id'),
      )
      .innerJoin('allocation_run as ar', 'ar.id', 'ah.run_id')
      .innerJoin('allocation_config as cfg', 'cfg.version', 'ar.config_version')
      .select([
        'ah.resident_id as residentId',
        'r.full_name as fullName',
        'r.unit_number as unitNumber',
        'ah.result as result',
        'ps.spot_code as spotCode',
        'ah.waitlist_position as position',
        sql<string | null>`arc.effective_wait_quanta * cfg.wait_quantum_minutes / 60`.as(
          'effectiveWaitHours',
        ),
        'arc.served_count as servedCountAtDraw',
      ])
      .where('ah.cycle_id', '=', cycleId)
      .orderBy('ah.result')
      .orderBy('r.unit_number')
      .execute();

    return rows.map((r) => ({
      residentId: r.residentId,
      fullName: r.fullName,
      unitNumber: r.unitNumber,
      result: r.result,
      spotCode: r.spotCode ?? null,
      position: r.position ?? null,
      effectiveWaitHours: r.effectiveWaitHours === null ? null : Number(r.effectiveWaitHours),
      servedCountAtDraw: r.servedCountAtDraw === null ? null : Number(r.servedCountAtDraw),
    }));
  }

  /** The contestable record for one run, in the order the run decided. */
  async getRunCandidates(runId: string): Promise<readonly RunCandidateRowRaw[]> {
    const rows = await this.db
      .selectFrom('allocation_run_candidate as arc')
      .innerJoin('resident as r', 'r.id', 'arc.resident_id')
      .leftJoin('parking_spot as ps', 'ps.id', 'arc.spot_id')
      .select([
        'arc.resident_id as residentId',
        'r.unit_number as unitNumber',
        'arc.anchor_at as anchorAt',
        'arc.raw_wait_quanta as rawWaitQuanta',
        'arc.effective_wait_quanta as effectiveWaitQuanta',
        'arc.bias_applied as biasApplied',
        'arc.first_time as firstTime',
        'arc.served_count as servedCount',
        'arc.raffle_token as raffleToken',
        'arc.final_rank as finalRank',
        'arc.pool as pool',
        'arc.outcome as outcome',
        'ps.spot_code as spotCode',
      ])
      .where('arc.run_id', '=', runId)
      .orderBy('arc.final_rank')
      .execute();

    return rows.map((r) => ({
      residentId: r.residentId,
      unitNumber: r.unitNumber,
      anchorAt: new Date(r.anchorAt),
      rawWaitQuanta: Number(r.rawWaitQuanta),
      effectiveWaitQuanta: Number(r.effectiveWaitQuanta),
      biasApplied: r.biasApplied,
      firstTime: r.firstTime,
      servedCount: Number(r.servedCount),
      raffleToken: String(r.raffleToken),
      finalRank: Number(r.finalRank),
      pool: r.pool ?? null,
      outcome: r.outcome,
      spotCode: r.spotCode ?? null,
    }));
  }
}
