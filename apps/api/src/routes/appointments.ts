import type { FastifyPluginAsync } from 'fastify';
import {
  ApiError,
  AppointmentSchema,
  CancelAppointmentSchema,
  CreateAppointmentSchema,
  FindAppointmentsQuerySchema,
  RescheduleAppointmentSchema,
  paginatedSchema,
} from '@salon/contracts';
import { callingCodeFromSalonPhone, normalizePhone } from '@salon/core';
import { parseOrThrow } from '../lib/errors.js';
import { jsonSchema, COMMON_ERRORS, errorResponses } from '../lib/openapi.js';
import { withIdempotency } from '../plugins/idempotency.js';
import * as appointmentRepo from '../repositories/appointmentRepo.js';
import * as salonRepo from '../repositories/salonRepo.js';
import { serializeAppointment } from '../serializers/appointment.js';
import {
  bookAppointment,
  cancelAppointment,
  rescheduleAppointment,
} from '../services/schedulingService.js';

const IDEMPOTENCY_HEADER = {
  type: 'object',
  properties: {
    'idempotency-key': {
      type: 'string',
      description:
        'Required. A client-generated key. Retrying with the same key replays the original ' +
        'response instead of acting twice; reusing it for a *different* body is rejected with ' +
        'IDEMPOTENCY_KEY_REUSED.',
    },
  },
  required: ['idempotency-key'],
};

export const appointmentRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/appointments',
    {
      preHandler: app.requireScope('appointments:read'),
      schema: {
        tags: ['Appointments'],
        summary: 'Find appointments',
        description:
          'Filter by customer, phone, staff, service, date range or status. `upcomingOnly=true` ' +
          'returns future appointments that still stand — the query behind "when am I booked in?".\n\n' +
          'When more than one row comes back for a caller, the voice agent must disambiguate ' +
          'rather than assume; it never picks one on the customer\'s behalf.',
        querystring: jsonSchema(FindAppointmentsQuerySchema),
        response: { 200: jsonSchema(paginatedSchema(AppointmentSchema)), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const query = parseOrThrow(FindAppointmentsQuerySchema, request.query, 'query');
      const salonId = request.principal.salonId;
      const salon = await salonRepo.getSalon(salonId);
      if (!salon) throw new ApiError('NOT_FOUND', 'Salon not found.');

      let phone = query.phone;
      if (phone) {
        phone = normalizePhone(phone, { defaultCallingCode: callingCodeFromSalonPhone(salon.phone) }) ?? phone;
      }

      const statuses = query.status
        ? Array.isArray(query.status) ? query.status : [query.status]
        : undefined;

      const { rows, total } = await appointmentRepo.findAppointments(salonId, {
        customerId: query.customerId,
        phone,
        staffId: query.staffId,
        serviceId: query.serviceId,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        statuses,
        upcomingOnly: query.upcomingOnly,
        order: query.order,
        limit: query.limit,
        offset: query.offset,
      });

      const now = new Date().toISOString();
      return {
        data: rows.map((row) => serializeAppointment(row, salon.timezone, now)),
        pagination: { limit: query.limit, offset: query.offset, total, hasMore: query.offset + rows.length < total },
      };
    },
  );

  app.get(
    '/v1/appointments/:id',
    {
      preHandler: app.requireScope('appointments:read'),
      schema: {
        tags: ['Appointments'],
        summary: 'Get one appointment',
        response: { 200: jsonSchema(AppointmentSchema), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const salonId = request.principal.salonId;
      const [detail, salon] = await Promise.all([
        appointmentRepo.getAppointment(salonId, id),
        salonRepo.getSalon(salonId),
      ]);
      if (!detail) {
        throw new ApiError('APPOINTMENT_NOT_FOUND', 'That appointment does not exist.', { appointmentId: id });
      }
      return serializeAppointment(detail, salon!.timezone);
    },
  );

  app.post(
    '/v1/appointments',
    {
      preHandler: app.requireScope('appointments:write'),
      schema: {
        tags: ['Appointments'],
        summary: 'Book an appointment',
        description:
          'Validates the request against opening hours, closures, service status, staff ' +
          'competency and shifts, minimum notice, the advance window and the per-customer cap.\n\n' +
          'The overlap check is the write itself: a Postgres exclusion constraint serialises ' +
          'concurrent attempts on the same slot, so exactly one of two simultaneous callers can ' +
          'win. The loser receives SLOT_UNAVAILABLE **with nearby alternatives in `details`**, ' +
          'which is precisely the moment the customer most needs one.\n\n' +
          'Pass `customer` instead of `customerId` for a first-time caller — the customer record ' +
          'and the appointment are created together.',
        headers: IDEMPOTENCY_HEADER,
        body: jsonSchema(CreateAppointmentSchema),
        response: {
          201: jsonSchema(AppointmentSchema),
          ...errorResponses(
            [409, ['SLOT_UNAVAILABLE', 'NO_STAFF_AVAILABLE', 'IDEMPOTENCY_REQUEST_IN_PROGRESS']],
            [422, [
              'BOOKING_IN_PAST', 'LEAD_TIME_TOO_SHORT', 'TOO_FAR_IN_ADVANCE',
              'OUTSIDE_BUSINESS_HOURS', 'SALON_CLOSED_ON_DATE', 'SERVICE_INACTIVE',
              'STAFF_NOT_WORKING', 'STAFF_CANNOT_PERFORM_SERVICE',
              'MAX_ACTIVE_APPOINTMENTS_REACHED', 'IDEMPOTENCY_KEY_REUSED',
            ]],
            [404, ['SERVICE_NOT_FOUND', 'STAFF_NOT_FOUND', 'CUSTOMER_NOT_FOUND']],
          ),
          ...COMMON_ERRORS,
        },
      },
    },
    async (request, reply) =>
      withIdempotency(request, reply, 'POST /v1/appointments', async () => {
        const body = parseOrThrow(CreateAppointmentSchema, request.body, 'body');
        const appointment = await bookAppointment(request.principal.salonId, body, request.principal);
        return { status: 201, body: appointment };
      }),
  );

  app.post(
    '/v1/appointments/:id/cancel',
    {
      preHandler: app.requireScope('appointments:write'),
      schema: {
        tags: ['Appointments'],
        summary: 'Cancel an appointment',
        description:
          'A cancellation inside the salon\'s notice window is **not refused**. The endpoint ' +
          'returns CANCELLATION_WINDOW_PASSED carrying the fee, the window length and the hours ' +
          'remaining, so the agent can explain the charge and ask. Retrying with ' +
          '`acknowledgeFee: true` proceeds and records the fee on the appointment.',
        headers: IDEMPOTENCY_HEADER,
        body: jsonSchema(CancelAppointmentSchema),
        response: {
          200: jsonSchema(AppointmentSchema),
          ...errorResponses(
            [422, ['CANCELLATION_WINDOW_PASSED', 'APPOINTMENT_NOT_MODIFIABLE', 'IDEMPOTENCY_KEY_REUSED']],
            [404, ['APPOINTMENT_NOT_FOUND']],
          ),
          ...COMMON_ERRORS,
        },
      },
    },
    async (request, reply) =>
      withIdempotency(request, reply, 'POST /v1/appointments/:id/cancel', async () => {
        const { id } = request.params as { id: string };
        const body = parseOrThrow(CancelAppointmentSchema, request.body ?? {}, 'body');
        const appointment = await cancelAppointment(request.principal.salonId, id, {
          reason: body.reason ?? null,
          acknowledgeFee: body.acknowledgeFee,
        });
        return { status: 200, body: appointment };
      }),
  );

  app.post(
    '/v1/appointments/:id/reschedule',
    {
      preHandler: app.requireScope('appointments:write'),
      schema: {
        tags: ['Appointments'],
        summary: 'Move an appointment to a new time',
        description:
          'Atomic. The release of the old slot and the booking of the new one happen in one ' +
          'transaction, so a conflict on the new time rolls the release back and the original ' +
          'appointment stands — there is no state in which the customer has lost their slot and ' +
          'not gained another.\n\n' +
          'Returns the **new** appointment; the old one remains readable with status ' +
          '`rescheduled` and a `rescheduledToId` pointing forward.',
        headers: IDEMPOTENCY_HEADER,
        body: jsonSchema(RescheduleAppointmentSchema),
        response: {
          200: jsonSchema(AppointmentSchema),
          ...errorResponses(
            [409, ['SLOT_UNAVAILABLE', 'NO_STAFF_AVAILABLE']],
            [422, ['CANCELLATION_WINDOW_PASSED', 'APPOINTMENT_NOT_MODIFIABLE', 'OUTSIDE_BUSINESS_HOURS', 'LEAD_TIME_TOO_SHORT']],
            [404, ['APPOINTMENT_NOT_FOUND', 'SERVICE_NOT_FOUND']],
          ),
          ...COMMON_ERRORS,
        },
      },
    },
    async (request, reply) =>
      withIdempotency(request, reply, 'POST /v1/appointments/:id/reschedule', async () => {
        const { id } = request.params as { id: string };
        const body = parseOrThrow(RescheduleAppointmentSchema, request.body, 'body');
        const appointment = await rescheduleAppointment(request.principal.salonId, id, {
          start: body.start,
          serviceId: body.serviceId,
          staffId: body.staffId,
          reason: body.reason ?? null,
          acknowledgeFee: body.acknowledgeFee,
          callId: body.callId ?? null,
        });
        return { status: 200, body: appointment };
      }),
  );

  // Staff-only lifecycle transitions, used by the CRM rather than the agent.
  app.post(
    '/v1/appointments/:id/status',
    {
      preHandler: app.requireScope('appointments:write', 'customers:read:full'),
      schema: {
        tags: ['Appointments'],
        summary: 'Mark an appointment completed or a no-show (staff)',
        response: { 200: jsonSchema(AppointmentSchema), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const { status } = (request.body ?? {}) as { status?: string };
      if (status !== 'completed' && status !== 'no_show') {
        throw new ApiError('VALIDATION_FAILED', 'status must be "completed" or "no_show".', {
          source: 'body',
          fields: [{ path: 'status', message: 'must be "completed" or "no_show"' }],
        });
      }

      const salonId = request.principal.salonId;
      const updated = await appointmentRepo.updateAppointment(salonId, id, {
        status,
        completedAt: status === 'completed' ? new Date() : null,
      });
      if (!updated) {
        throw new ApiError('APPOINTMENT_NOT_FOUND', 'That appointment does not exist.', { appointmentId: id });
      }
      const [detail, salon] = await Promise.all([
        appointmentRepo.getAppointment(salonId, id),
        salonRepo.getSalon(salonId),
      ]);
      return serializeAppointment(detail!, salon!.timezone);
    },
  );
};
