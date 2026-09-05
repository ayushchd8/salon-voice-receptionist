import type { FastifyPluginAsync } from 'fastify';
import {
  ApiError,
  CreateServiceSchema,
  CreateStaffSchema,
  ListServicesQuerySchema,
  ServiceSchema,
  StaffMemberSchema,
  UpdateServiceSchema,
  UpdateStaffSchema,
} from '@salon/contracts';
import { z } from 'zod';
import { parseOrThrow } from '../lib/errors.js';
import { jsonSchema, COMMON_ERRORS } from '../lib/openapi.js';
import * as catalogRepo from '../repositories/catalogRepo.js';
import { serializeService, serializeStaff } from '../serializers/misc.js';

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  // ── services ────────────────────────────────────────────────────────────────
  app.get(
    '/v1/services',
    {
      preHandler: app.requireScope('services:read'),
      schema: {
        tags: ['Services'],
        summary: 'List services',
        description:
          'Defaults to active services only — a caller asking "what do you offer?" must not be ' +
          'read a list that includes retired treatments. Pass `active=all` to see everything.',
        querystring: jsonSchema(ListServicesQuerySchema),
        response: { 200: jsonSchema(z.object({ data: z.array(ServiceSchema) })), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const query = parseOrThrow(ListServicesQuerySchema, request.query, 'query');
      const rows = await catalogRepo.listServices(request.principal.salonId, query);
      return { data: rows.map(serializeService) };
    },
  );

  app.get(
    '/v1/services/:id',
    {
      preHandler: app.requireScope('services:read'),
      schema: {
        tags: ['Services'],
        summary: 'Get one service',
        response: { 200: jsonSchema(ServiceSchema), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const row = await catalogRepo.getService(request.principal.salonId, id);
      if (!row) throw new ApiError('SERVICE_NOT_FOUND', 'That service does not exist.', { serviceId: id });
      return serializeService(row);
    },
  );

  app.post(
    '/v1/services',
    {
      preHandler: app.requireScope('services:write'),
      schema: {
        tags: ['Services'],
        summary: 'Create a service',
        body: jsonSchema(CreateServiceSchema),
        response: { 201: jsonSchema(ServiceSchema), ...COMMON_ERRORS },
      },
    },
    async (request, reply) => {
      const body = parseOrThrow(CreateServiceSchema, request.body, 'body');
      const row = await catalogRepo.createService(request.principal.salonId, body);
      reply.status(201);
      return serializeService(row);
    },
  );

  app.patch(
    '/v1/services/:id',
    {
      preHandler: app.requireScope('services:write'),
      schema: {
        tags: ['Services'],
        summary: 'Update a service',
        description:
          'Deactivating a service leaves existing appointments intact — historical bookings must ' +
          'still render, so services are retired rather than deleted.',
        body: jsonSchema(UpdateServiceSchema),
        response: { 200: jsonSchema(ServiceSchema), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parseOrThrow(UpdateServiceSchema, request.body, 'body');
      const row = await catalogRepo.updateService(request.principal.salonId, id, body);
      if (!row) throw new ApiError('SERVICE_NOT_FOUND', 'That service does not exist.', { serviceId: id });
      return serializeService(row);
    },
  );

  // ── staff ───────────────────────────────────────────────────────────────────
  app.get(
    '/v1/staff',
    {
      preHandler: app.requireScope('staff:read'),
      schema: {
        tags: ['Staff'],
        summary: 'List staff with competencies and shifts',
        description:
          'An empty `serviceIds` means the staff member can perform every service; an empty ' +
          '`workingHours` means they work the salon\'s full opening hours.',
        response: { 200: jsonSchema(z.object({ data: z.array(StaffMemberSchema) })), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const rows = await catalogRepo.listStaff(request.principal.salonId);
      return { data: rows.map(serializeStaff) };
    },
  );

  app.post(
    '/v1/staff',
    {
      preHandler: app.requireScope('staff:write'),
      schema: {
        tags: ['Staff'],
        summary: 'Add a staff member',
        body: jsonSchema(CreateStaffSchema),
        response: { 201: jsonSchema(StaffMemberSchema), ...COMMON_ERRORS },
      },
    },
    async (request, reply) => {
      const body = parseOrThrow(CreateStaffSchema, request.body, 'body');
      const record = await catalogRepo.createStaff(request.principal.salonId, {
        name: body.name,
        role: body.role ?? null,
        active: body.active,
        serviceIds: body.serviceIds,
        workingHours: body.workingHours,
      });
      reply.status(201);
      return serializeStaff(record);
    },
  );

  app.patch(
    '/v1/staff/:id',
    {
      preHandler: app.requireScope('staff:write'),
      schema: {
        tags: ['Staff'],
        summary: 'Update a staff member',
        body: jsonSchema(UpdateStaffSchema),
        response: { 200: jsonSchema(StaffMemberSchema), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parseOrThrow(UpdateStaffSchema, request.body, 'body');
      const record = await catalogRepo.updateStaff(request.principal.salonId, id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.role !== undefined ? { role: body.role ?? null } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(body.serviceIds !== undefined ? { serviceIds: body.serviceIds } : {}),
        ...(body.workingHours !== undefined ? { workingHours: body.workingHours } : {}),
      });
      if (!record) throw new ApiError('STAFF_NOT_FOUND', 'That staff member does not exist.', { staffId: id });
      return serializeStaff(record);
    },
  );
};
