/**
 * Drizzle schema — the typed query surface over the SQL in ./migrations.
 *
 * The SQL files are authoritative for DDL; this file is authoritative for
 * *types*. `schema.test.ts` asserts the two agree by reflecting over
 * information_schema, so drift fails the build rather than surfacing as a
 * runtime error in production.
 */
import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const money = (name: string) => numeric(name, { precision: 10, scale: 2 });
// `mode: 'date'` rather than 'string': Postgres renders timestamptz as
// "2026-09-07 09:45:00+00" — a space separator, which is not valid ISO-8601 and
// would be rejected or misparsed downstream. Date objects serialise to
// canonical ISO via toISOString(), so instants leave this system in exactly one
// shape.
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const salons = pgTable('salons', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  timezone: text('timezone').notNull(),
  phone: text('phone'),
  email: text('email'),
  address: text('address'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const businessHours = pgTable(
  'business_hours',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    salonId: uuid('salon_id').notNull(),
    dayOfWeek: smallint('day_of_week').notNull(),
    isClosed: boolean('is_closed').notNull().default(false),
    openTime: time('open_time'),
    closeTime: time('close_time'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => ({ salonDay: uniqueIndex('business_hours_salon_day_key').on(t.salonId, t.dayOfWeek) }),
);

export const closedDates = pgTable(
  'closed_dates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    salonId: uuid('salon_id').notNull(),
    date: date('date').notNull(),
    reason: text('reason'),
    openTime: time('open_time'),
    closeTime: time('close_time'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => ({ salonDate: uniqueIndex('closed_dates_salon_date_key').on(t.salonId, t.date) }),
);

export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    salonId: uuid('salon_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    category: text('category').notNull().default('general'),
    durationMinutes: integer('duration_minutes').notNull(),
    bufferBeforeMinutes: integer('buffer_before_minutes').notNull().default(0),
    bufferAfterMinutes: integer('buffer_after_minutes').notNull().default(0),
    price: money('price').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('GBP'),
    active: boolean('active').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => ({ salonActive: index('services_salon_active_idx').on(t.salonId, t.active) }),
);

export const staffMembers = pgTable(
  'staff_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    salonId: uuid('salon_id').notNull(),
    name: text('name').notNull(),
    role: text('role'),
    isDefaultResource: boolean('is_default_resource').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => ({ salonActive: index('staff_members_salon_active_idx').on(t.salonId, t.active) }),
);

export const staffServices = pgTable(
  'staff_services',
  {
    staffId: uuid('staff_id').notNull(),
    serviceId: uuid('service_id').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.staffId, t.serviceId] }) }),
);

export const staffWorkingHours = pgTable(
  'staff_working_hours',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    staffId: uuid('staff_id').notNull(),
    dayOfWeek: smallint('day_of_week').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
  },
  (t) => ({ staffDay: uniqueIndex('staff_working_hours_staff_day_key').on(t.staffId, t.dayOfWeek) }),
);

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    salonId: uuid('salon_id').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name'),
    phone: text('phone').notNull(),
    email: text('email'),
    notes: text('notes'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => ({ salonPhone: uniqueIndex('customers_salon_phone_key').on(t.salonId, t.phone) }),
);

export const bookingPolicies = pgTable('booking_policies', {
  salonId: uuid('salon_id').primaryKey(),
  minLeadMinutes: integer('min_lead_minutes').notNull().default(120),
  maxAdvanceDays: integer('max_advance_days').notNull().default(90),
  cancellationWindowHours: integer('cancellation_window_hours').notNull().default(24),
  lateCancellationFee: money('late_cancellation_fee').notNull().default('0'),
  noShowFee: money('no_show_fee').notNull().default('0'),
  slotGranularityMinutes: integer('slot_granularity_minutes').notNull().default(15),
  allowDoubleBooking: boolean('allow_double_booking').notNull().default(false),
  maxActiveAppointmentsPerCustomer: integer('max_active_appointments_per_customer').notNull().default(5),
  currency: char('currency', { length: 3 }).notNull().default('GBP'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const callLogs = pgTable(
  'call_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    salonId: uuid('salon_id').notNull(),
    callerPhone: text('caller_phone'),
    startedAt: ts('started_at').notNull().defaultNow(),
    endedAt: ts('ended_at'),
    transport: text('transport').notNull(),
    status: text('status').notNull().default('in_progress'),
    transcript: jsonb('transcript').notNull().default([]),
    recordingRef: text('recording_ref'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => ({ salonStarted: index('call_logs_salon_started_idx').on(t.salonId, t.startedAt) }),
);

export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    salonId: uuid('salon_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    staffId: uuid('staff_id').notNull(),
    startTime: ts('start_time').notNull(),
    endTime: ts('end_time').notNull(),
    blockStart: ts('block_start').notNull(),
    blockEnd: ts('block_end').notNull(),
    status: text('status').notNull().default('booked'),
    source: text('source').notNull(),
    callId: uuid('call_id'),
    rescheduledFromId: uuid('rescheduled_from_id'),
    rescheduledToId: uuid('rescheduled_to_id'),
    priceAtBooking: money('price_at_booking').notNull().default('0'),
    currency: char('currency', { length: 3 }).notNull().default('GBP'),
    notes: text('notes'),
    overbooked: boolean('overbooked').notNull().default(false),
    cancellationReason: text('cancellation_reason'),
    cancellationFee: money('cancellation_fee').notNull().default('0'),
    cancelledAt: ts('cancelled_at'),
    completedAt: ts('completed_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    salonStart: index('appointments_salon_start_idx').on(t.salonId, t.startTime),
    salonCustomer: index('appointments_salon_customer_idx').on(t.salonId, t.customerId, t.startTime),
  }),
);

export const callSummaries = pgTable(
  'call_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    callId: uuid('call_id').notNull().unique(),
    salonId: uuid('salon_id').notNull(),
    customerId: uuid('customer_id'),
    callerPhone: text('caller_phone'),
    intents: text('intents').array().notNull().default([]),
    servicesDiscussed: text('services_discussed').array().notNull().default([]),
    appointmentAction: text('appointment_action').notNull().default('none'),
    actionResult: text('action_result').notNull().default('not_attempted'),
    failureReason: text('failure_reason'),
    appointmentId: uuid('appointment_id'),
    summary: text('summary').notNull().default(''),
    keyEntities: jsonb('key_entities').notNull().default({}),
    events: jsonb('events').notNull().default([]),
    escalated: boolean('escalated').notNull().default(false),
    escalationReason: text('escalation_reason'),
    callbackRequest: jsonb('callback_request'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => ({ salonCreated: index('call_summaries_salon_created_idx').on(t.salonId, t.createdAt) }),
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    salonId: uuid('salon_id').notNull(),
    key: text('key').notNull(),
    endpoint: text('endpoint').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.salonId, t.key] }) }),
);

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  salonId: uuid('salon_id').notNull(),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  scopes: text('scopes').array().notNull().default([]),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
});
