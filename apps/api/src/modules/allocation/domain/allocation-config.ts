/**
 * The fairness policy's knobs (rule A). Every value is admin-editable and versioned, and
 * nothing here is ever a literal anywhere else in the codebase: a run stamps the version
 * it used, so changing the bias tomorrow cannot retroactively rewrite why someone lost
 * today (fairness ADR sections 1.1 and 7.2).
 */
export interface AllocationConfig {
  /** Rule A - months. Default 3. Drives cycle length, the cycle label and the absence reset. */
  readonly allocationDurationMonths: number;
  /** Rule F - hours. Default 24. The Early-Waiting Bias window. */
  readonly earlyWaitingBiasHours: number;
  /** Minutes. Default 60. The granularity at which two waiting times count as equal. */
  readonly waitQuantumMinutes: number;
  /**
   * Rule H - consecutive periods a resident may sit out before waiting restarts.
   * 1 means missing a single period costs the clock. null disables the reset.
   */
  readonly absenceResetPeriods: number | null;
  /** Bays the HOA declares allocatable. 0 means "however many are active in inventory". */
  readonly totalBays: number;
  /** Stamped onto the run so a past decision is explainable under the config then in force. */
  readonly version: number;
}

/**
 * A stored version, with the audit columns the table keeps.
 *
 * Deliberately not part of `AllocationConfig`: the allocation domain takes a policy
 * value and has no business knowing who typed it or when. This shape exists for the
 * history view, which is where "who changed the period length, and when" is the whole
 * question - a version number on its own answers nothing.
 */
export interface AllocationConfigVersion extends AllocationConfig {
  readonly changedAt: Date;
  /** The administrator's resident row, where they have one. */
  readonly changedBy: string | null;
}

/** Rule A's defaults. The only place these numbers appear. */
export const DEFAULT_ALLOCATION_CONFIG: Omit<AllocationConfig, 'version'> = {
  allocationDurationMonths: 3,
  earlyWaitingBiasHours: 24,
  waitQuantumMinutes: 60,
  absenceResetPeriods: 1,
  totalBays: 0,
};

/** The fields an administrator may change. Absent means "leave as it is". */
export interface AllocationConfigPatch {
  readonly allocationDurationMonths?: number;
  readonly earlyWaitingBiasHours?: number;
  readonly waitQuantumMinutes?: number;
  readonly absenceResetPeriods?: number | null;
  readonly totalBays?: number;
}

const HOURS_PER_YEAR = 8760;

/**
 * Bounds, as the DDL's CHECK constraints express them. Validated in the domain as well as
 * in the database so the admin gets a field-level message rather than a 500.
 */
export function validateConfig(
  c: Omit<AllocationConfig, 'version'>,
): ReadonlyArray<{ field: string; issue: string }> {
  const issues: { field: string; issue: string }[] = [];
  const int = (v: number): boolean => Number.isInteger(v);

  if (!int(c.allocationDurationMonths) || c.allocationDurationMonths < 1 || c.allocationDurationMonths > 60) {
    issues.push({ field: 'allocationDurationMonths', issue: 'must be a whole number of months, 1 to 60' });
  }
  if (!int(c.earlyWaitingBiasHours) || c.earlyWaitingBiasHours < 0 || c.earlyWaitingBiasHours > HOURS_PER_YEAR) {
    issues.push({ field: 'earlyWaitingBiasHours', issue: `must be a whole number of hours, 0 to ${HOURS_PER_YEAR}` });
  }
  if (!int(c.waitQuantumMinutes) || c.waitQuantumMinutes < 1) {
    issues.push({ field: 'waitQuantumMinutes', issue: 'must be a whole number of minutes, at least 1' });
  }
  if (c.absenceResetPeriods !== null && (!int(c.absenceResetPeriods) || c.absenceResetPeriods < 1)) {
    issues.push({
      field: 'absenceResetPeriods',
      issue: 'must be null or a whole number of periods, at least 1',
    });
  }
  if (!int(c.totalBays) || c.totalBays < 0) {
    issues.push({ field: 'totalBays', issue: 'must be a whole number, 0 or more' });
  }
  return issues;
}

/**
 * Soft warnings: legal values that produce a surprising policy. A bias wider than the
 * allocation period makes every previous holder permanently cooling, which freezes the
 * ordering - a plausible, catastrophic typo, so it is surfaced rather than rejected
 * (fairness ADR, edge case E-7).
 */
export function configWarnings(c: Omit<AllocationConfig, 'version'>): readonly string[] {
  const warnings: string[] = [];
  const periodHours = c.allocationDurationMonths * 730;
  if (c.earlyWaitingBiasHours > periodHours) {
    warnings.push(
      `earlyWaitingBiasHours (${c.earlyWaitingBiasHours}) exceeds one allocation period ` +
        `(about ${periodHours} h), so every previous holder stays cooling and the normal order freezes.`,
    );
  }
  if (c.waitQuantumMinutes >= 1440) {
    warnings.push(
      `waitQuantumMinutes (${c.waitQuantumMinutes}) buckets waiting time by the day or coarser, ` +
        'so the raffle decides far more often than waiting time does.',
    );
  }
  if (c.earlyWaitingBiasHours > 0 && c.earlyWaitingBiasHours * 60 < c.waitQuantumMinutes) {
    warnings.push(
      'earlyWaitingBiasHours is smaller than one wait quantum, so the Early-Waiting Bias rounds away to nothing.',
    );
  }
  return warnings;
}

export const applyConfigPatch = (
  current: AllocationConfig,
  patch: AllocationConfigPatch,
): Omit<AllocationConfig, 'version'> => ({
  allocationDurationMonths: patch.allocationDurationMonths ?? current.allocationDurationMonths,
  earlyWaitingBiasHours: patch.earlyWaitingBiasHours ?? current.earlyWaitingBiasHours,
  waitQuantumMinutes: patch.waitQuantumMinutes ?? current.waitQuantumMinutes,
  absenceResetPeriods:
    patch.absenceResetPeriods === undefined ? current.absenceResetPeriods : patch.absenceResetPeriods,
  totalBays: patch.totalBays ?? current.totalBays,
});

/** The Early-Waiting Bias, in whole wait quanta. Integer arithmetic only, by design. */
export const biasQuanta = (c: Pick<AllocationConfig, 'earlyWaitingBiasHours' | 'waitQuantumMinutes'>): number =>
  Math.round((c.earlyWaitingBiasHours * 60) / c.waitQuantumMinutes);
