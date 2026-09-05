import { z } from 'zod';
import {
  CurrencySchema,
  IsoDateTimeSchema,
  MoneySchema,
  PaginationQuerySchema,
  PhoneInputSchema,
  UuidSchema,
} from './common.js';
import { CustomerSummarySchema } from './customer.js';

export const APPOINTMENT_STATUSES = [
  'booked',
  'cancelled',
  'completed',
  'no_show',
  'rescheduled',
] as const;
export const AppointmentStatusSchema = z.enum(APPOINTMENT_STATUSES);
export type AppointmentStatus = z.infer<typeof AppointmentStatusSchema>;

export const APPOINTMENT_SOURCES = ['voice', 'staff', 'web'] as const;
export const AppointmentSourceSchema = z.enum(APPOINTMENT_SOURCES);

export const AppointmentSchema = z.object({
  id: UuidSchema,
  status: AppointmentStatusSchema,
  source: AppointmentSourceSchema,
  start: IsoDateTimeSchema,
  end: IsoDateTimeSchema,
  /** Salon-local rendering so consumers never re-derive the timezone. */
  localDate: z.string(),
  localTime: z.string(),
  label: z.string().describe('Speakable form, e.g. "Friday 3 October at 2:30pm"'),
  service: z.object({
    id: UuidSchema,
    name: z.string(),
    durationMinutes: z.number().int(),
  }),
  staff: z.object({ id: UuidSchema, name: z.string() }),
  customer: CustomerSummarySchema,
  priceAtBooking: MoneySchema,
  currency: CurrencySchema,
  notes: z.string().nullable(),
  callId: UuidSchema.nullable(),
  rescheduledFromId: UuidSchema.nullable(),
  rescheduledToId: UuidSchema.nullable(),
  cancellationReason: z.string().nullable(),
  cancellationFee: MoneySchema,
  cancelledAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Appointment = z.infer<typeof AppointmentSchema>;

/**
 * Booking accepts either an existing `customerId` or a `customer` object to
 * find-or-create by phone. The voice agent uses the latter: a first-time
 * caller becomes a customer record in the same transaction as their booking,
 * so a crash between the two can never leave a customer with no appointment.
 */
export const CreateAppointmentSchema = z
  .object({
    customerId: UuidSchema.optional(),
    customer: z
      .object({
        firstName: z.string().trim().min(1).max(80),
        lastName: z.string().trim().max(80).nullish(),
        phone: PhoneInputSchema,
        email: z.string().email().max(254).nullish(),
      })
      .optional(),
    serviceId: UuidSchema,
    /** Omit to let the scheduling engine assign the least-loaded qualified staff member. */
    staffId: UuidSchema.optional(),
    start: IsoDateTimeSchema,
    source: AppointmentSourceSchema.default('voice'),
    callId: UuidSchema.nullish(),
    notes: z.string().trim().max(1000).nullish(),
    /**
     * Deliberately book over an existing appointment. Requires the
     * `appointments:overbook` scope and a salon policy that allows it — the
     * voice agent holds neither.
     */
    overbook: z.boolean().default(false),
  })
  .refine((v) => Boolean(v.customerId) !== Boolean(v.customer), {
    message: 'provide exactly one of customerId or customer',
  });
export type CreateAppointmentInput = z.infer<typeof CreateAppointmentSchema>;

export const CancelAppointmentSchema = z.object({
  reason: z.string().trim().max(500).nullish(),
  /**
   * Cancelling inside the salon's notice window is permitted, but only once
   * the caller has been told about the fee and agreed to it. Without this
   * flag the endpoint returns CANCELLATION_WINDOW_PASSED with the fee amount
   * and hours remaining in `details`, so the agent can explain the situation
   * and ask — rather than silently refusing, or silently charging.
   */
  acknowledgeFee: z.boolean().default(false),
});

export const RescheduleAppointmentSchema = z.object({
  start: IsoDateTimeSchema,
  /** Optional changes made in the same breath ("actually make it a colour"). */
  serviceId: UuidSchema.optional(),
  staffId: UuidSchema.optional(),
  reason: z.string().trim().max(500).nullish(),
  acknowledgeFee: z.boolean().default(false),
  callId: UuidSchema.nullish(),
});

export const FindAppointmentsQuerySchema = PaginationQuerySchema.extend({
  customerId: UuidSchema.optional(),
  phone: PhoneInputSchema.optional(),
  staffId: UuidSchema.optional(),
  serviceId: UuidSchema.optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
  status: z
    .union([AppointmentStatusSchema, z.array(AppointmentStatusSchema)])
    .optional()
    .describe('Repeatable. Defaults to "booked" when upcomingOnly is set.'),
  upcomingOnly: z.coerce.boolean().default(false),
  order: z.enum(['asc', 'desc']).default('asc'),
});
export type FindAppointmentsQuery = z.infer<typeof FindAppointmentsQuerySchema>;

/** Returned by cancel/reschedule when the notice window has passed. */
export const CancellationWindowDetailsSchema = z.object({
  windowHours: z.number().int(),
  hoursUntilAppointment: z.number(),
  feeApplies: z.boolean(),
  fee: MoneySchema,
  currency: CurrencySchema,
  /** Retry with `acknowledgeFee: true` to proceed anyway. */
  proceedWith: z.literal('acknowledgeFee'),
});
