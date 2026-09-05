import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';
import { config } from '../config.js';

/**
 * Structured logging with correlation and redaction.
 *
 * Two properties matter here:
 *
 *  1. One `callId` reconstructs an entire call — agent turns, the API requests
 *     they caused, and the database writes underneath — because the agent
 *     forwards its call id as a header and it is bound into the async context
 *     for the lifetime of the request.
 *
 *  2. No personal data reaches the logs. Phone numbers, emails and staff notes
 *     are redacted by path, and code logs identifiers (customerId, callId)
 *     rather than the values behind them. A log aggregator is a place PII goes
 *     to be forgotten about, so it does not go there.
 */

export interface RequestContext {
  requestId: string;
  callId?: string | undefined;
  salonId?: string | undefined;
  principal?: string | undefined;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
  '*.phone',
  '*.callerPhone',
  '*.email',
  '*.notes',
  '*.customer.phone',
  '*.customer.email',
  '*.transcript',
  '*.apiKey',
  '*.key',
];

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  base: { service: 'crm-api' },
  formatters: {
    level: (label) => ({ level: label }),
    // Correlation identifiers are attached to every line automatically rather
    // than being remembered at each call site.
    bindings: (bindings) => ({ pid: bindings.pid }),
  },
  mixin() {
    const ctx = storage.getStore();
    return ctx
      ? {
          requestId: ctx.requestId,
          ...(ctx.callId ? { callId: ctx.callId } : {}),
          ...(ctx.salonId ? { salonId: ctx.salonId } : {}),
          ...(ctx.principal ? { principal: ctx.principal } : {}),
        }
      : {};
  },
  transport:
    config.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,service' } }
      : undefined,
});
