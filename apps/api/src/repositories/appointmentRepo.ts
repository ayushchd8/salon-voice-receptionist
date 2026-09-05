import { and, asc, desc, eq, gte, inArray, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { BusyBlock } from '@salon/core';
import { db, type Executor } from '../db/index.js';
import { appointments, customers, services, staffMembers } from '../db/schema.js';

export type AppointmentRow = typeof appointments.$inferSelect;

/** An appointment joined with the three things every consumer needs alongside it. */
export interface AppointmentDetail {
  appointment: AppointmentRow;
  customer: typeof customers.$inferSelect;
  service: typeof services.$inferSelect;
  staff: typeof staffMembers.$inferSelect;
}

const detailSelect = {
  appointment: appointments,
  customer: customers,
  service: services,
  staff: staffMembers,
};

function detailQuery(exec: Executor) {
  return exec
    .select(detailSelect)
    .from(appointments)
    .innerJoin(customers, eq(customers.id, appointments.customerId))
    .innerJoin(services, eq(services.id, appointments.serviceId))
    .innerJoin(staffMembers, eq(staffMembers.id, appointments.staffId));
}

export async function getAppointment(
  salonId: string,
  appointmentId: string,
  exec: Executor = db,
): Promise<AppointmentDetail | null> {
  const rows = await detailQuery(exec)
    .where(and(eq(appointments.salonId, salonId), eq(appointments.id, appointmentId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface FindAppointmentsFilters {
  customerId?: string | undefined;
  phone?: string | undefined;
  staffId?: string | undefined;
  serviceId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  statuses?: string[] | undefined;
  upcomingOnly?: boolean;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export async function findAppointments(
  salonId: string,
  filters: FindAppointmentsFilters,
): Promise<{ rows: AppointmentDetail[]; total: number }> {
  const conditions = [eq(appointments.salonId, salonId)];

  if (filters.customerId) conditions.push(eq(appointments.customerId, filters.customerId));
  if (filters.phone) conditions.push(eq(customers.phone, filters.phone));
  if (filters.staffId) conditions.push(eq(appointments.staffId, filters.staffId));
  if (filters.serviceId) conditions.push(eq(appointments.serviceId, filters.serviceId));
  if (filters.from) conditions.push(gte(appointments.startTime, filters.from));
  if (filters.to) conditions.push(lt(appointments.startTime, filters.to));

  if (filters.upcomingOnly) {
    conditions.push(gte(appointments.startTime, new Date()));
    // "Upcoming" means still standing: cancelled and superseded rows are noise.
    conditions.push(filters.statuses?.length ? inArray(appointments.status, filters.statuses) : eq(appointments.status, 'booked'));
  } else if (filters.statuses?.length) {
    conditions.push(inArray(appointments.status, filters.statuses));
  }

  const where = and(...conditions);
  const direction = filters.order === 'desc' ? desc : asc;

  const [rows, [total]] = await Promise.all([
    detailQuery(db).where(where).orderBy(direction(appointments.startTime)).limit(filters.limit).offset(filters.offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(appointments)
      .innerJoin(customers, eq(customers.id, appointments.customerId))
      .where(where),
  ]);

  return { rows, total: total?.count ?? 0 };
}

/**
 * Blocked ranges for conflict detection.
 *
 * Only `booked` and `completed` rows block, and rows flagged `overbooked` are
 * excluded — exactly matching the predicate on the database's exclusion
 * constraint. The engine and the constraint must agree about what counts as a
 * conflict, or the API would offer slots the database then rejects.
 */
export async function loadBusyBlocks(
  salonId: string,
  from: Date,
  to: Date,
  options: { staffIds?: string[]; excludeAppointmentId?: string } = {},
  exec: Executor = db,
): Promise<BusyBlock[]> {
  const conditions = [
    eq(appointments.salonId, salonId),
    inArray(appointments.status, ['booked', 'completed']),
    eq(appointments.overbooked, false),
    // Overlap test against the window, not containment: a booking that starts
    // before `from` and runs into it still blocks.
    lt(appointments.blockStart, to),
    gte(appointments.blockEnd, from),
  ];
  if (options.staffIds?.length) conditions.push(inArray(appointments.staffId, options.staffIds));
  if (options.excludeAppointmentId) conditions.push(ne(appointments.id, options.excludeAppointmentId));

  const rows = await exec
    .select({
      id: appointments.id,
      staffId: appointments.staffId,
      blockStart: appointments.blockStart,
      blockEnd: appointments.blockEnd,
    })
    .from(appointments)
    .where(and(...conditions));

  return rows.map((r) => ({
    staffId: r.staffId,
    blockStart: r.blockStart.toISOString(),
    blockEnd: r.blockEnd.toISOString(),
    appointmentId: r.id,
  }));
}

export async function insertAppointment(
  values: typeof appointments.$inferInsert,
  exec: Executor = db,
): Promise<AppointmentRow> {
  const [row] = await exec.insert(appointments).values(values).returning();
  return row!;
}

export async function updateAppointment(
  salonId: string,
  appointmentId: string,
  patch: Partial<typeof appointments.$inferInsert>,
  exec: Executor = db,
): Promise<AppointmentRow | null> {
  const [row] = await exec
    .update(appointments)
    .set(patch)
    .where(and(eq(appointments.salonId, salonId), eq(appointments.id, appointmentId)))
    .returning();
  return row ?? null;
}

/** How many live future appointments a customer already holds, for the per-customer cap. */
export async function countActiveForCustomer(
  salonId: string,
  customerId: string,
  exec: Executor = db,
): Promise<number> {
  const [row] = await exec
    .select({ count: sql<number>`count(*)::int` })
    .from(appointments)
    .where(
      and(
        eq(appointments.salonId, salonId),
        eq(appointments.customerId, customerId),
        eq(appointments.status, 'booked'),
        gte(appointments.startTime, new Date()),
      ),
    );
  return row?.count ?? 0;
}

/** Calendar range for the admin UI, capped by the caller's limit. */
export async function listCalendar(salonId: string, from: Date, to: Date, limit = 500) {
  return detailQuery(db)
    .where(
      and(
        eq(appointments.salonId, salonId),
        gte(appointments.startTime, from),
        lte(appointments.startTime, to),
        or(ne(appointments.status, 'rescheduled'), sql`true`)!,
      ),
    )
    .orderBy(asc(appointments.startTime))
    .limit(limit);
}
