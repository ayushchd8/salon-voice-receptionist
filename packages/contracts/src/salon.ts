import { z } from 'zod';
import {
  CurrencySchema,
  DayOfWeekSchema,
  IanaTimezoneSchema,
  LocalDateSchema,
  LocalTimeSchema,
  MoneyInputSchema,
  MoneySchema,
  UuidSchema,
} from './common.js';

export const SalonSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  slug: z.string(),
  timezone: IanaTimezoneSchema,
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
});
export type Salon = z.infer<typeof SalonSchema>;

// ── business hours ────────────────────────────────────────────────────────────
export const BusinessHoursDaySchema = z
  .object({
    dayOfWeek: DayOfWeekSchema,
    isClosed: z.boolean(),
    openTime: LocalTimeSchema.nullable(),
    closeTime: LocalTimeSchema.nullable(),
  })
  .refine((d) => (d.isClosed ? !d.openTime && !d.closeTime : !!d.openTime && !!d.closeTime), {
    message: 'an open day needs both openTime and closeTime; a closed day needs neither',
  })
  .refine((d) => d.isClosed || (d.openTime! < d.closeTime!), {
    message: 'openTime must be before closeTime',
  });
export type BusinessHoursDay = z.infer<typeof BusinessHoursDaySchema>;

/**
 * Base shape kept unrefined so it can still be `.extend`ed and `.omit`ted —
 * Zod's `.refine` returns a ZodEffects wrapper that loses those methods.
 * The cross-field rules are applied by `withClosedDateRules` below.
 */
const ClosedDateBaseSchema = z.object({
  date: LocalDateSchema,
  reason: z.string().max(200).nullish().default(null),
  // Both null => closed all day. Both set => special hours for that date.
  openTime: LocalTimeSchema.nullish().default(null),
  closeTime: LocalTimeSchema.nullish().default(null),
});

type ClosedDateShape = {
  openTime?: string | null;
  closeTime?: string | null;
};

/**
 * Cross-field rules, applied via `superRefine` rather than a generic wrapper so
 * the schema's output type survives — `.refine` on a widened `z.ZodType<Shape>`
 * would erase the `date`/`reason`/`id` fields from the inferred type.
 */
function closedDateRules(value: ClosedDateShape, ctx: z.RefinementCtx): void {
  if ((value.openTime == null) !== (value.closeTime == null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['openTime'],
      message:
        'openTime and closeTime must be provided together, or both omitted for a full-day closure',
    });
  }
  if (value.openTime != null && value.closeTime != null && value.openTime >= value.closeTime) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['closeTime'],
      message: 'openTime must be before closeTime',
    });
  }
}

export const ClosedDateSchema = ClosedDateBaseSchema.extend({ id: UuidSchema }).superRefine(closedDateRules);
export type ClosedDate = z.infer<typeof ClosedDateSchema>;

export const CreateClosedDateSchema = ClosedDateBaseSchema.superRefine(closedDateRules);
export type CreateClosedDateInput = z.infer<typeof CreateClosedDateSchema>;

export const BusinessHoursResponseSchema = z.object({
  timezone: IanaTimezoneSchema,
  week: z.array(BusinessHoursDaySchema).length(7),
  closedDates: z.array(ClosedDateSchema),
});
export type BusinessHoursResponse = z.infer<typeof BusinessHoursResponseSchema>;

/** Whole-week replacement: a partial update of opening hours is almost always a bug. */
export const UpdateBusinessHoursSchema = z.object({
  week: z.array(BusinessHoursDaySchema).length(7),
});


// ── booking policy ────────────────────────────────────────────────────────────
export const BookingPolicySchema = z.object({
  minLeadMinutes: z.number().int().min(0),
  maxAdvanceDays: z.number().int().positive(),
  cancellationWindowHours: z.number().int().min(0),
  lateCancellationFee: MoneySchema,
  noShowFee: MoneySchema,
  slotGranularityMinutes: z.union([
    z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(60),
  ]),
  allowDoubleBooking: z.boolean(),
  maxActiveAppointmentsPerCustomer: z.number().int().positive(),
  currency: CurrencySchema,
});
export type BookingPolicy = z.infer<typeof BookingPolicySchema>;

export const UpdateBookingPolicySchema = z
  .object({
    minLeadMinutes: z.number().int().min(0).max(60 * 24 * 30),
    maxAdvanceDays: z.number().int().positive().max(730),
    cancellationWindowHours: z.number().int().min(0).max(24 * 30),
    lateCancellationFee: MoneyInputSchema,
    noShowFee: MoneyInputSchema,
    slotGranularityMinutes: z.union([
      z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(60),
    ]),
    allowDoubleBooking: z.boolean(),
    maxActiveAppointmentsPerCustomer: z.number().int().positive().max(100),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });
