import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  ApiError,
  CallLogSchema,
  CallSummarySchema,
  CreateCallSummarySchema,
  EndCallSchema,
  ListCallSummariesQuerySchema,
  UpdateCallSchema,
  StartCallSchema,
  paginatedSchema,
} from '@salon/contracts';
import { callingCodeFromSalonPhone, normalizePhone } from '@salon/core';
import { parseOrThrow } from '../lib/errors.js';
import { jsonSchema, COMMON_ERRORS } from '../lib/openapi.js';
import * as callRepo from '../repositories/callRepo.js';
import * as salonRepo from '../repositories/salonRepo.js';
import type { CallSummaryDetail } from '../repositories/callRepo.js';

function serializeSummary(detail: CallSummaryDetail, includeTranscript: boolean) {
  const { summary: s, call } = detail;
  const durationSeconds = call.endedAt
    ? Math.round((call.endedAt.getTime() - call.startedAt.getTime()) / 1000)
    : null;

  return {
    id: s.id,
    callId: s.callId,
    customerId: s.customerId,
    customerName: detail.customerName,
    callerPhone: s.callerPhone,
    intents: s.intents,
    servicesDiscussed: s.servicesDiscussed,
    appointmentAction: s.appointmentAction,
    actionResult: s.actionResult,
    failureReason: s.failureReason,
    appointmentId: s.appointmentId,
    summary: s.summary,
    keyEntities: s.keyEntities,
    events: s.events,
    escalated: s.escalated,
    escalationReason: s.escalationReason,
    callbackRequest: s.callbackRequest,
    createdAt: s.createdAt.toISOString(),
    call: {
      startedAt: call.startedAt.toISOString(),
      endedAt: call.endedAt?.toISOString() ?? null,
      transport: call.transport,
      status: call.status,
      durationSeconds,
      // Transcripts are the largest field and often unnecessary; the list view
      // omits them and the detail view asks for them explicitly.
      ...(includeTranscript ? { transcript: call.transcript } : {}),
    },
  };
}

export const callRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/calls',
    {
      preHandler: app.requireScope('calls:write'),
      schema: {
        tags: ['Calls'],
        summary: 'Open a call log',
        description:
          'Called by the voice agent when a call connects. The returned id is the correlation ' +
          'key for the rest of the call: it is sent as `X-Call-Id` on every subsequent request, ' +
          'so one identifier reconstructs the whole trace from agent turn to database write.',
        body: jsonSchema(StartCallSchema),
        response: { 201: jsonSchema(CallLogSchema), ...COMMON_ERRORS },
      },
    },
    async (request, reply) => {
      const body = parseOrThrow(StartCallSchema, request.body ?? {}, 'body');
      const salonId = request.principal.salonId;
      const salon = await salonRepo.getSalon(salonId);

      const phone = body.callerPhone
        ? normalizePhone(body.callerPhone, { defaultCallingCode: callingCodeFromSalonPhone(salon?.phone) })
        : null;

      const row = await callRepo.startCall(salonId, { callerPhone: phone, transport: body.transport });
      reply.status(201);
      return {
        id: row.id,
        callerPhone: row.callerPhone,
        startedAt: row.startedAt.toISOString(),
        endedAt: null,
        transport: row.transport,
        status: row.status,
        transcript: [],
        recordingRef: null,
      };
    },
  );

  app.patch(
    '/v1/calls/:id',
    {
      preHandler: app.requireScope('calls:write'),
      schema: {
        tags: ['Calls'],
        summary: 'Update a call that is still in progress',
        description:
          'Stores the transcript so far without ending the call. Called after every turn, so a ' +
          'call that is never cleanly hung up — the caller closes the tab, the line drops, a ' +
          'worker restarts — still leaves a full record rather than an empty row.',
        body: jsonSchema(UpdateCallSchema),
        response: { 200: jsonSchema(CallLogSchema), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parseOrThrow(UpdateCallSchema, request.body ?? {}, 'body');
      const row = await callRepo.updateCallTranscript(request.principal.salonId, id, body.transcript);
      if (!row) throw new ApiError('CALL_NOT_FOUND', 'That call does not exist.', { callId: id });
      return {
        id: row.id,
        callerPhone: row.callerPhone,
        startedAt: row.startedAt.toISOString(),
        endedAt: row.endedAt?.toISOString() ?? null,
        transport: row.transport,
        status: row.status,
        transcript: row.transcript,
        recordingRef: row.recordingRef,
      };
    },
  );

  app.post(
    '/v1/calls/:id/end',
    {
      preHandler: app.requireScope('calls:write'),
      schema: {
        tags: ['Calls'],
        summary: 'Close a call log and store its transcript',
        body: jsonSchema(EndCallSchema),
        response: { 200: jsonSchema(CallLogSchema), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parseOrThrow(EndCallSchema, request.body ?? {}, 'body');
      const row = await callRepo.endCall(request.principal.salonId, id, {
        status: body.status,
        transcript: body.transcript,
        recordingRef: body.recordingRef ?? null,
      });
      if (!row) throw new ApiError('CALL_NOT_FOUND', 'That call does not exist.', { callId: id });
      return {
        id: row.id,
        callerPhone: row.callerPhone,
        startedAt: row.startedAt.toISOString(),
        endedAt: row.endedAt?.toISOString() ?? null,
        transport: row.transport,
        status: row.status,
        transcript: row.transcript,
        recordingRef: row.recordingRef,
      };
    },
  );

  app.post(
    '/v1/call-summaries',
    {
      preHandler: app.requireScope('calls:write'),
      schema: {
        tags: ['Calls'],
        summary: 'Save the structured outcome of a call',
        description:
          'Written for **every** call, successful or not — the agent does this in a `finally` ' +
          'block, because the calls most worth reviewing are the ones that went wrong.\n\n' +
          'Upserts on `callId`, so a duplicate write during shutdown updates the record rather ' +
          'than failing and losing it.',
        body: jsonSchema(CreateCallSummarySchema),
        response: { 201: jsonSchema(CallSummarySchema), ...COMMON_ERRORS },
      },
    },
    async (request, reply) => {
      const body = parseOrThrow(CreateCallSummarySchema, request.body, 'body');
      const salonId = request.principal.salonId;

      const call = await callRepo.getCall(salonId, body.callId);
      if (!call) throw new ApiError('CALL_NOT_FOUND', 'That call does not exist.', { callId: body.callId });

      const salon = await salonRepo.getSalon(salonId);
      const phone = body.callerPhone
        ? normalizePhone(body.callerPhone, { defaultCallingCode: callingCodeFromSalonPhone(salon?.phone) })
        : call.callerPhone;

      await callRepo.saveCallSummary(salonId, {
        callId: body.callId,
        customerId: body.customerId ?? null,
        callerPhone: phone,
        intents: body.intents,
        servicesDiscussed: body.servicesDiscussed,
        appointmentAction: body.appointmentAction,
        actionResult: body.actionResult,
        failureReason: body.failureReason ?? null,
        appointmentId: body.appointmentId ?? null,
        summary: body.summary,
        keyEntities: body.keyEntities,
        events: body.events,
        escalated: body.escalated,
        escalationReason: body.escalationReason ?? null,
        callbackRequest: body.callbackRequest ?? null,
      });

      const saved = await callRepo.getCallSummary(salonId, body.callId);
      reply.status(201);
      return serializeSummary(saved!, false);
    },
  );

  app.get(
    '/v1/call-summaries',
    {
      preHandler: app.requireScope('calls:read'),
      schema: {
        tags: ['Calls'],
        summary: 'Review past calls',
        description:
          'Backs the CRM call-review screen. Filter by `escalated=true` to see only the calls ' +
          'the agent could not resolve — the queue a salon manager actually works through.',
        querystring: jsonSchema(ListCallSummariesQuerySchema),
        response: { 200: jsonSchema(paginatedSchema(CallSummarySchema)), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const query = parseOrThrow(ListCallSummariesQuerySchema, request.query, 'query');
      const { rows, total } = await callRepo.listCallSummaries(request.principal.salonId, {
        escalated: query.escalated,
        actionResult: query.actionResult,
        appointmentAction: query.appointmentAction,
        intent: query.intent,
        customerId: query.customerId,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        search: query.search,
        limit: query.limit,
        offset: query.offset,
      });

      return {
        data: rows.map((row) => serializeSummary(row, query.includeTranscript)),
        pagination: {
          limit: query.limit,
          offset: query.offset,
          total,
          hasMore: query.offset + rows.length < total,
        },
      };
    },
  );

  app.get(
    '/v1/call-summaries/:callId',
    {
      preHandler: app.requireScope('calls:read'),
      schema: {
        tags: ['Calls'],
        summary: 'Get one call summary, including its transcript',
        response: { 200: jsonSchema(CallSummarySchema), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const { callId } = request.params as { callId: string };
      const detail = await callRepo.getCallSummary(request.principal.salonId, callId);
      if (!detail) {
        throw new ApiError('CALL_NOT_FOUND', 'No summary exists for that call.', { callId });
      }
      return serializeSummary(detail, true);
    },
  );
};

export const _callSchemas = { z };
