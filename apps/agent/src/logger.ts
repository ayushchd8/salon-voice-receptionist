import pino from 'pino';
import { config } from './config.js';
import { maskPhone } from '@salon/core';

/**
 * Agent-side logging, correlated with the CRM by `callId`.
 *
 * The agent forwards its call id as `X-Call-Id` on every CRM request, so one
 * identifier stitches together the caller's turns, the tool calls they caused,
 * the API requests those made, and the database writes underneath.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'voice-agent' },
  redact: {
    paths: ['*.phone', '*.callerPhone', '*.transcript', '*.text', '*.apiKey', 'req.headers.authorization'],
    censor: '[redacted]',
  },
  formatters: { level: (label) => ({ level: label }) },
  transport:
    config.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' } }
      : undefined,
});

/** A child logger bound to one call. */
export function callLogger(callId: string, callerPhone?: string | null) {
  return logger.child({ callId, caller: maskPhone(callerPhone) });
}
