import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ApiError } from '@salon/contracts';
import { parseOrThrow } from '../lib/errors.js';
import { jsonSchema, COMMON_ERRORS } from '../lib/openapi.js';
import { principalForKey, SESSION_COOKIE, sessionTtlSeconds } from '../plugins/auth.js';
import * as salonRepo from '../repositories/salonRepo.js';
import { config } from '../config.js';

const LoginSchema = z.object({ apiKey: z.string().min(8).max(200) });

const SessionSchema = z.object({
  salon: z.object({ id: z.string(), name: z.string(), timezone: z.string() }),
  credential: z.object({ name: z.string(), kind: z.string(), scopes: z.array(z.string()) }),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/auth/session',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Exchange a staff API key for a session cookie',
        description:
          'Used by the staff UI. The raw key is traded for a signed, httpOnly cookie so a ' +
          'long-lived credential never sits in browser storage where any script on the page ' +
          'could read it. The key row is re-checked on every request, so revoking a key ends ' +
          'live sessions immediately rather than when the cookie expires.',
        body: jsonSchema(LoginSchema),
        response: { 200: jsonSchema(SessionSchema), ...COMMON_ERRORS },
      },
    },
    async (request, reply) => {
      const { apiKey } = parseOrThrow(LoginSchema, request.body, 'body');
      const principal = await principalForKey(apiKey);
      if (!principal) throw new ApiError('UNAUTHENTICATED', 'That API key is not valid.');

      reply.setCookie(SESSION_COOKIE, principal.keyId, {
        signed: true,
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProduction,
        path: '/',
        maxAge: sessionTtlSeconds,
      });

      const salon = await salonRepo.getSalon(principal.salonId);
      return {
        salon: { id: salon!.id, name: salon!.name, timezone: salon!.timezone },
        credential: { name: principal.name, kind: principal.kind, scopes: principal.scopes },
      };
    },
  );

  app.get(
    '/v1/auth/me',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Describe the current credential',
        response: { 200: jsonSchema(SessionSchema), ...COMMON_ERRORS },
      },
    },
    async (request) => {
      const salon = await salonRepo.getSalon(request.principal.salonId);
      if (!salon) throw new ApiError('NOT_FOUND', 'Salon not found.');
      return {
        salon: { id: salon.id, name: salon.name, timezone: salon.timezone },
        credential: {
          name: request.principal.name,
          kind: request.principal.kind,
          scopes: request.principal.scopes,
        },
      };
    },
  );

  app.post(
    '/v1/auth/logout',
    { schema: { tags: ['Auth'], summary: 'Clear the session cookie', response: { 204: { description: 'Signed out' } } } },
    async (_request, reply) => {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      reply.status(204);
      return null;
    },
  );
};
