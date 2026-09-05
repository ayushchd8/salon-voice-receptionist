import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { ApiError } from '@salon/contracts';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { translateDatabaseError } from './lib/errors.js';
import { contextPlugin } from './plugins/context.js';
import { authPlugin } from './plugins/auth.js';
import { registerRoutes } from './routes/index.js';

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true,
    bodyLimit: 1_048_576,
    ajv: { customOptions: { removeAdditional: false } },
  });

  // Zod validates in the handlers, so Fastify's own validation and response
  // serialisation are turned off and route `schema` blocks exist purely as the
  // source for the published OpenAPI document.
  //
  // The validator must hand the payload back untouched: Fastify *assigns* the
  // returned `value` onto request.body/query, so returning anything else
  // silently replaces the request with it.
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  // Likewise the serializer — the default fast-json-stringify would compile the
  // documentation schemas and strip anything they do not describe exactly.
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Call-Id', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Idempotent-Replay', 'Retry-After'],
  });

  await app.register(cookie, {
    secret: config.SESSION_SECRET,
    parseOptions: { httpOnly: true, sameSite: 'lax', path: '/', secure: config.isProduction },
  });

  // The hook point exists and is configured; tightening the numbers is a config
  // change rather than a code change. Keyed per credential, not per IP — every
  // call from the voice agent shares one source address.
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    keyGenerator: (request) => request.principal?.keyId ?? request.ip,
    errorResponseBuilder: (_request, context) => ({
      error: {
        code: 'RATE_LIMITED',
        message: `Rate limit exceeded. Retry in ${context.after}.`,
        details: { max: context.max, windowMs: context.ttl },
      },
    }),
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Salon CRM API',
        version: '1.0.0',
        description:
          'The only interface into the salon CRM. The voice agent and the staff UI are both ' +
          'clients of this API and hold no database access.\n\n' +
          '**Tenancy:** `salon_id` is never accepted from a request — it is derived from the ' +
          'authenticated credential.\n\n' +
          '**Errors:** every non-2xx response is `{ "error": { "code", "message", "details?", "requestId?" } }` ' +
          'where `code` is a closed enum, so clients branch on codes rather than parsing prose.\n\n' +
          '**Idempotency:** the three state-changing appointment endpoints require an ' +
          '`Idempotency-Key` header. A retry replays the original response instead of acting twice.',
      },
      servers: [{ url: `http://${config.API_HOST}:${config.API_PORT}` }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'An API key: `sk_agent_…` for the voice agent, `sk_staff_…` for staff.',
          },
          sessionCookie: { type: 'apiKey', in: 'cookie', name: 'salon_session' },
        },
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: 'Salon', description: 'Salon profile, opening hours and booking policy' },
        { name: 'Services', description: 'The service menu' },
        { name: 'Staff', description: 'Stylists, competencies and shifts' },
        { name: 'Customers', description: 'Customer records' },
        { name: 'Availability', description: 'Bookable slots' },
        { name: 'Appointments', description: 'Booking, cancellation and rescheduling' },
        { name: 'Calls', description: 'Call logs and structured call outcomes' },
        { name: 'Auth', description: 'Session exchange for the staff UI' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  // Registered *before* the route plugins. Fastify resolves a child context's
  // error handler at registration time, so installing this afterwards would
  // leave every /v1 route on the default handler — which serialises the raw
  // Error instance, and Error's own properties are not enumerable, so callers
  // would receive `{}` with a status code and nothing else.
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(
      new ApiError('NOT_FOUND', `No route for ${request.method} ${request.url}.`).toBody(request.requestId),
    );
  });

  /**
   * One error handler, one response shape.
   *
   * A validation failure or a lost booking race must never surface as a bare
   * 500 — the agent branches on `code`, so an untyped error is an error it
   * cannot recover from conversationally.
   */
  app.setErrorHandler((err, request, reply) => {
    const apiError =
      err instanceof ApiError
        ? err
        : translateDatabaseError(err) ??
          (hasStatus(err) && err.statusCode === 429
            ? new ApiError('RATE_LIMITED', 'Too many requests.')
            : null);

    if (apiError) {
      const level = apiError.status >= 500 ? 'error' : 'warn';
      request.log[level](
        { code: apiError.code, status: apiError.status, path: request.url },
        'request failed',
      );
      reply.status(apiError.status).send(apiError.toBody(request.requestId));
      return;
    }

    if (hasStatus(err) && err.statusCode && err.statusCode < 500) {
      request.log.warn({ err, path: request.url }, 'client error');
      reply
        .status(err.statusCode)
        .send(new ApiError('VALIDATION_FAILED', err.message).toBody(request.requestId));
      return;
    }

    // Genuinely unexpected: log the detail, tell the caller nothing that could
    // leak internals.
    request.log.error({ err, path: request.url }, 'unhandled error');
    reply
      .status(500)
      .send(
        new ApiError('INTERNAL_ERROR', 'Something went wrong handling that request.').toBody(
          request.requestId,
        ),
      );
  });


  await app.register(contextPlugin);
  await app.register(authPlugin);
  await app.register(registerRoutes);

  return app;
}

/** The concrete app type, inferred so the pino logger instance is preserved. */
export type App = Awaited<ReturnType<typeof buildApp>>;

function hasStatus(err: unknown): err is { statusCode?: number; message: string } {
  return typeof err === 'object' && err !== null && 'statusCode' in err;
}
