import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import { ApiErrorSchema, type ErrorCode } from '@salon/contracts';

/**
 * Zod schemas are the single source of truth for the API contract; this turns
 * them into the JSON Schema that @fastify/swagger publishes.
 *
 * Validation itself is done by Zod in the handlers, not by Fastify's ajv — one
 * validator, one set of error messages, no chance of the published spec and the
 * enforced contract drifting apart.
 */
export function jsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema, { $refStrategy: 'none', target: 'openApi3' }) as Record<string, unknown>;
}

const errorSchema = jsonSchema(ApiErrorSchema);

/** Document the error responses a route can produce, by code. */
export function errorResponses(...codes: Array<[number, ErrorCode[] | string]>) {
  const responses: Record<number, unknown> = {};
  for (const [status, codesOrDescription] of codes) {
    responses[status] = {
      description: Array.isArray(codesOrDescription)
        ? `Error codes: ${codesOrDescription.join(', ')}`
        : codesOrDescription,
      ...errorSchema,
    };
  }
  return responses;
}

export const COMMON_ERRORS = errorResponses(
  [400, ['VALIDATION_FAILED', 'IDEMPOTENCY_KEY_REQUIRED']],
  [401, ['UNAUTHENTICATED']],
  [403, ['FORBIDDEN_SCOPE']],
  [429, ['RATE_LIMITED']],
  [500, ['INTERNAL_ERROR']],
);
