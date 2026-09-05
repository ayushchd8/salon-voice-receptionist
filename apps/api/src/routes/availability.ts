import type { FastifyPluginAsync } from 'fastify';
import {
  AvailabilityResponseSchema,
  GetAvailabilityQuerySchema,
  ResolveTimeQuerySchema,
  ResolveTimeResponseSchema,
  ApiError,
} from '@salon/contracts';
import { resolveTimeExpression } from '@salon/core';
import { parseOrThrow } from '../lib/errors.js';
import { jsonSchema, COMMON_ERRORS, errorResponses } from '../lib/openapi.js';
import { getAvailability } from '../services/schedulingService.js';
import * as salonRepo from '../repositories/salonRepo.js';

export const availabilityRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/availability',
    {
      preHandler: app.requireScope('availability:read'),
      schema: {
        tags: ['Availability'],
        summary: 'Find bookable slots',
        description:
          'Accepts either an explicit `from`/`to` window or a natural-language `timeExpression` ' +
          'such as "next friday afternoon", resolved server-side by the same deterministic code ' +
          'the voice agent uses.\n\n' +
          'Honours opening hours, holiday closures, per-staff shifts and competencies, existing ' +
          'bookings including their buffers, minimum notice and the maximum advance window.\n\n' +
          'When the requested window has nothing free, `alternatives` carries two or three nearby ' +
          'bookable times, spread across different days — so "we\'re full then" is never a dead end.',
        querystring: jsonSchema(GetAvailabilityQuerySchema),
        response: {
          200: jsonSchema(AvailabilityResponseSchema),
          ...errorResponses([422, ['UNPARSEABLE_TIME_EXPRESSION', 'SERVICE_INACTIVE']], [404, ['SERVICE_NOT_FOUND', 'STAFF_NOT_FOUND']]),
          ...COMMON_ERRORS,
        },
      },
    },
    async (request) => {
      const query = parseOrThrow(GetAvailabilityQuerySchema, request.query, 'query');
      return getAvailability(request.principal.salonId, query);
    },
  );

  app.get(
    '/v1/resolve-time',
    {
      preHandler: app.requireScope('availability:read'),
      schema: {
        tags: ['Availability'],
        summary: 'Resolve a fuzzy time expression to a concrete window',
        description:
          'Turns "a week from tuesday" or "sometime after 3" into instants in the salon\'s ' +
          'timezone, with an `interpretation` string meant to be read back to the caller for ' +
          'confirmation. Exposed as a distinct endpoint so date arithmetic never happens inside ' +
          'the language model.',
        querystring: jsonSchema(ResolveTimeQuerySchema),
        response: {
          200: jsonSchema(ResolveTimeResponseSchema),
          ...errorResponses([422, ['UNPARSEABLE_TIME_EXPRESSION']]),
          ...COMMON_ERRORS,
        },
      },
    },
    async (request) => {
      const query = parseOrThrow(ResolveTimeQuerySchema, request.query, 'query');
      const salon = await salonRepo.getSalon(request.principal.salonId);
      if (!salon) throw new ApiError('NOT_FOUND', 'Salon not found.');

      const now = query.now ?? new Date().toISOString();
      const resolved = resolveTimeExpression(query.expression, { now, timezone: salon.timezone });
      if (!resolved) {
        throw new ApiError(
          'UNPARSEABLE_TIME_EXPRESSION',
          `Could not work out a date and time from "${query.expression}".`,
          { expression: query.expression, hint: 'Ask the caller for a specific day or time.' },
        );
      }

      return {
        expression: query.expression,
        from: resolved.from,
        to: resolved.to,
        interpretation: resolved.interpretation,
        timezone: salon.timezone,
        isBroad: resolved.isBroad,
      };
    },
  );
};
