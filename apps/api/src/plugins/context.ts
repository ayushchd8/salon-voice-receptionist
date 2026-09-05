import { randomUUID } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { runWithContext } from '../lib/logger.js';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    callId: string | undefined;
  }
}

/**
 * Establishes the correlation context for every request.
 *
 * `X-Call-Id` is forwarded by the voice agent, which is what lets a single
 * call's full trace — agent turn, tool call, API request, database write — be
 * reconstructed from logs after the fact. `X-Request-Id` is honoured if a proxy
 * already assigned one, so the trace survives the hop.
 */
export const contextPlugin: FastifyPluginAsync = fp(async (app) => {
  app.decorateRequest('requestId', '');
  app.decorateRequest('callId', undefined);

  app.addHook('onRequest', (request, reply, done) => {
    const incoming = request.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && incoming.length <= 128 ? incoming : `req_${randomUUID()}`;
    const rawCallId = request.headers['x-call-id'];
    const callId = typeof rawCallId === 'string' && rawCallId.length <= 128 ? rawCallId : undefined;

    request.requestId = requestId;
    request.callId = callId;
    reply.header('X-Request-Id', requestId);

    // Everything downstream — including database calls — runs inside this
    // context, so log lines carry the identifiers without being passed them.
    runWithContext({ requestId, callId }, done);
  });
}, { name: 'context' });
