import { ApiError, type ErrorCode } from '@salon/contracts';
import { ZodError, type ZodTypeAny, type z } from 'zod';

export { ApiError };

/** Postgres SQLSTATE codes this application reacts to specifically. */
const PG_EXCLUSION_VIOLATION = '23P01';
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_CHECK_VIOLATION = '23514';

/**
 * Transient contention, as distinct from a definitive answer.
 *
 * Concurrent bookings of one slot serialise in the database, and under load
 * that contention can surface as a deadlock, a lock timeout, a cancelled
 * statement, or an exhausted connection pool. None of those mean "that time is
 * taken" — they mean "ask again" — and all of them were previously falling
 * through to an untyped 500, which the voice agent cannot act on and which
 * therefore reached a caller as "something went wrong".
 */
const PG_TRANSIENT_CONTENTION = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '57014', // query_canceled — our statement_timeout fired
  '53300', // too_many_connections
  '08006', // connection_failure
]);

interface PgError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
}

function isPgError(err: unknown): err is PgError {
  return err instanceof Error && typeof (err as PgError).code === 'string';
}

/**
 * Translate a database constraint violation into the API's error vocabulary.
 *
 * This is the bridge that makes the exclusion constraint usable as a
 * concurrency primitive: two callers race for a slot, Postgres rejects the
 * loser with 23P01, and the loser's agent receives SLOT_UNAVAILABLE — a code it
 * already knows how to recover from by offering alternatives. Without this
 * mapping the race would surface as a 500.
 */
export function translateDatabaseError(err: unknown): ApiError | null {
  if (!isPgError(err)) return null;

  switch (err.code) {
    case PG_EXCLUSION_VIOLATION:
      if (err.constraint === 'appointments_no_overlap') {
        return new ApiError(
          'SLOT_UNAVAILABLE',
          'That time was taken while we were booking it.',
          { reason: 'concurrent_booking' },
        );
      }
      return new ApiError('SLOT_UNAVAILABLE', 'That time is no longer available.');

    case PG_UNIQUE_VIOLATION:
      if (err.constraint === 'customers_salon_phone_key') {
        return new ApiError(
          'DUPLICATE_CUSTOMER_PHONE',
          'A customer with that phone number already exists.',
          { field: 'phone' },
        );
      }
      if (err.constraint === 'services_salon_name_key') {
        return new ApiError('VALIDATION_FAILED', 'A service with that name already exists.', {
          field: 'name',
        });
      }
      if (err.constraint === 'closed_dates_salon_date_key') {
        return new ApiError('VALIDATION_FAILED', 'That date already has a closure entry.', {
          field: 'date',
        });
      }
      return new ApiError('VALIDATION_FAILED', 'That record already exists.', {
        constraint: err.constraint,
      });

    case PG_FOREIGN_KEY_VIOLATION:
      // Composite (id, salon_id) foreign keys mean this also fires when a
      // request references another salon's data — a tenancy breach caught by
      // the schema itself.
      return new ApiError('VALIDATION_FAILED', 'A referenced record does not exist for this salon.', {
        constraint: err.constraint,
      });

    case PG_CHECK_VIOLATION:
      return new ApiError('VALIDATION_FAILED', 'The request violates a data integrity rule.', {
        constraint: err.constraint,
      });

    default:
      break;
  }

  if (err.code && PG_TRANSIENT_CONTENTION.has(err.code)) {
    return new ApiError(
      'SERVICE_UNAVAILABLE',
      'The salon system is busy. Please try that again in a moment.',
      { reason: 'contention', sqlstate: err.code },
    );
  }

  // The connection pool timing out has no SQLSTATE — it never reached Postgres
  // — but it is the same class of problem and the same correct response.
  if (/timeout exceeded when trying to connect|Connection terminated/i.test(err.message)) {
    return new ApiError(
      'SERVICE_UNAVAILABLE',
      'The salon system is busy. Please try that again in a moment.',
      { reason: 'pool_exhausted' },
    );
  }

  return null;
}

/** Field-level detail for a validation failure, shaped for a UI to render inline. */
export function zodIssues(error: ZodError): Record<string, unknown> {
  return {
    fields: error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
      code: issue.code,
    })),
  };
}

/**
 * Parse untrusted input, raising the API's structured validation error.
 * Never a bare 500 for bad input — the caller gets the field and the reason.
 */
export function parseOrThrow<T extends ZodTypeAny>(
  schema: T,
  data: unknown,
  source: 'body' | 'query' | 'params' | 'headers',
): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiError('VALIDATION_FAILED', `Invalid request ${source}.`, {
      source,
      ...zodIssues(result.error),
    });
  }
  return result.data;
}

export function notFound(code: ErrorCode, message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(code, message, details);
}
