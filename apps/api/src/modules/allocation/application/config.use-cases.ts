import { fail } from '../../../shared/errors';
import { ok, type Result } from '../../../shared/result';
import {
  applyConfigPatch,
  configWarnings,
  validateConfig,
  type AllocationConfig,
  type AllocationConfigPatch,
  type AllocationConfigVersion,
} from '../domain/allocation-config';
import type { AllocationConfigProvider, CachePort } from './ports';

export interface ConfigView {
  readonly config: AllocationConfig;
  /** Legal values that produce a surprising policy. Shown, never enforced (E-7). */
  readonly warnings: readonly string[];
}

/**
 * Rule A's admin surface. Two things worth noting:
 *
 *   - an edit inserts a new version rather than updating a row, so a run that stamped
 *     version 4 is still explainable after version 5 exists;
 *   - the values are validated in the domain, so the administrator gets a field-level
 *     message instead of a CHECK-constraint violation.
 */
export class ConfigUseCases {
  constructor(
    private readonly provider: AllocationConfigProvider,
    private readonly cache: CachePort,
  ) {}

  async current(): Promise<Result<ConfigView>> {
    const config = await this.provider.current();
    return ok({ config, warnings: configWarnings(config) });
  }

  async history(limit: number): Promise<Result<readonly AllocationConfigVersion[]>> {
    return ok(await this.provider.history(limit));
  }

  async update(patch: AllocationConfigPatch, changedBy: string | null): Promise<Result<ConfigView>> {
    if (Object.keys(patch).length === 0) {
      return fail('VALIDATION_FAILED', 'Nothing to change.', [
        { field: '(body)', issue: 'at least one field is required' },
      ]);
    }

    const current = await this.provider.current();
    const next = applyConfigPatch(current, patch);

    const issues = validateConfig(next);
    if (issues.length > 0) {
      return fail('VALIDATION_FAILED', 'The configuration failed validation.', issues);
    }

    const saved = await this.provider.insert(next, changedBy);

    // Cycles and runs pin the values they used, so a change affects the next cycle only.
    // The caches that read the config in force are the only thing that has to be told.
    await this.cache.invalidate('config:').catch(() => undefined);
    await this.cache.invalidate('dashboard:').catch(() => undefined);

    return ok({ config: saved, warnings: configWarnings(saved) });
  }
}
