import { z } from 'zod';

export const UuidSchema = z.string().uuid();

/** ISO-8601 instant with an offset, e.g. 2026-10-01T09:30:00.000Z */
export const IsoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .describe('ISO-8601 instant, e.g. "2026-10-01T09:30:00.000Z"');

/** Calendar date in the salon's local timezone, YYYY-MM-DD */
export const LocalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .describe('Calendar date in salon-local time, e.g. "2026-10-01"');

/** Wall-clock time in the salon's local timezone, HH:MM or HH:MM:SS */
export const LocalTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'must be HH:MM')
  .transform((v) => (v.length === 5 ? `${v}:00` : v))
  .describe('Salon-local wall-clock time, e.g. "09:30"');

/**
 * Phone numbers are accepted in whatever shape a human types or a telephony
 * provider supplies, and normalised to E.164 by `normalizePhone` in
 * @salon/core before they ever reach the database. Validation here is
 * deliberately permissive; normalisation is where correctness happens, so
 * "+44 7700 900123" and "07700900123" resolve to the same customer.
 */
export const PhoneInputSchema = z
  .string()
  .trim()
  .min(7, 'phone number is too short')
  .max(25, 'phone number is too long')
  .regex(/^[+()\-.\s\d]+$/, 'phone number contains unexpected characters');

/** E.164 as stored. */
export const PhoneSchema = z.string().regex(/^\+[1-9]\d{6,14}$/, 'must be E.164, e.g. +447700900123');

export const EmailSchema = z.string().email().max(254);

/** numeric(10,2) is carried as a string end-to-end — never parsed into a float. */
export const MoneySchema = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'must be a decimal amount, e.g. "42.50"')
  .describe('Decimal amount as a string, e.g. "42.50"');

export const MoneyInputSchema = z.union([
  MoneySchema,
  z.number().nonnegative().transform((n) => n.toFixed(2)),
]);

export const CurrencySchema = z.string().length(3).toUpperCase();

/** 0 = Sunday … 6 = Saturday, matching JavaScript's Date#getDay. */
export const DayOfWeekSchema = z.number().int().min(0).max(6);

export const IanaTimezoneSchema = z.string().min(1).max(64);

export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    pagination: z.object({
      limit: z.number().int(),
      offset: z.number().int(),
      total: z.number().int(),
      hasMore: z.boolean(),
    }),
  });
}

/** Client-generated idempotency key sent in the `Idempotency-Key` header. */
export const IdempotencyKeySchema = z
  .string()
  .min(8, 'idempotency key must be at least 8 characters')
  .max(255)
  .regex(/^[A-Za-z0-9_:.-]+$/, 'idempotency key must be URL-safe');
