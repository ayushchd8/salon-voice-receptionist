/**
 * Scheduling orchestration.
 *
 * Loads state, delegates every *decision* to the pure engine in @salon/core,
 * and owns the transaction boundaries. Nothing here re-implements a scheduling
 * rule — if a rule appears in two places, availability and booking eventually
 * disagree and the agent starts offering slots the API refuses.
 */
import { DateTime } from 'luxon';
import {
  assessCancellation,
  callingCodeFromSalonPhone,
  canStaffPerform,
  computeAvailability,
  computeBlockRange,
  findAlternatives,
  normalizePhone,
  overlaps,
  resolveTimeExpression,
  speakableLabel,
  staffIntervalsForDate,
  toSalonTime,
  validateBookingWindow,
  validateStaffForBooking,
  type BusyBlock,
  type ComputedSlot,
  type SchedulingContext,
  type StaffDef,
} from '@salon/core';
import type {
  Appointment,
  AvailabilityResponse,
  CreateAppointmentInput,
  GetAvailabilityQuery,
  Slot,
} from '@salon/contracts';
import { ApiError, RECOVERABLE_SCHEDULING_CODES } from '@salon/contracts';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { appointments as appointmentsTable } from '../db/schema.js';
import * as salonRepo from '../repositories/salonRepo.js';
import * as catalogRepo from '../repositories/catalogRepo.js';
import * as customerRepo from '../repositories/customerRepo.js';
import * as appointmentRepo from '../repositories/appointmentRepo.js';
import { serializeAppointment } from '../serializers/appointment.js';
import { translateDatabaseError } from '../lib/errors.js';
import type { Principal } from '../plugins/auth.js';
import { logger } from '../lib/logger.js';

interface SalonSetup {
  context: SchedulingContext;
  timezone: string;
  salonPhone: string | null;
}

async function loadSetup(salonId: string): Promise<SalonSetup> {
  const [context, salon] = await Promise.all([
    salonRepo.loadSchedulingContext(salonId),
    salonRepo.getSalon(salonId),
  ]);
  if (!context || !salon) {
    throw new ApiError('NOT_FOUND', 'Salon configuration is missing.');
  }
  return { context, timezone: salon.timezone, salonPhone: salon.phone };
}

function toSlotDto(slot: ComputedSlot): Slot {
  return {
    start: slot.start,
    end: slot.end,
    staffId: slot.staffId,
    staffName: slot.staffName,
    localDate: slot.localDate,
    localTime: slot.localTime,
    label: slot.label,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Availability
// ─────────────────────────────────────────────────────────────────────────────

export async function getAvailability(
  salonId: string,
  query: GetAvailabilityQuery,
): Promise<AvailabilityResponse> {
  const { context, timezone } = await loadSetup(salonId);
  const now = new Date().toISOString();

  // A natural-language window is resolved by the same deterministic code the
  // voice agent uses, so the agent and the API can never disagree about what
  // "next Friday afternoon" meant.
  let from: string;
  let to: string;
  let interpretation: string | null = null;

  if (query.timeExpression) {
    const resolved = resolveTimeExpression(query.timeExpression, { now, timezone });
    if (!resolved) {
      throw new ApiError(
        'UNPARSEABLE_TIME_EXPRESSION',
        `Could not work out a date and time from "${query.timeExpression}".`,
        { expression: query.timeExpression, hint: 'Ask the caller for a specific day or time.' },
      );
    }
    from = resolved.from;
    to = resolved.to;
    interpretation = resolved.interpretation;
  } else {
    from = query.from!;
    to = query.to!;
  }

  const serviceRow = await catalogRepo.getService(salonId, query.serviceId);
  if (!serviceRow) {
    throw new ApiError('SERVICE_NOT_FOUND', 'That service does not exist.', { serviceId: query.serviceId });
  }
  if (!serviceRow.active) {
    throw new ApiError('SERVICE_INACTIVE', `${serviceRow.name} is not currently offered.`, {
      serviceId: serviceRow.id,
    });
  }
  const service = catalogRepo.toServiceDef(serviceRow);

  const staffRecords = await catalogRepo.listStaff(salonId, { activeOnly: true });
  if (query.staffId && !staffRecords.some((s) => s.id === query.staffId)) {
    throw new ApiError('STAFF_NOT_FOUND', 'That staff member does not exist or is inactive.', {
      staffId: query.staffId,
    });
  }
  const staff = staffRecords.map(catalogRepo.toStaffDef);

  // Load a window wide enough to answer the request *and* to find alternatives
  // outside it, in one round trip.
  const busy = await appointmentRepo.loadBusyBlocks(
    salonId,
    DateTime.fromISO(from).minus({ days: 3 }).toJSDate(),
    DateTime.fromISO(to).plus({ days: 12 }).toJSDate(),
  );

  const request = {
    context, service, staff, busy, from, to, now,
    staffId: query.staffId,
    limit: query.limit,
  };

  const slots = computeAvailability(request);
  const alternatives =
    slots.length === 0 && query.includeAlternatives ? findAlternatives(request, 3) : [];

  return {
    timezone,
    service: { id: service.id, name: service.name, durationMinutes: service.durationMinutes },
    requestedWindow: { from, to, interpretation },
    slots: slots.map(toSlotDto),
    alternatives: alternatives.map(toSlotDto),
    unavailableReason:
      slots.length > 0 ? null : explainEmptyWindow(context, from, to, timezone, alternatives.length),
  };
}

/** A short, speakable reason the requested window came back empty. */
function explainEmptyWindow(
  context: SchedulingContext,
  from: string,
  to: string,
  timezone: string,
  alternativeCount: number,
): string {
  const date = toSalonTime(from, timezone).toFormat('yyyy-MM-dd');
  const closure = context.closedDates.find((c) => c.date === date);
  if (closure && !closure.openTime) {
    return closure.reason ? `The salon is closed that day (${closure.reason}).` : 'The salon is closed that day.';
  }
  const dow = toSalonTime(from, timezone).weekday % 7;
  const rule = context.businessHours.find((h) => h.dayOfWeek === dow);
  if (rule?.isClosed && toSalonTime(from, timezone).toFormat('yyyy-MM-dd') === toSalonTime(to, timezone).toFormat('yyyy-MM-dd')) {
    return 'The salon is closed on that day of the week.';
  }
  return alternativeCount > 0
    ? 'Fully booked in the window requested; nearby times are available.'
    : 'Fully booked in the window requested.';
}

// ─────────────────────────────────────────────────────────────────────────────
// Booking
// ─────────────────────────────────────────────────────────────────────────────

export async function bookAppointment(
  salonId: string,
  input: CreateAppointmentInput,
  principal: Principal,
): Promise<Appointment> {
  const { context, timezone, salonPhone } = await loadSetup(salonId);
  const now = new Date().toISOString();

  const serviceRow = await catalogRepo.getService(salonId, input.serviceId);
  if (!serviceRow) {
    throw new ApiError('SERVICE_NOT_FOUND', 'That service does not exist.', { serviceId: input.serviceId });
  }
  const service = catalogRepo.toServiceDef(serviceRow);
  const range = computeBlockRange(input.start, service);

  // 1. Time and policy rules — the same function the availability engine uses.
  const violation = validateBookingWindow({
    start: range.start, end: range.end, now, context, service,
  });
  if (violation) {
    throw new ApiError(violation.code, violation.message, violation.details);
  }

  // 2. Resolve a concrete staff member. The database constraint requires one.
  const staffRecords = await catalogRepo.listStaff(salonId, { activeOnly: true });
  const staffDefs = staffRecords.map(catalogRepo.toStaffDef);
  const busy = await appointmentRepo.loadBusyBlocks(
    salonId,
    DateTime.fromISO(range.blockStart).minus({ days: 1 }).toJSDate(),
    DateTime.fromISO(range.blockEnd).plus({ days: 1 }).toJSDate(),
  );

  let staff: StaffDef;
  try {
    staff = await resolveStaff({
      salonId, input, service, range, context, staffDefs, busy, timezone, now,
    });
  } catch (err) {
    throw await enrichSlotConflict(err, { salonId, context, service, staffDefs, range, now });
  }

  // 3. Resolve the customer, creating one for a first-time caller.
  const customer = await resolveCustomer(salonId, input, salonPhone);

  // 4. Per-customer cap, so one number cannot quietly hold the whole diary.
  const activeCount = await appointmentRepo.countActiveForCustomer(salonId, customer.id);
  if (activeCount >= context.policy.maxActiveAppointmentsPerCustomer) {
    throw new ApiError(
      'MAX_ACTIVE_APPOINTMENTS_REACHED',
      `That customer already has ${activeCount} upcoming appointments.`,
      { limit: context.policy.maxActiveAppointmentsPerCustomer, current: activeCount },
    );
  }

  // 5. Overbooking is staff-only and policy-gated. The voice agent holds
  //    neither the scope nor a reason to ask.
  if (input.overbook) {
    if (!principal.scopes.includes('appointments:overbook')) {
      throw new ApiError('FORBIDDEN_SCOPE', 'This credential cannot create overlapping bookings.', {
        required: ['appointments:overbook'],
      });
    }
    if (!context.policy.allowDoubleBooking) {
      throw new ApiError('OVERBOOKING_NOT_ALLOWED', "This salon's policy does not allow double booking.");
    }
  }

  // 6. Write. The overlap check is the INSERT itself — see 0001_init.sql.
  try {
    const row = await appointmentRepo.insertAppointment({
      salonId,
      customerId: customer.id,
      serviceId: service.id,
      staffId: staff.id,
      startTime: new Date(range.start),
      endTime: new Date(range.end),
      blockStart: new Date(range.blockStart),
      blockEnd: new Date(range.blockEnd),
      status: 'booked',
      source: input.source,
      callId: input.callId ?? null,
      notes: input.notes ?? null,
      priceAtBooking: serviceRow.price,
      currency: serviceRow.currency,
      overbooked: input.overbook,
    });

    const detail = await appointmentRepo.getAppointment(salonId, row.id);
    logger.info(
      { appointmentId: row.id, serviceId: service.id, staffId: staff.id, source: input.source },
      'appointment booked',
    );
    return serializeAppointment(detail!, timezone, now);
  } catch (err) {
    throw await enrichSlotConflict(err, { salonId, context, service, staffDefs, range, now, staffId: staff.id });
  }
}

/**
 * Turn "that time doesn't work" into an answer the caller can act on.
 *
 * Whether the slot was lost to a concurrent booking, to a fully-booked diary or
 * to nobody being rostered, the moment a customer is told no is exactly the
 * moment they need two or three concrete times instead. Every recoverable
 * scheduling failure therefore leaves here carrying alternatives in `details`.
 */
async function enrichSlotConflict(
  err: unknown,
  args: {
    salonId: string;
    context: SchedulingContext;
    service: { id: string; name: string; durationMinutes: number; bufferBeforeMinutes: number; bufferAfterMinutes: number; active: boolean };
    staffDefs: StaffDef[];
    range: { start: string; end: string; blockStart: string; blockEnd: string };
    now: string;
    staffId?: string;
  },
): Promise<unknown> {
  // Either a raw constraint violation from the database, or an ApiError raised
  // by the staff-resolution step above.
  const translated =
    err instanceof ApiError ? err : translateDatabaseError(err);
  if (!translated || !RECOVERABLE_SCHEDULING_CODES.has(translated.code)) return translated ?? err;

  try {
    const busy = await appointmentRepo.loadBusyBlocks(
      args.salonId,
      DateTime.fromISO(args.range.start).minus({ days: 3 }).toJSDate(),
      DateTime.fromISO(args.range.start).plus({ days: 12 }).toJSDate(),
    );
    const alternatives = findAlternatives(
      {
        context: args.context,
        service: args.service,
        staff: args.staffDefs,
        busy,
        from: args.range.start,
        to: args.range.end,
        now: args.now,
        limit: 20,
      },
      3,
    );
    return new ApiError(translated.code, translated.message, {
      ...translated.details,
      requestedStart: args.range.start,
      alternatives: alternatives.map(toSlotDto),
    });
  } catch {
    // Finding alternatives is a courtesy; never let it replace the real error.
    return translated;
  }
}

async function resolveStaff(args: {
  salonId: string;
  input: CreateAppointmentInput;
  service: ReturnType<typeof catalogRepo.toServiceDef>;
  range: { start: string; end: string; blockStart: string; blockEnd: string };
  context: SchedulingContext;
  staffDefs: StaffDef[];
  busy: BusyBlock[];
  timezone: string;
  now: string;
}): Promise<StaffDef> {
  const { input, service, range, context, staffDefs, busy } = args;

  const isFree = (staffId: string) =>
    !busy.some(
      (b) => b.staffId === staffId && overlaps(range.blockStart, range.blockEnd, b.blockStart, b.blockEnd),
    );

  if (input.staffId) {
    const staff = staffDefs.find((s) => s.id === input.staffId);
    if (!staff) {
      throw new ApiError('STAFF_NOT_FOUND', 'That staff member does not exist or is inactive.', {
        staffId: input.staffId,
      });
    }
    const violation = validateStaffForBooking({
      start: range.start, end: range.end, staff, service, context,
    });
    if (violation) throw new ApiError(violation.code, violation.message, violation.details);
    // Availability is still enforced by the database; this only produces a
    // better error than a raw constraint violation.
    if (!input.overbook && !isFree(staff.id)) {
      throw new ApiError('SLOT_UNAVAILABLE', `${staff.name} is already booked at that time.`, {
        staffId: staff.id,
        requestedStart: range.start,
      });
    }
    return staff;
  }

  // "Anyone's fine" — pick the least-loaded qualified stylist who is working
  // and free. The row is never left unassigned.
  const localDate = toSalonTime(range.start, args.timezone).toFormat('yyyy-MM-dd');
  const candidates = staffDefs.filter((staff) => {
    if (!staff.active || !canStaffPerform(staff, service.id)) return false;
    const shifts = staffIntervalsForDate(localDate, context, staff);
    if (!shifts.some((w) => range.start >= w.start && range.end <= w.end)) return false;
    return input.overbook || isFree(staff.id);
  });

  if (candidates.length === 0) {
    // Distinguish the two reasons, because they mean different things to the
    // caller: "we're booked up then" invites a nearby time, whereas "nobody who
    // does that works then" invites a different day entirely.
    const qualifiedAndWorking = staffDefs.some(
      (staff) =>
        staff.active &&
        canStaffPerform(staff, service.id) &&
        staffIntervalsForDate(localDate, context, staff).some(
          (w) => range.start >= w.start && range.end <= w.end,
        ),
    );
    throw qualifiedAndWorking
      ? new ApiError('SLOT_UNAVAILABLE', 'Everyone who does that is already booked at that time.', {
          requestedStart: range.start,
          serviceId: service.id,
        })
      : new ApiError('NO_STAFF_AVAILABLE', 'Nobody who does that service is working then.', {
          requestedStart: range.start,
          serviceId: service.id,
        });
  }

  const loadOf = (staffId: string) => busy.filter((b) => b.staffId === staffId).length;
  return candidates.sort((a, b) => loadOf(a.id) - loadOf(b.id) || a.name.localeCompare(b.name))[0]!;
}

async function resolveCustomer(
  salonId: string,
  input: CreateAppointmentInput,
  salonPhone: string | null,
) {
  if (input.customerId) {
    const customer = await customerRepo.getCustomer(salonId, input.customerId);
    if (!customer) {
      throw new ApiError('CUSTOMER_NOT_FOUND', 'That customer does not exist.', {
        customerId: input.customerId,
      });
    }
    return customer;
  }

  const raw = input.customer!;
  const phone = normalizePhone(raw.phone, {
    defaultCallingCode: callingCodeFromSalonPhone(salonPhone),
  });
  if (!phone) {
    throw new ApiError('VALIDATION_FAILED', 'That phone number could not be understood.', {
      source: 'body',
      fields: [{ path: 'customer.phone', message: 'must be a valid phone number' }],
    });
  }

  const { customer } = await customerRepo.findOrCreateByPhone(salonId, {
    firstName: raw.firstName,
    lastName: raw.lastName ?? null,
    phone,
    email: raw.email ?? null,
  });
  return customer;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation
// ─────────────────────────────────────────────────────────────────────────────

export async function cancelAppointment(
  salonId: string,
  appointmentId: string,
  input: { reason?: string | null; acknowledgeFee: boolean },
): Promise<Appointment> {
  const { context, timezone } = await loadSetup(salonId);
  const now = new Date().toISOString();

  const detail = await appointmentRepo.getAppointment(salonId, appointmentId);
  if (!detail) {
    throw new ApiError('APPOINTMENT_NOT_FOUND', 'That appointment does not exist.', { appointmentId });
  }

  assertModifiable(detail.appointment.status, detail.appointment.startTime, now, timezone);

  const assessment = assessCancellation({
    appointmentStart: detail.appointment.startTime.toISOString(),
    now,
    policy: context.policy,
  });

  // Note what this is *not*: a refusal. The caller is told the fee and asked;
  // retrying with acknowledgeFee proceeds. Silently refusing would leave a
  // customer unable to cancel at all, which is worse for everyone.
  if (assessment.feeApplies && !input.acknowledgeFee) {
    throw new ApiError(
      'CANCELLATION_WINDOW_PASSED',
      `That's inside our ${assessment.windowHours}-hour cancellation window, so a ` +
        `${assessment.currency} ${assessment.fee} late cancellation fee applies.`,
      {
        windowHours: assessment.windowHours,
        hoursUntilAppointment: assessment.hoursUntilAppointment,
        feeApplies: true,
        fee: assessment.fee,
        currency: assessment.currency,
        proceedWith: 'acknowledgeFee',
      },
    );
  }

  await appointmentRepo.updateAppointment(salonId, appointmentId, {
    status: 'cancelled',
    cancellationReason: input.reason ?? null,
    cancellationFee: assessment.feeApplies ? assessment.fee : '0.00',
    cancelledAt: new Date(),
  });

  const updated = await appointmentRepo.getAppointment(salonId, appointmentId);
  logger.info({ appointmentId, feeApplied: assessment.feeApplies }, 'appointment cancelled');
  return serializeAppointment(updated!, timezone, now);
}

function assertModifiable(status: string, startTime: Date, now: string, timezone: string): void {
  if (status !== 'booked') {
    const explanation: Record<string, string> = {
      cancelled: 'That appointment has already been cancelled.',
      completed: 'That appointment has already taken place.',
      no_show: 'That appointment is marked as a no-show.',
      rescheduled: 'That appointment was already moved to a new time.',
    };
    throw new ApiError(
      'APPOINTMENT_NOT_MODIFIABLE',
      explanation[status] ?? 'That appointment can no longer be changed.',
      { status },
    );
  }
  if (startTime.toISOString() <= now) {
    throw new ApiError(
      'APPOINTMENT_NOT_MODIFIABLE',
      `That appointment was ${speakableLabel(startTime.toISOString(), timezone, now)} and has already started.`,
      { status, startTime: startTime.toISOString() },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reschedule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Move an appointment atomically.
 *
 * The requirement is that this never leaves an orphaned cancellation — a
 * customer whose old slot was released and whose new slot then failed. It is
 * satisfied structurally: the release and the re-book happen in one
 * transaction, so a conflict on the new time rolls the release back and the
 * original appointment stands untouched.
 *
 * The ordering inside the transaction matters. The old row is marked
 * `rescheduled` *first*, which removes it from the exclusion constraint's
 * predicate — otherwise moving an appointment by fifteen minutes would collide
 * with its own former self.
 */
export async function rescheduleAppointment(
  salonId: string,
  appointmentId: string,
  input: {
    start: string;
    serviceId?: string | undefined;
    staffId?: string | undefined;
    reason?: string | null;
    acknowledgeFee: boolean;
    callId?: string | null;
  },
): Promise<Appointment> {
  const { context, timezone } = await loadSetup(salonId);
  const now = new Date().toISOString();

  const existing = await appointmentRepo.getAppointment(salonId, appointmentId);
  if (!existing) {
    throw new ApiError('APPOINTMENT_NOT_FOUND', 'That appointment does not exist.', { appointmentId });
  }
  assertModifiable(existing.appointment.status, existing.appointment.startTime, now, timezone);

  const serviceRow = input.serviceId
    ? await catalogRepo.getService(salonId, input.serviceId)
    : existing.service;
  if (!serviceRow) {
    throw new ApiError('SERVICE_NOT_FOUND', 'That service does not exist.', { serviceId: input.serviceId });
  }
  const service = catalogRepo.toServiceDef(serviceRow);
  const range = computeBlockRange(input.start, service);

  const violation = validateBookingWindow({ start: range.start, end: range.end, now, context, service });
  if (violation) throw new ApiError(violation.code, violation.message, violation.details);

  // Moving an appointment at short notice is subject to the same notice policy
  // as cancelling it — otherwise "reschedule to next year" is a free cancellation.
  const assessment = assessCancellation({
    appointmentStart: existing.appointment.startTime.toISOString(),
    now,
    policy: context.policy,
  });
  if (assessment.feeApplies && !input.acknowledgeFee) {
    throw new ApiError(
      'CANCELLATION_WINDOW_PASSED',
      `Moving an appointment inside our ${assessment.windowHours}-hour window incurs a ` +
        `${assessment.currency} ${assessment.fee} fee.`,
      {
        windowHours: assessment.windowHours,
        hoursUntilAppointment: assessment.hoursUntilAppointment,
        feeApplies: true,
        fee: assessment.fee,
        currency: assessment.currency,
        proceedWith: 'acknowledgeFee',
      },
    );
  }

  const staffRecords = await catalogRepo.listStaff(salonId, { activeOnly: true });
  const staffDefs = staffRecords.map(catalogRepo.toStaffDef);
  const busy = await appointmentRepo.loadBusyBlocks(
    salonId,
    DateTime.fromISO(range.blockStart).minus({ days: 1 }).toJSDate(),
    DateTime.fromISO(range.blockEnd).plus({ days: 1 }).toJSDate(),
    // The appointment being moved must not block its own new time.
    { excludeAppointmentId: appointmentId },
  );

  let staff: StaffDef;
  try {
    staff = await resolveStaff({
    salonId,
    input: {
      serviceId: service.id,
      staffId: input.staffId ?? undefined,
      start: input.start,
      source: 'voice',
      overbook: false,
    } as CreateAppointmentInput,
      service, range, context, staffDefs, busy, timezone, now,
    });
  } catch (err) {
    throw await enrichSlotConflict(err, { salonId, context, service, staffDefs, range, now });
  }

  try {
    const newId = await db.transaction(async (tx) => {
      // (a) Release the old slot — this also removes the row from the exclusion
      //     constraint's predicate, so the new insert cannot conflict with it.
      await tx
        .update(appointmentsTable)
        .set({ status: 'rescheduled', cancellationReason: input.reason ?? 'Rescheduled', cancelledAt: new Date() })
        .where(eqAppointment(salonId, appointmentId));

      // (b) Take the new slot. A conflict here throws, rolling (a) back.
      const created = await appointmentRepo.insertAppointment(
        {
          salonId,
          customerId: existing.appointment.customerId,
          serviceId: service.id,
          staffId: staff.id,
          startTime: new Date(range.start),
          endTime: new Date(range.end),
          blockStart: new Date(range.blockStart),
          blockEnd: new Date(range.blockEnd),
          status: 'booked',
          source: existing.appointment.source,
          callId: input.callId ?? existing.appointment.callId,
          notes: existing.appointment.notes,
          priceAtBooking: serviceRow.price,
          currency: serviceRow.currency,
          rescheduledFromId: appointmentId,
          cancellationFee: assessment.feeApplies ? assessment.fee : '0.00',
        },
        tx,
      );

      // (c) Link the old row forward, so the history is navigable in the CRM.
      await tx
        .update(appointmentsTable)
        .set({ rescheduledToId: created.id })
        .where(eqAppointment(salonId, appointmentId));

      return created.id;
    });

    const detail = await appointmentRepo.getAppointment(salonId, newId);
    logger.info({ from: appointmentId, to: newId }, 'appointment rescheduled');
    return serializeAppointment(detail!, timezone, now);
  } catch (err) {
    throw await enrichSlotConflict(err, { salonId, context, service, staffDefs, range, now });
  }
}

// Small local helper to keep the transaction body readable.
function eqAppointment(salonId: string, appointmentId: string) {
  return and(eq(appointmentsTable.salonId, salonId), eq(appointmentsTable.id, appointmentId));
}
