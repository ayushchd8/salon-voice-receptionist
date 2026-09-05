import type { Appointment, AppointmentStatus } from '@salon/contracts';
import { speakableLabel, toSalonTime } from '@salon/core';
import type { AppointmentDetail } from '../repositories/appointmentRepo.js';
import { serializeCustomerSummary } from './customer.js';

/**
 * Appointments always carry salon-local date, time and a speakable label
 * alongside the raw instants.
 *
 * The voice agent therefore never formats a date itself. An LLM asked to render
 * "2026-10-03T13:30:00.000Z" for a London salon has a real chance of saying
 * "half past one" — an hour out, confidently. Doing it here removes the
 * opportunity.
 */
export function serializeAppointment(
  detail: AppointmentDetail,
  timezone: string,
  now = new Date().toISOString(),
): Appointment {
  const { appointment: a, customer, service, staff } = detail;
  const start = a.startTime.toISOString();
  const local = toSalonTime(start, timezone);

  return {
    id: a.id,
    status: a.status as AppointmentStatus,
    source: a.source as Appointment['source'],
    start,
    end: a.endTime.toISOString(),
    localDate: local.toFormat('yyyy-MM-dd'),
    localTime: local.toFormat('HH:mm'),
    label: speakableLabel(start, timezone, now),
    service: {
      id: service.id,
      name: service.name,
      durationMinutes: service.durationMinutes,
    },
    staff: { id: staff.id, name: staff.name },
    customer: serializeCustomerSummary(customer),
    priceAtBooking: a.priceAtBooking,
    currency: a.currency,
    notes: a.notes,
    callId: a.callId,
    rescheduledFromId: a.rescheduledFromId,
    rescheduledToId: a.rescheduledToId,
    cancellationReason: a.cancellationReason,
    cancellationFee: a.cancellationFee,
    cancelledAt: a.cancelledAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}
