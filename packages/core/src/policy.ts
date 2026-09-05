/**
 * Booking-policy evaluation.
 *
 * Every rule that can reject a booking lives here as a pure function, and the
 * same functions are used to *generate* availability and to *validate* a write.
 * There is one implementation of "is this slot legal", so the availability
 * endpoint cannot offer a slot that the booking endpoint would then refuse.
 */
import type { ErrorCode } from '@salon/contracts';
import { DateTime } from 'luxon';
import type { ClosedDateRule, Interval, SchedulingContext, ServiceDef, StaffDef } from './types.js';
import { canonicalInstant, dayOfWeekOf, localToInstant, toSalonTime } from './time/zone.js';

export interface PolicyViolation {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** Open intervals for one salon-local date, with closed-date overrides applied. */
export function openIntervalsForDate(date: string, context: SchedulingContext): Interval[] {
  const override: ClosedDateRule | undefined = context.closedDates.find((c) => c.date === date);
  if (override) {
    // A closed-date row with no times is a full-day closure; with times, it
    // replaces the regular hours for that date entirely.
    if (!override.openTime || !override.closeTime) return [];
    return [
      {
        start: localToInstant(date, override.openTime, context.timezone).toUTC().toISO()!,
        end: localToInstant(date, override.closeTime, context.timezone).toUTC().toISO()!,
      },
    ];
  }

  const dow = dayOfWeekOf(DateTime.fromISO(date, { zone: context.timezone }));
  const rule = context.businessHours.find((h) => h.dayOfWeek === dow);
  if (!rule || rule.isClosed || !rule.openTime || !rule.closeTime) return [];

  return [
    {
      start: localToInstant(date, rule.openTime, context.timezone).toUTC().toISO()!,
      end: localToInstant(date, rule.closeTime, context.timezone).toUTC().toISO()!,
    },
  ];
}

/**
 * Working intervals for one staff member on one date.
 *
 * A staff member with no working-hours rows works the salon's full opening
 * hours — the common case for a small salon that never fills this in. With
 * rows, they work only the listed days, intersected with the salon's hours
 * (a stylist cannot work while the salon is shut).
 */
export function staffIntervalsForDate(
  date: string,
  context: SchedulingContext,
  staff: StaffDef,
): Interval[] {
  const salonWindows = openIntervalsForDate(date, context);
  if (salonWindows.length === 0) return [];
  if (staff.workingHours.length === 0) return salonWindows;

  const dow = dayOfWeekOf(DateTime.fromISO(date, { zone: context.timezone }));
  const shift = staff.workingHours.find((w) => w.dayOfWeek === dow);
  if (!shift) return [];

  const shiftInterval: Interval = {
    start: localToInstant(date, shift.startTime, context.timezone).toUTC().toISO()!,
    end: localToInstant(date, shift.endTime, context.timezone).toUTC().toISO()!,
  };
  return intersectIntervals(salonWindows, [shiftInterval]);
}

export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) {
    for (const y of b) {
      const start = x.start > y.start ? x.start : y.start;
      const end = x.end < y.end ? x.end : y.end;
      if (start < end) out.push({ start, end });
    }
  }
  return out;
}

export function canStaffPerform(staff: StaffDef, serviceId: string): boolean {
  // An empty list means "everything" — see StaffDef.
  return staff.serviceIds.length === 0 || staff.serviceIds.includes(serviceId);
}

/** The full blocked range for a booking: the service plus its buffers. */
export function computeBlockRange(
  startIso: string,
  service: Pick<ServiceDef, 'durationMinutes' | 'bufferBeforeMinutes' | 'bufferAfterMinutes'>,
): { start: string; end: string; blockStart: string; blockEnd: string } {
  const start = DateTime.fromISO(canonicalInstant(startIso), { zone: 'utc' });
  const end = start.plus({ minutes: service.durationMinutes });
  return {
    start: start.toUTC().toISO()!,
    end: end.toUTC().toISO()!,
    blockStart: start.minus({ minutes: service.bufferBeforeMinutes }).toUTC().toISO()!,
    blockEnd: end.plus({ minutes: service.bufferAfterMinutes }).toUTC().toISO()!,
  };
}

export interface BookingWindowCheck {
  start: string;
  end: string;
  now: string;
  context: SchedulingContext;
  service: ServiceDef;
}

/**
 * Validates a proposed booking against time and policy rules.
 *
 * Checks run cheapest-and-most-explanatory first, so the caller hears the most
 * useful reason: "we're closed that day" beats "that time is unavailable".
 * Returns null when the booking is legal.
 */
export function validateBookingWindow(input: BookingWindowCheck): PolicyViolation | null {
  const { context, service } = input;
  const { policy, timezone } = context;

  // Same reasoning as computeAvailability: order instants only after they all
  // share one UTC rendering.
  const start = canonicalInstant(input.start);
  const end = canonicalInstant(input.end);
  const now = canonicalInstant(input.now);

  if (!service.active) {
    return {
      code: 'SERVICE_INACTIVE',
      message: `${service.name} is not currently offered.`,
      details: { serviceId: service.id, serviceName: service.name },
    };
  }

  if (start <= now) {
    return {
      code: 'BOOKING_IN_PAST',
      message: 'That time has already passed.',
      details: { requestedStart: start, now },
    };
  }

  const earliest = DateTime.fromISO(now).plus({ minutes: policy.minLeadMinutes });
  if (DateTime.fromISO(start) < earliest) {
    return {
      code: 'LEAD_TIME_TOO_SHORT',
      message:
        policy.minLeadMinutes >= 60
          ? `Bookings need at least ${Math.round(policy.minLeadMinutes / 60)} hour(s) notice.`
          : `Bookings need at least ${policy.minLeadMinutes} minutes notice.`,
      details: {
        minLeadMinutes: policy.minLeadMinutes,
        earliestStart: earliest.toUTC().toISO(),
        requestedStart: start,
      },
    };
  }

  const latest = DateTime.fromISO(now).plus({ days: policy.maxAdvanceDays });
  if (DateTime.fromISO(start) > latest) {
    return {
      code: 'TOO_FAR_IN_ADVANCE',
      message: `Bookings can only be made up to ${policy.maxAdvanceDays} days ahead.`,
      details: {
        maxAdvanceDays: policy.maxAdvanceDays,
        latestStart: latest.toUTC().toISO(),
        requestedStart: start,
      },
    };
  }

  const localDate = toSalonTime(start, timezone).toFormat('yyyy-MM-dd');
  const windows = openIntervalsForDate(localDate, context);

  if (windows.length === 0) {
    const closure = context.closedDates.find((c) => c.date === localDate);
    return {
      code: 'SALON_CLOSED_ON_DATE',
      message: closure?.reason
        ? `We're closed on ${localDate} (${closure.reason}).`
        : `We're closed on ${localDate}.`,
      details: { date: localDate, reason: closure?.reason ?? null },
    };
  }

  const fits = windows.some((w) => start >= w.start && end <= w.end);
  if (!fits) {
    const w = windows[0]!;
    return {
      code: 'OUTSIDE_BUSINESS_HOURS',
      message: `That's outside our opening hours on ${localDate}.`,
      details: {
        date: localDate,
        opensAt: w.start,
        closesAt: w.end,
        requestedStart: start,
        requestedEnd: end,
        note: 'the full service duration must fit inside opening hours',
      },
    };
  }

  return null;
}

/** Staff-specific validation, separate because it needs staff data the window check does not. */
export function validateStaffForBooking(input: {
  start: string;
  end: string;
  staff: StaffDef;
  service: ServiceDef;
  context: SchedulingContext;
}): PolicyViolation | null {
  const { staff, service, context } = input;
  const start = canonicalInstant(input.start);
  const end = canonicalInstant(input.end);

  if (!staff.active) {
    return {
      code: 'STAFF_NOT_WORKING',
      message: `${staff.name} is not taking bookings.`,
      details: { staffId: staff.id },
    };
  }

  if (!canStaffPerform(staff, service.id)) {
    return {
      code: 'STAFF_CANNOT_PERFORM_SERVICE',
      message: `${staff.name} doesn't do ${service.name}.`,
      details: { staffId: staff.id, staffName: staff.name, serviceId: service.id },
    };
  }

  const localDate = toSalonTime(start, context.timezone).toFormat('yyyy-MM-dd');
  const windows = staffIntervalsForDate(localDate, context, staff);
  if (!windows.some((w) => start >= w.start && end <= w.end)) {
    return {
      code: 'STAFF_NOT_WORKING',
      message: `${staff.name} isn't working then.`,
      details: { staffId: staff.id, staffName: staff.name, date: localDate },
    };
  }

  return null;
}

// ── cancellation ──────────────────────────────────────────────────────────────

export interface CancellationAssessment {
  hoursUntilAppointment: number;
  /** True when the appointment is closer than the salon's notice window. */
  insideNoticeWindow: boolean;
  feeApplies: boolean;
  fee: string;
  currency: string;
  windowHours: number;
}

/**
 * Assess a cancellation against the salon's notice policy.
 *
 * Note what this does *not* do: it never refuses outright. A late cancellation
 * is permitted once the caller has been told the fee and agreed to it, which
 * is how a human receptionist handles it. The endpoint returns
 * CANCELLATION_WINDOW_PASSED with these numbers in `details` so the agent can
 * explain and ask, rather than stonewalling the customer.
 */
export function assessCancellation(input: {
  appointmentStart: string;
  now: string;
  policy: Pick<SchedulingContext['policy'], 'cancellationWindowHours' | 'lateCancellationFee' | 'currency'>;
}): CancellationAssessment {
  const { appointmentStart, now, policy } = input;
  const hours =
    (DateTime.fromISO(appointmentStart).toMillis() - DateTime.fromISO(now).toMillis()) / 3_600_000;
  const insideWindow = hours < policy.cancellationWindowHours;
  const feeAmount = Number(policy.lateCancellationFee);

  return {
    hoursUntilAppointment: Math.round(hours * 10) / 10,
    insideNoticeWindow: insideWindow,
    feeApplies: insideWindow && feeAmount > 0,
    fee: insideWindow && feeAmount > 0 ? policy.lateCancellationFee : '0.00',
    currency: policy.currency,
    windowHours: policy.cancellationWindowHours,
  };
}
