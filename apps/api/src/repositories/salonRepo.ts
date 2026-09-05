import { and, asc, eq, gte } from 'drizzle-orm';
import type { SchedulingContext } from '@salon/core';
import { db, type Executor } from '../db/index.js';
import { businessHours, bookingPolicies, closedDates, salons } from '../db/schema.js';

export async function getSalon(salonId: string, exec: Executor = db) {
  const [row] = await exec.select().from(salons).where(eq(salons.id, salonId)).limit(1);
  return row ?? null;
}

export async function getBusinessHours(salonId: string, exec: Executor = db) {
  return exec
    .select()
    .from(businessHours)
    .where(eq(businessHours.salonId, salonId))
    .orderBy(asc(businessHours.dayOfWeek));
}

export async function getClosedDates(salonId: string, fromDate?: string, exec: Executor = db) {
  const conditions = [eq(closedDates.salonId, salonId)];
  if (fromDate) conditions.push(gte(closedDates.date, fromDate));
  return exec
    .select()
    .from(closedDates)
    .where(and(...conditions))
    .orderBy(asc(closedDates.date));
}

export async function getPolicy(salonId: string, exec: Executor = db) {
  const [row] = await exec
    .select()
    .from(bookingPolicies)
    .where(eq(bookingPolicies.salonId, salonId))
    .limit(1);
  return row ?? null;
}

/**
 * Load everything the scheduling engine needs for one salon, in one place.
 *
 * The engine is pure, so this is the only function that knows how database
 * rows become a SchedulingContext — and the availability endpoint, the booking
 * endpoint and the seed script all go through it. There is one definition of
 * "this salon's rules".
 */
export async function loadSchedulingContext(
  salonId: string,
  exec: Executor = db,
): Promise<SchedulingContext | null> {
  const [salon, hours, closures, policy] = await Promise.all([
    getSalon(salonId, exec),
    getBusinessHours(salonId, exec),
    getClosedDates(salonId, undefined, exec),
    getPolicy(salonId, exec),
  ]);
  if (!salon || !policy) return null;

  return {
    salonId,
    timezone: salon.timezone,
    businessHours: hours.map((h) => ({
      dayOfWeek: h.dayOfWeek,
      isClosed: h.isClosed,
      openTime: h.openTime,
      closeTime: h.closeTime,
    })),
    closedDates: closures.map((c) => ({
      date: c.date,
      reason: c.reason,
      openTime: c.openTime,
      closeTime: c.closeTime,
    })),
    policy: {
      minLeadMinutes: policy.minLeadMinutes,
      maxAdvanceDays: policy.maxAdvanceDays,
      cancellationWindowHours: policy.cancellationWindowHours,
      lateCancellationFee: policy.lateCancellationFee,
      noShowFee: policy.noShowFee,
      slotGranularityMinutes: policy.slotGranularityMinutes,
      allowDoubleBooking: policy.allowDoubleBooking,
      maxActiveAppointmentsPerCustomer: policy.maxActiveAppointmentsPerCustomer,
      currency: policy.currency,
    },
  };
}

export async function replaceBusinessHours(
  salonId: string,
  week: Array<{ dayOfWeek: number; isClosed: boolean; openTime: string | null; closeTime: string | null }>,
) {
  return db.transaction(async (tx) => {
    for (const day of week) {
      await tx
        .insert(businessHours)
        .values({
          salonId,
          dayOfWeek: day.dayOfWeek,
          isClosed: day.isClosed,
          openTime: day.openTime,
          closeTime: day.closeTime,
        })
        .onConflictDoUpdate({
          target: [businessHours.salonId, businessHours.dayOfWeek],
          set: { isClosed: day.isClosed, openTime: day.openTime, closeTime: day.closeTime },
        });
    }
    return tx
      .select()
      .from(businessHours)
      .where(eq(businessHours.salonId, salonId))
      .orderBy(asc(businessHours.dayOfWeek));
  });
}

export async function createClosedDate(
  salonId: string,
  input: { date: string; reason: string | null; openTime: string | null; closeTime: string | null },
) {
  const [row] = await db.insert(closedDates).values({ salonId, ...input }).returning();
  return row!;
}

export async function deleteClosedDate(salonId: string, id: string) {
  const rows = await db
    .delete(closedDates)
    .where(and(eq(closedDates.salonId, salonId), eq(closedDates.id, id)))
    .returning({ id: closedDates.id });
  return rows.length > 0;
}

export async function updatePolicy(salonId: string, patch: Record<string, unknown>) {
  const [row] = await db
    .update(bookingPolicies)
    .set(patch)
    .where(eq(bookingPolicies.salonId, salonId))
    .returning();
  return row ?? null;
}
