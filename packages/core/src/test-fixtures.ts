/**
 * Shared fixtures for the domain-engine tests.
 *
 * A salon in Europe/London so DST is exercised by construction, open Mon–Fri
 * 09:00–18:00 and Sat 09:00–16:00, closed Sunday.
 */
import type { PolicyDef, SchedulingContext, ServiceDef, StaffDef } from './types.js';

export const TZ = 'Europe/London';

export const defaultPolicy: PolicyDef = {
  minLeadMinutes: 0,
  maxAdvanceDays: 90,
  cancellationWindowHours: 24,
  lateCancellationFee: '15.00',
  noShowFee: '25.00',
  slotGranularityMinutes: 15,
  allowDoubleBooking: false,
  maxActiveAppointmentsPerCustomer: 5,
  currency: 'GBP',
};

export function makeContext(overrides: Partial<SchedulingContext> = {}): SchedulingContext {
  return {
    salonId: 'salon-1',
    timezone: TZ,
    businessHours: [
      { dayOfWeek: 0, isClosed: true, openTime: null, closeTime: null },
      { dayOfWeek: 1, isClosed: false, openTime: '09:00:00', closeTime: '18:00:00' },
      { dayOfWeek: 2, isClosed: false, openTime: '09:00:00', closeTime: '18:00:00' },
      { dayOfWeek: 3, isClosed: false, openTime: '09:00:00', closeTime: '18:00:00' },
      { dayOfWeek: 4, isClosed: false, openTime: '09:00:00', closeTime: '18:00:00' },
      { dayOfWeek: 5, isClosed: false, openTime: '09:00:00', closeTime: '18:00:00' },
      { dayOfWeek: 6, isClosed: false, openTime: '09:00:00', closeTime: '16:00:00' },
    ],
    closedDates: [],
    policy: defaultPolicy,
    ...overrides,
  };
}

export const cutService: ServiceDef = {
  id: 'svc-cut',
  name: 'Cut & Blow Dry',
  durationMinutes: 60,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 15,
  active: true,
};

export const colourService: ServiceDef = {
  id: 'svc-colour',
  name: 'Full Colour',
  durationMinutes: 120,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 30,
  active: true,
};

export const priya: StaffDef = {
  id: 'staff-priya',
  name: 'Priya',
  active: true,
  serviceIds: [],
  workingHours: [],
};

export const sam: StaffDef = {
  id: 'staff-sam',
  name: 'Sam',
  active: true,
  serviceIds: ['svc-cut'],
  workingHours: [],
};
