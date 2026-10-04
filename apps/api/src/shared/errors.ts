import { err, type DomainFailure, type DomainFailureCode, type Result } from './result';

/** Factories so failure codes are never spelled out as free strings at call sites. */
export const failure = (
  code: DomainFailureCode,
  message: string,
  details?: ReadonlyArray<{ field: string; issue: string }>,
): DomainFailure => (details ? { code, message, details } : { code, message });

export const fail = <T = never>(
  code: DomainFailureCode,
  message: string,
  details?: ReadonlyArray<{ field: string; issue: string }>,
): Result<T, DomainFailure> => err(failure(code, message, details));

export const notFound = (what: string): DomainFailure =>
  failure('NOT_FOUND', `${what} not found.`);

export const forbidden = (why = 'You are not allowed to perform this action.'): DomainFailure =>
  failure('FORBIDDEN', why);

/**
 * Thrown only across the infrastructure boundary (a repository that cannot satisfy its
 * contract). The composition root turns it into INTERNAL_ERROR with a traceId (§16).
 */
export class InfrastructureError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'InfrastructureError';
  }
}

/** Raised by the repository when the partial unique index rejects a second run (§12, guard 1). */
export class RunLockHeldError extends Error {
  constructor() {
    super('An allocation run is already executing.');
    this.name = 'RunLockHeldError';
  }
}
