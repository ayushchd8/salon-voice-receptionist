/**
 * The API's error contract.
 *
 * Every non-2xx response from the CRM API has exactly this shape. `code` is a
 * closed enum shared by the server that emits it and the voice agent that
 * consumes it, so the agent branches on codes and never parses prose. Changing
 * a human-readable message is then a copy edit, not a breaking change.
 */
import { z } from 'zod';

export const ERROR_CODES = [
  // ── request / auth ─────────────────────────────────────────────────────────
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN_SCOPE',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',

  // ── resource lookup ────────────────────────────────────────────────────────
  'CUSTOMER_NOT_FOUND',
  'SERVICE_NOT_FOUND',
  'STAFF_NOT_FOUND',
  'APPOINTMENT_NOT_FOUND',
  'CALL_NOT_FOUND',
  'DUPLICATE_CUSTOMER_PHONE',

  // ── scheduling: the slot itself ────────────────────────────────────────────
  'SLOT_UNAVAILABLE',
  'OUTSIDE_BUSINESS_HOURS',
  'SALON_CLOSED_ON_DATE',
  'STAFF_NOT_WORKING',
  'STAFF_CANNOT_PERFORM_SERVICE',
  'NO_STAFF_AVAILABLE',

  // ── scheduling: policy ─────────────────────────────────────────────────────
  'SERVICE_INACTIVE',
  'BOOKING_IN_PAST',
  'LEAD_TIME_TOO_SHORT',
  'TOO_FAR_IN_ADVANCE',
  'CANCELLATION_WINDOW_PASSED',
  'APPOINTMENT_NOT_MODIFIABLE',
  'MAX_ACTIVE_APPOINTMENTS_REACHED',
  'OVERBOOKING_NOT_ALLOWED',

  // ── idempotency ────────────────────────────────────────────────────────────
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_REQUEST_IN_PROGRESS',

  // ── time parsing ───────────────────────────────────────────────────────────
  'UNPARSEABLE_TIME_EXPRESSION',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.record(z.unknown()).optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorSchema>;

/** HTTP status each code maps to. Single source of truth for both sides. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN_SCOPE: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,

  CUSTOMER_NOT_FOUND: 404,
  SERVICE_NOT_FOUND: 404,
  STAFF_NOT_FOUND: 404,
  APPOINTMENT_NOT_FOUND: 404,
  CALL_NOT_FOUND: 404,
  DUPLICATE_CUSTOMER_PHONE: 409,

  SLOT_UNAVAILABLE: 409,
  OUTSIDE_BUSINESS_HOURS: 422,
  SALON_CLOSED_ON_DATE: 422,
  STAFF_NOT_WORKING: 422,
  STAFF_CANNOT_PERFORM_SERVICE: 422,
  NO_STAFF_AVAILABLE: 409,

  SERVICE_INACTIVE: 422,
  BOOKING_IN_PAST: 422,
  LEAD_TIME_TOO_SHORT: 422,
  TOO_FAR_IN_ADVANCE: 422,
  CANCELLATION_WINDOW_PASSED: 422,
  APPOINTMENT_NOT_MODIFIABLE: 422,
  MAX_ACTIVE_APPOINTMENTS_REACHED: 422,
  OVERBOOKING_NOT_ALLOWED: 422,

  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_REUSED: 422,
  IDEMPOTENCY_REQUEST_IN_PROGRESS: 409,

  UNPARSEABLE_TIME_EXPRESSION: 422,
};

/**
 * Codes the voice agent may safely retry with the same idempotency key.
 * Everything else is a definitive answer and retrying only wastes call time.
 */
export const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'RATE_LIMITED',
  'IDEMPOTENCY_REQUEST_IN_PROGRESS',
]);

/**
 * Codes the agent can recover from conversationally by offering the caller
 * a different time, rather than escalating.
 */
export const RECOVERABLE_SCHEDULING_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'SLOT_UNAVAILABLE',
  'OUTSIDE_BUSINESS_HOURS',
  'SALON_CLOSED_ON_DATE',
  'STAFF_NOT_WORKING',
  'NO_STAFF_AVAILABLE',
  'LEAD_TIME_TOO_SHORT',
  'TOO_FAR_IN_ADVANCE',
  'BOOKING_IN_PAST',
]);

/** Structured error carrying an API error code. Thrown by services, rendered by the error handler. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }

  toBody(requestId?: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}
