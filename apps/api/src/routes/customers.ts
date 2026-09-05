import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  ApiError,
  CreateCustomerSchema,
  CustomerSchema,
  CustomerSummarySchema,
  PaginationQuerySchema,
  SearchCustomersQuerySchema,
  UpdateCustomerSchema,
  paginatedSchema,
} from '@salon/contracts';
import { callingCodeFromSalonPhone, normalizePhone } from '@salon/core';
import { parseOrThrow } from '../lib/errors.js';
import { jsonSchema, COMMON_ERRORS } from '../lib/openapi.js';
import * as customerRepo from '../repositories/customerRepo.js';
import * as salonRepo from '../repositories/salonRepo.js';
import { canReadFullCustomer, projectCustomer } from '../serializers/customer.js';

/** Normalise a phone number using the salon's own country as the default. */
async function normalizeForSalon(salonId: string, raw: string): Promise<string> {
  const salon = await salonRepo.getSalon(salonId);
  const phone = normalizePhone(raw, { defaultCallingCode: callingCodeFromSalonPhone(salon?.phone) });
  if (!phone) {
    throw new ApiError('VALIDATION_FAILED', 'That phone number could not be understood.', {
      source: 'body',
      fields: [{ path: 'phone', message: 'must be a valid phone number' }],
    });
  }
  return phone;
}

export const customerRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/customers',
    {
      preHandler: app.requireScope('customers:read'),
      schema: {
        tags: ['Customers'],
        summary: 'List customers',
        description:
          'Credentials without `customers:read:full` (the voice agent) receive a reduced record: ' +
          'first name and phone only, with surname, email and staff notes withheld.',
        querystring: jsonSchema(PaginationQuerySchema),
        response: { 200: jsonSchema(paginatedSchema(CustomerSchema.or(CustomerSummarySchema))), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const { limit, offset } = parseOrThrow(PaginationQuerySchema, request.query, 'query');
      const { rows, total } = await customerRepo.listCustomers(request.principal.salonId, limit, offset);
      return {
        data: rows.map((row) => projectCustomer(row, request.principal)),
        pagination: { limit, offset, total, hasMore: offset + rows.length < total },
      };
    },
  );

  app.get(
    '/v1/customers/search',
    {
      preHandler: app.requireScope('customers:read'),
      schema: {
        tags: ['Customers'],
        summary: 'Search customers by phone, name or email',
        description:
          'The voice agent\'s first call on most conversations: look the caller up by the number ' +
          'they are calling from. A phone search also matches on the trailing digits, because ' +
          'callers read out the last six far more often than a full international number.',
        querystring: jsonSchema(SearchCustomersQuerySchema),
        response: { 200: jsonSchema(paginatedSchema(CustomerSchema.or(CustomerSummarySchema))), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const query = parseOrThrow(SearchCustomersQuerySchema, request.query, 'query');
      const salonId = request.principal.salonId;

      let phone = query.phone;
      if (phone) {
        const salon = await salonRepo.getSalon(salonId);
        phone = normalizePhone(phone, { defaultCallingCode: callingCodeFromSalonPhone(salon?.phone) }) ?? phone;
      }

      const { rows, total } = await customerRepo.searchCustomers(salonId, {
        phone,
        name: query.name,
        email: query.email,
        limit: query.limit,
        offset: query.offset,
      });

      return {
        data: rows.map((row) => projectCustomer(row, request.principal)),
        pagination: { limit: query.limit, offset: query.offset, total, hasMore: query.offset + rows.length < total },
      };
    },
  );

  app.get(
    '/v1/customers/:id',
    {
      preHandler: app.requireScope('customers:read'),
      schema: {
        tags: ['Customers'],
        summary: 'Get one customer',
        response: { 200: jsonSchema(CustomerSchema.or(CustomerSummarySchema)), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const row = await customerRepo.getCustomer(request.principal.salonId, id);
      if (!row) throw new ApiError('CUSTOMER_NOT_FOUND', 'That customer does not exist.', { customerId: id });
      return projectCustomer(row, request.principal);
    },
  );

  app.post(
    '/v1/customers',
    {
      preHandler: app.requireScope('customers:write'),
      schema: {
        tags: ['Customers'],
        summary: 'Create a customer',
        description:
          'Phone numbers are normalised to E.164 before storage, so "07700 900123" and ' +
          '"+44 7700 900123" cannot become two records for the same person.',
        body: jsonSchema(CreateCustomerSchema),
        response: {
          201: jsonSchema(CustomerSchema.or(CustomerSummarySchema)),
          409: { description: 'DUPLICATE_CUSTOMER_PHONE' },
          ...COMMON_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const body = parseOrThrow(CreateCustomerSchema, request.body, 'body');
      const salonId = request.principal.salonId;
      const phone = await normalizeForSalon(salonId, body.phone);

      const row = await customerRepo.createCustomer(salonId, {
        firstName: body.firstName,
        lastName: body.lastName ?? null,
        phone,
        email: body.email ?? null,
        // Only a credential that may read notes may write them.
        notes: canReadFullCustomer(request.principal) ? (body.notes ?? null) : null,
      });
      reply.status(201);
      return projectCustomer(row, request.principal, false);
    },
  );

  app.patch(
    '/v1/customers/:id',
    {
      preHandler: app.requireScope('customers:write'),
      schema: {
        tags: ['Customers'],
        summary: 'Update a customer',
        body: jsonSchema(UpdateCustomerSchema),
        response: { 200: jsonSchema(CustomerSchema.or(CustomerSummarySchema)), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parseOrThrow(UpdateCustomerSchema, request.body, 'body');
      const salonId = request.principal.salonId;

      const patch: Record<string, unknown> = {};
      if (body.firstName !== undefined) patch.firstName = body.firstName;
      if (body.lastName !== undefined) patch.lastName = body.lastName ?? null;
      if (body.email !== undefined) patch.email = body.email ?? null;
      if (body.phone !== undefined) patch.phone = await normalizeForSalon(salonId, body.phone);
      if (body.notes !== undefined) {
        if (!canReadFullCustomer(request.principal)) {
          throw new ApiError('FORBIDDEN_SCOPE', 'This credential cannot edit customer notes.', {
            required: ['customers:read:full'],
          });
        }
        patch.notes = body.notes ?? null;
      }

      const row = await customerRepo.updateCustomer(salonId, id, patch);
      if (!row) throw new ApiError('CUSTOMER_NOT_FOUND', 'That customer does not exist.', { customerId: id });
      return projectCustomer(row, request.principal);
    },
  );
};

export const _customerSchemas = { z };
