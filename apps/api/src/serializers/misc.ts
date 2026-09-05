import type { BusinessHoursResponse, BookingPolicy, Salon, Service, StaffMember } from '@salon/contracts';
import type { businessHours, bookingPolicies, closedDates, salons, services } from '../db/schema.js';
import type { StaffRecord } from '../repositories/catalogRepo.js';

type SalonRow = typeof salons.$inferSelect;
type ServiceRow = typeof services.$inferSelect;
type HoursRow = typeof businessHours.$inferSelect;
type ClosedRow = typeof closedDates.$inferSelect;
type PolicyRow = typeof bookingPolicies.$inferSelect;

export function serializeSalon(row: SalonRow): Salon {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    phone: row.phone,
    email: row.email,
    address: row.address,
  };
}

export function serializeService(row: ServiceRow): Service {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    durationMinutes: row.durationMinutes,
    bufferBeforeMinutes: row.bufferBeforeMinutes,
    bufferAfterMinutes: row.bufferAfterMinutes,
    price: row.price,
    currency: row.currency,
    active: row.active,
  };
}

export function serializeStaff(record: StaffRecord): StaffMember {
  return {
    id: record.id,
    name: record.name,
    role: record.role,
    isDefaultResource: record.isDefaultResource,
    active: record.active,
    serviceIds: record.serviceIds,
    workingHours: record.workingHours.map((h) => ({
      dayOfWeek: h.dayOfWeek,
      startTime: h.startTime,
      endTime: h.endTime,
    })),
  };
}

export function serializeBusinessHours(
  timezone: string,
  hours: HoursRow[],
  closures: ClosedRow[],
): BusinessHoursResponse {
  // Always seven days, in order — a missing row would otherwise read as
  // "unknown" to a consumer rather than "closed".
  const week = Array.from({ length: 7 }, (_, dayOfWeek) => {
    const row = hours.find((h) => h.dayOfWeek === dayOfWeek);
    return {
      dayOfWeek,
      isClosed: row?.isClosed ?? true,
      openTime: row?.isClosed ? null : (row?.openTime ?? null),
      closeTime: row?.isClosed ? null : (row?.closeTime ?? null),
    };
  });

  return {
    timezone,
    week,
    closedDates: closures.map((c) => ({
      id: c.id,
      date: c.date,
      reason: c.reason,
      openTime: c.openTime,
      closeTime: c.closeTime,
    })),
  };
}

export function serializePolicy(row: PolicyRow): BookingPolicy {
  return {
    minLeadMinutes: row.minLeadMinutes,
    maxAdvanceDays: row.maxAdvanceDays,
    cancellationWindowHours: row.cancellationWindowHours,
    lateCancellationFee: row.lateCancellationFee,
    noShowFee: row.noShowFee,
    slotGranularityMinutes: row.slotGranularityMinutes as BookingPolicy['slotGranularityMinutes'],
    allowDoubleBooking: row.allowDoubleBooking,
    maxActiveAppointmentsPerCustomer: row.maxActiveAppointmentsPerCustomer,
    currency: row.currency,
  };
}
