import type { Kysely } from 'kysely';
import { InfrastructureError } from '../../../shared/errors';
import type { Database } from '../../../shared/db/schema';
import {
  DEFAULT_ALLOCATION_CONFIG,
  type AllocationConfig,
  type AllocationConfigVersion,
} from '../domain/allocation-config';
import type { AllocationConfigProvider } from '../application/ports';

type Row = {
  version: number;
  allocation_duration_months: number;
  early_waiting_bias_hours: number;
  wait_quantum_minutes: number;
  decline_grace_hours: number;
  absence_reset_months: number | null;
  total_bays: number;
  changed_by: string | null;
  changed_at: Date;
};

const toConfig = (r: Row): AllocationConfig => ({
  version: Number(r.version),
  allocationDurationMonths: Number(r.allocation_duration_months),
  earlyWaitingBiasHours: Number(r.early_waiting_bias_hours),
  waitQuantumMinutes: Number(r.wait_quantum_minutes),
  declineGraceHours: Number(r.decline_grace_hours),
  absenceResetMonths: r.absence_reset_months === null ? null : Number(r.absence_reset_months),
  totalBays: Number(r.total_bays),
});

/** The same row, keeping the audit columns the history view is actually asking for. */
const toVersion = (r: Row): AllocationConfigVersion => ({
  ...toConfig(r),
  changedAt: new Date(r.changed_at),
  changedBy: r.changed_by,
});

/** Warm invocations should not pay for a round trip on every request (section 7.2 of the ADR). */
const MEMO_TTL_MS = 60_000;

/**
 * allocation_config, in Postgres rather than SSM or AppConfig: the version a run used has
 * to be joinable and FK-referenceable from allocation_run, which is the whole point of
 * versioning it. An edit inserts a new row, so the values a past run was decided under
 * survive every later change.
 */
export class KyselyAllocationConfigProvider implements AllocationConfigProvider {
  private memo: { at: number; config: AllocationConfig } | null = null;

  constructor(private readonly db: Kysely<Database>) {}

  async current(): Promise<AllocationConfig> {
    if (this.memo && Date.now() - this.memo.at < MEMO_TTL_MS) return this.memo.config;

    const row = await this.db
      .selectFrom('allocation_config')
      .selectAll()
      .orderBy('version', 'desc')
      .executeTakeFirst();

    // An empty table means the migration's seed row is missing, which would otherwise
    // surface as a confusing NOT NULL violation on the next run. Rule A's defaults are
    // the honest answer, and they are the same numbers the DDL defaults to.
    const config: AllocationConfig = row
      ? toConfig(row as Row)
      : { ...DEFAULT_ALLOCATION_CONFIG, version: 0 };

    this.memo = { at: Date.now(), config };
    return config;
  }

  async atVersion(version: number): Promise<AllocationConfig | null> {
    const row = await this.db
      .selectFrom('allocation_config')
      .selectAll()
      .where('version', '=', version)
      .executeTakeFirst();
    return row ? toConfig(row as Row) : null;
  }

  async insert(
    values: Omit<AllocationConfig, 'version'>,
    changedBy: string | null,
  ): Promise<AllocationConfig> {
    try {
      const row = await this.db
        .insertInto('allocation_config')
        .values({
          allocation_duration_months: values.allocationDurationMonths,
          early_waiting_bias_hours: values.earlyWaitingBiasHours,
          wait_quantum_minutes: values.waitQuantumMinutes,
          decline_grace_hours: values.declineGraceHours,
          absence_reset_months: values.absenceResetMonths,
          total_bays: values.totalBays,
          changed_by: changedBy,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      this.memo = null;
      return toConfig(row as Row);
    } catch (e) {
      throw new InfrastructureError('Could not save the allocation configuration.', e);
    }
  }

  async history(limit: number): Promise<readonly AllocationConfigVersion[]> {
    const rows = await this.db
      .selectFrom('allocation_config')
      .selectAll()
      .orderBy('version', 'desc')
      .limit(limit)
      .execute();
    return rows.map((r) => toVersion(r as Row));
  }
}
