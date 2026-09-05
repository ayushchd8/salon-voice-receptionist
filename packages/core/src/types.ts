/**
 * Plain-data inputs to the domain engine.
 *
 * These deliberately mirror nothing in the database layer. packages/core has no
 * knowledge of Drizzle, Postgres or HTTP; it takes plain objects and returns
 * plain objects, which is what makes the availability engine and every policy
 * rule unit-testable as functions over fixtures.
 */

export interface BusinessHoursRule {
  /** 0 = Sunday … 6 = Saturday */
  dayOfWeek: number;
  isClosed: boolean;
  /** Salon-local wall clock, "HH:MM:SS". Null when isClosed. */
  openTime: string | null;
  closeTime: string | null;
}

export interface ClosedDateRule {
  /** Salon-local calendar date, "YYYY-MM-DD" */
  date: string;
  reason: string | null;
  /** Both null => closed all day. Both set => special hours for that date. */
  openTime: string | null;
  closeTime: string | null;
}

export interface ServiceDef {
  id: string;
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  active: boolean;
}

export interface StaffWorkingHoursRule {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface StaffDef {
  id: string;
  name: string;
  active: boolean;
  /** Empty => this staff member can perform every service. */
  serviceIds: string[];
  /** Empty => this staff member works the salon's full opening hours. */
  workingHours: StaffWorkingHoursRule[];
}

/** An already-blocked range for one staff member, buffers included. */
export interface BusyBlock {
  staffId: string;
  /** ISO instants. */
  blockStart: string;
  blockEnd: string;
  appointmentId?: string;
}

export interface PolicyDef {
  minLeadMinutes: number;
  maxAdvanceDays: number;
  cancellationWindowHours: number;
  lateCancellationFee: string;
  noShowFee: string;
  slotGranularityMinutes: number;
  allowDoubleBooking: boolean;
  maxActiveAppointmentsPerCustomer: number;
  currency: string;
}

/** Everything the scheduling engine needs about one salon, loaded once per request. */
export interface SchedulingContext {
  salonId: string;
  timezone: string;
  businessHours: BusinessHoursRule[];
  closedDates: ClosedDateRule[];
  policy: PolicyDef;
}

export interface ComputedSlot {
  /** ISO instants. */
  start: string;
  end: string;
  staffId: string;
  staffName: string;
  localDate: string;
  localTime: string;
  label: string;
}

export interface Interval {
  /** ISO instants. */
  start: string;
  end: string;
}
