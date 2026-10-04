/**
 * Use cases return a Result instead of throwing. The application ring never knows
 * about HTTP; the adapter decides what a failure looks like on the wire (§10).
 */
export type Result<T, E = DomainFailure> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;

/** The vocabulary of failures the domain can express. Maps to HTTP in the adapter (§16). */
export interface DomainFailure {
  readonly code: DomainFailureCode;
  readonly message: string;
  readonly details?: ReadonlyArray<{ field: string; issue: string }>;
}

export type DomainFailureCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_ELIGIBLE'
  | 'NOT_FOUND'
  | 'RAFFLE_IN_PROGRESS'
  | 'REGISTRATION_CLOSED'
  | 'SPOT_IN_USE'
  | 'ALREADY_REGISTERED'
  | 'INVALID_CYCLE_STATE'
  | 'NO_SPOTS_AVAILABLE'
  | 'INTERNAL_ERROR';
