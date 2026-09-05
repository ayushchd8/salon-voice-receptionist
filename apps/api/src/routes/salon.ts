import type { FastifyPluginAsync } from 'fastify';
import {
  ApiError,
  BusinessHoursResponseSchema,
  BookingPolicySchema,
  CreateClosedDateSchema,
  SalonSchema,
  UpdateBookingPolicySchema,
  UpdateBusinessHoursSchema,
} from '@salon/contracts';
import { parseOrThrow } from '../lib/errors.js';
import { jsonSchema, COMMON_ERRORS } from '../lib/openapi.js';
import * as salonRepo from '../repositories/salonRepo.js';
import { serializeBusinessHours, serializePolicy, serializeSalon } from '../serializers/misc.js';

export const salonRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/salon',
    {
      preHandler: app.requireScope('salon:read'),
      schema: {
        tags: ['Salon'],
        summary: 'Get the salon profile',
        description: 'The salon is determined by the credential; there is no id parameter.',
        response: { 200: jsonSchema(SalonSchema), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const salon = await salonRepo.getSalon(request.principal.salonId);
      if (!salon) throw new ApiError('NOT_FOUND', 'Salon not found.');
      return serializeSalon(salon);
    },
  );

  app.get(
    '/v1/business-hours',
    {
      preHandler: app.requireScope('hours:read'),
      schema: {
        tags: ['Salon'],
        summary: 'Get opening hours and date-specific closures',
        description:
          'Always returns seven day entries so a missing day reads as "closed" rather than "unknown". ' +
          'Times are salon-local wall clock; `timezone` tells you how to interpret them.',
        response: { 200: jsonSchema(BusinessHoursResponseSchema), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const { salonId } = request.principal;
      const [salon, hours, closures] = await Promise.all([
        salonRepo.getSalon(salonId),
        salonRepo.getBusinessHours(salonId),
        salonRepo.getClosedDates(salonId),
      ]);
      if (!salon) throw new ApiError('NOT_FOUND', 'Salon not found.');
      return serializeBusinessHours(salon.timezone, hours, closures);
    },
  );

  app.put(
    '/v1/business-hours',
    {
      preHandler: app.requireScope('hours:write'),
      schema: {
        tags: ['Salon'],
        summary: 'Replace the weekly opening hours',
        description: 'Whole-week replacement — a partial update of opening hours is almost always a bug.',
        body: jsonSchema(UpdateBusinessHoursSchema),
        response: { 200: jsonSchema(BusinessHoursResponseSchema), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const { salonId } = request.principal;
      const body = parseOrThrow(UpdateBusinessHoursSchema, request.body, 'body');
      await salonRepo.replaceBusinessHours(
        salonId,
        body.week.map((d) => ({
          dayOfWeek: d.dayOfWeek,
          isClosed: d.isClosed,
          openTime: d.openTime ?? null,
          closeTime: d.closeTime ?? null,
        })),
      );
      const [salon, hours, closures] = await Promise.all([
        salonRepo.getSalon(salonId),
        salonRepo.getBusinessHours(salonId),
        salonRepo.getClosedDates(salonId),
      ]);
      return serializeBusinessHours(salon!.timezone, hours, closures);
    },
  );

  app.post(
    '/v1/closed-dates',
    {
      preHandler: app.requireScope('hours:write'),
      schema: {
        tags: ['Salon'],
        summary: 'Add a holiday closure or special opening hours',
        description:
          'Omit both times to close all day. Provide both to override that date with special hours.',
        body: jsonSchema(CreateClosedDateSchema),
        response: { 201: { description: 'Created' }, ...COMMON_ERRORS },
      },
    },
    async (request, reply) => {
      const body = parseOrThrow(CreateClosedDateSchema, request.body, 'body');
      const row = await salonRepo.createClosedDate(request.principal.salonId, {
        date: body.date,
        reason: body.reason ?? null,
        openTime: body.openTime ?? null,
        closeTime: body.closeTime ?? null,
      });
      reply.status(201);
      return { id: row.id, date: row.date, reason: row.reason, openTime: row.openTime, closeTime: row.closeTime };
    },
  );

  app.delete(
    '/v1/closed-dates/:id',
    {
      preHandler: app.requireScope('hours:write'),
      schema: {
        tags: ['Salon'],
        summary: 'Remove a closure entry',
        response: { 204: { description: 'Deleted' }, ...COMMON_ERRORS },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const removed = await salonRepo.deleteClosedDate(request.principal.salonId, id);
      if (!removed) throw new ApiError('NOT_FOUND', 'No such closure entry.', { id });
      reply.status(204);
      return null;
    },
  );

  app.get(
    '/v1/booking-policy',
    {
      preHandler: app.requireScope('policies:read'),
      schema: {
        tags: ['Salon'],
        summary: 'Get the booking policy',
        description:
          'Notice periods, fees and slot granularity. The voice agent reads this to answer ' +
          '"how much notice do you need?" from live data rather than a hardcoded script.',
        response: { 200: jsonSchema(BookingPolicySchema), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const policy = await salonRepo.getPolicy(request.principal.salonId);
      if (!policy) throw new ApiError('NOT_FOUND', 'Booking policy not configured.');
      return serializePolicy(policy);
    },
  );

  app.patch(
    '/v1/booking-policy',
    {
      preHandler: app.requireScope('policies:write'),
      schema: {
        tags: ['Salon'],
        summary: 'Update the booking policy',
        body: jsonSchema(UpdateBookingPolicySchema),
        response: { 200: jsonSchema(BookingPolicySchema), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const body = parseOrThrow(UpdateBookingPolicySchema, request.body, 'body');
      const updated = await salonRepo.updatePolicy(request.principal.salonId, body);
      if (!updated) throw new ApiError('NOT_FOUND', 'Booking policy not configured.');
      return serializePolicy(updated);
    },
  );
};
