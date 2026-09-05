import { describe, expect, it } from 'vitest';
import {
  assessCancellation,
  canStaffPerform,
  computeBlockRange,
  openIntervalsForDate,
  staffIntervalsForDate,
  validateBookingWindow,
  validateStaffForBooking,
} from './policy.js';
import { colourService, cutService, defaultPolicy, makeContext, priya, sam } from './test-fixtures.js';
import { toSalonTime } from './time/zone.js';

const TZ = 'Europe/London';
const NOW = '2026-09-07T08:00:00Z'; // Monday 7 Sept 2026, 09:00 local

/** Build a booking at a salon-local time on a given date. */
function booking(date: string, localTime: string, service = cutService) {
  const start = `${date}T${localTime}:00+01:00`; // BST
  const range = computeBlockRange(start, service);
  return { start: range.start, end: range.end };
}

const check = (date: string, time: string, overrides: Parameters<typeof makeContext>[0] = {}, service = cutService) =>
  validateBookingWindow({
    ...booking(date, time, service),
    now: NOW,
    context: makeContext(overrides),
    service,
  });

describe('validateBookingWindow', () => {
  it('accepts a booking inside opening hours and policy', () => {
    expect(check('2026-09-07', '14:00')).toBeNull();
  });

  it('rejects an inactive service', () => {
    const retired = { ...cutService, active: false };
    expect(check('2026-09-07', '14:00', {}, retired)?.code).toBe('SERVICE_INACTIVE');
  });

  it('rejects a time already past', () => {
    expect(check('2026-09-07', '08:00')?.code).toBe('BOOKING_IN_PAST');
  });

  it('rejects a booking inside the minimum notice period and says when is earliest', () => {
    const v = check('2026-09-07', '10:00', {
      policy: { ...defaultPolicy, minLeadMinutes: 120 },
    });
    expect(v?.code).toBe('LEAD_TIME_TOO_SHORT');
    // The agent needs the earliest legal time to offer an alternative, not just a refusal.
    expect(v?.details?.earliestStart).toBe('2026-09-07T10:00:00.000Z');
    expect(v?.message).toContain('2 hour');
  });

  it('rejects a booking beyond the advance window', () => {
    const v = check('2026-12-07', '14:00', { policy: { ...defaultPolicy, maxAdvanceDays: 30 } });
    expect(v?.code).toBe('TOO_FAR_IN_ADVANCE');
    expect(v?.details?.maxAdvanceDays).toBe(30);
  });

  it('rejects a day the salon is regularly closed', () => {
    expect(check('2026-09-13', '14:00')?.code).toBe('SALON_CLOSED_ON_DATE'); // Sunday
  });

  it('rejects a holiday closure and carries the reason through for the caller', () => {
    const v = check('2026-09-09', '14:00', {
      closedDates: [{ date: '2026-09-09', reason: 'Staff training day', openTime: null, closeTime: null }],
    });
    expect(v?.code).toBe('SALON_CLOSED_ON_DATE');
    expect(v?.details?.reason).toBe('Staff training day');
    expect(v?.message).toContain('Staff training day');
  });

  it('rejects a time outside opening hours', () => {
    expect(check('2026-09-07', '19:00')?.code).toBe('OUTSIDE_BUSINESS_HOURS');
  });

  it('rejects a booking that starts in hours but would overrun closing', () => {
    // 17:30 + 60 minutes runs to 18:30; the salon shuts at 18:00.
    const v = check('2026-09-07', '17:30');
    expect(v?.code).toBe('OUTSIDE_BUSINESS_HOURS');
    expect(v?.details?.note).toContain('full service duration');
  });

  it('allows a booking whose trailing buffer extends past closing', () => {
    // A 17:00 cut ends at 18:00 exactly; its 15-minute cleanup buffer runs to
    // 18:15, after the doors shut. That is normal salon operation, not a conflict.
    expect(check('2026-09-07', '17:00')).toBeNull();
  });
});

describe('validateStaffForBooking', () => {
  const context = makeContext();
  const slot = booking('2026-09-07', '14:00');

  it('accepts a qualified, working staff member', () => {
    expect(validateStaffForBooking({ ...slot, staff: priya, service: cutService, context })).toBeNull();
  });

  it('rejects a staff member who does not offer the service', () => {
    const v = validateStaffForBooking({ ...slot, staff: sam, service: colourService, context });
    expect(v?.code).toBe('STAFF_CANNOT_PERFORM_SERVICE');
    expect(v?.message).toContain('Sam');
  });

  it('rejects an inactive staff member', () => {
    const v = validateStaffForBooking({
      ...slot, staff: { ...priya, active: false }, service: cutService, context,
    });
    expect(v?.code).toBe('STAFF_NOT_WORKING');
  });

  it('rejects a time outside that staff member shift', () => {
    const morningOnly = { ...priya, workingHours: [{ dayOfWeek: 1, startTime: '09:00:00', endTime: '12:00:00' }] };
    const v = validateStaffForBooking({ ...slot, staff: morningOnly, service: cutService, context });
    expect(v?.code).toBe('STAFF_NOT_WORKING');
  });
});

describe('canStaffPerform', () => {
  it('treats an empty service list as "can do everything"', () => {
    // The common case for a small salon that never fills the join table in.
    expect(canStaffPerform(priya, 'any-service-id')).toBe(true);
  });

  it('honours an explicit service list', () => {
    expect(canStaffPerform(sam, cutService.id)).toBe(true);
    expect(canStaffPerform(sam, colourService.id)).toBe(false);
  });
});

describe('openIntervalsForDate', () => {
  const context = makeContext();

  it('returns the regular hours for an ordinary day', () => {
    const [interval] = openIntervalsForDate('2026-09-07', context);
    expect(toSalonTime(interval!.start, TZ).toFormat('HH:mm')).toBe('09:00');
    expect(toSalonTime(interval!.end, TZ).toFormat('HH:mm')).toBe('18:00');
  });

  it('returns nothing on a closed weekday', () => {
    expect(openIntervalsForDate('2026-09-13', context)).toEqual([]);
  });

  it('lets a closed-date row with times replace the regular hours entirely', () => {
    const special = makeContext({
      closedDates: [{ date: '2026-09-07', reason: 'Christmas Eve', openTime: '10:00:00', closeTime: '14:00:00' }],
    });
    const [interval] = openIntervalsForDate('2026-09-07', special);
    expect(toSalonTime(interval!.start, TZ).toFormat('HH:mm')).toBe('10:00');
    expect(toSalonTime(interval!.end, TZ).toFormat('HH:mm')).toBe('14:00');
  });

  it('keeps wall-clock opening times stable across a DST change', () => {
    // UK clocks go back on 25 October 2026. "We open at nine" is true either side.
    for (const date of ['2026-10-23', '2026-10-27']) {
      const [interval] = openIntervalsForDate(date, context);
      expect(toSalonTime(interval!.start, TZ).toFormat('HH:mm')).toBe('09:00');
    }
  });
});

describe('staffIntervalsForDate', () => {
  const context = makeContext();

  it('clamps a shift to the salon opening hours', () => {
    // Sam is keen but the salon shuts at 18:00 regardless.
    const eager = { ...priya, workingHours: [{ dayOfWeek: 1, startTime: '08:00:00', endTime: '20:00:00' }] };
    const [interval] = staffIntervalsForDate('2026-09-07', context, eager);
    expect(toSalonTime(interval!.start, TZ).toFormat('HH:mm')).toBe('09:00');
    expect(toSalonTime(interval!.end, TZ).toFormat('HH:mm')).toBe('18:00');
  });

  it('returns nothing when the salon is shut, however keen the staff member', () => {
    const sundayWorker = { ...priya, workingHours: [{ dayOfWeek: 0, startTime: '09:00:00', endTime: '17:00:00' }] };
    expect(staffIntervalsForDate('2026-09-13', context, sundayWorker)).toEqual([]);
  });
});

describe('computeBlockRange', () => {
  it('extends the blocked range by the service buffers without moving the appointment', () => {
    const r = computeBlockRange('2026-09-07T13:00:00.000Z', {
      durationMinutes: 60, bufferBeforeMinutes: 10, bufferAfterMinutes: 15,
    });
    expect(r.start).toBe('2026-09-07T13:00:00.000Z');
    expect(r.end).toBe('2026-09-07T14:00:00.000Z');
    expect(r.blockStart).toBe('2026-09-07T12:50:00.000Z');
    expect(r.blockEnd).toBe('2026-09-07T14:15:00.000Z');
  });

  it('normalises whatever ISO rendering it is given', () => {
    // Postgres, Luxon and hand-written JSON all render instants differently.
    const a = computeBlockRange('2026-09-07T14:00:00+01:00', cutService);
    const b = computeBlockRange('2026-09-07T13:00:00Z', cutService);
    expect(a).toEqual(b);
  });
});

describe('assessCancellation', () => {
  const policy = { cancellationWindowHours: 24, lateCancellationFee: '15.00', currency: 'GBP' };

  it('charges nothing with plenty of notice', () => {
    const a = assessCancellation({ appointmentStart: '2026-09-10T13:00:00Z', now: NOW, policy });
    expect(a.insideNoticeWindow).toBe(false);
    expect(a.feeApplies).toBe(false);
    expect(a.fee).toBe('0.00');
  });

  it('flags a late cancellation with the fee and the hours remaining', () => {
    // The endpoint does not refuse — it hands back what the agent needs to
    // explain the fee and ask, the way a receptionist would.
    const a = assessCancellation({ appointmentStart: '2026-09-07T10:00:00Z', now: NOW, policy });
    expect(a.insideNoticeWindow).toBe(true);
    expect(a.feeApplies).toBe(true);
    expect(a.fee).toBe('15.00');
    expect(a.hoursUntilAppointment).toBe(2);
    expect(a.windowHours).toBe(24);
  });

  it('does not invent a fee for a salon that charges none', () => {
    const a = assessCancellation({
      appointmentStart: '2026-09-07T10:00:00Z',
      now: NOW,
      policy: { ...policy, lateCancellationFee: '0.00' },
    });
    expect(a.insideNoticeWindow).toBe(true);
    expect(a.feeApplies).toBe(false);
  });

  it('treats an appointment already in the past as inside the window', () => {
    const a = assessCancellation({ appointmentStart: '2026-09-06T10:00:00Z', now: NOW, policy });
    expect(a.insideNoticeWindow).toBe(true);
    expect(a.hoursUntilAppointment).toBeLessThan(0);
  });
});
