import { z } from 'zod';
import { IsoDateTimeSchema, PaginationQuerySchema, PhoneInputSchema, UuidSchema } from './common.js';

export const CALL_TRANSPORTS = ['browser', 'twilio', 'test'] as const;
export const CALL_STATUSES = ['in_progress', 'completed', 'failed'] as const;

export const TranscriptTurnSchema = z.object({
  role: z.enum(['caller', 'agent', 'system']),
  text: z.string(),
  at: IsoDateTimeSchema,
});
export type TranscriptTurn = z.infer<typeof TranscriptTurnSchema>;

export const CallLogSchema = z.object({
  id: UuidSchema,
  callerPhone: z.string().nullable(),
  startedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema.nullable(),
  transport: z.enum(CALL_TRANSPORTS),
  status: z.enum(CALL_STATUSES),
  transcript: z.array(TranscriptTurnSchema),
  recordingRef: z.string().nullable(),
});
export type CallLog = z.infer<typeof CallLogSchema>;

export const StartCallSchema = z.object({
  callerPhone: PhoneInputSchema.nullish(),
  transport: z.enum(CALL_TRANSPORTS).default('browser'),
});

/**
 * Progress update for a call still in flight.
 *
 * A call is only useful to a salon while it can still be acted on, and a call
 * that is never cleanly hung up — the browser closed, the line dropped, the
 * worker restarted — used to leave nothing behind but an empty row.
 */
export const UpdateCallSchema = z.object({
  transcript: z.array(TranscriptTurnSchema).default([]),
});

export const EndCallSchema = z.object({
  status: z.enum(['completed', 'failed']).default('completed'),
  transcript: z.array(TranscriptTurnSchema).default([]),
  recordingRef: z.string().max(500).nullish(),
});

// ── call summary ──────────────────────────────────────────────────────────────
export const CALL_INTENTS = [
  'faq',
  'hours',
  'pricing',
  'services',
  'policy',
  'lookup',
  'availability',
  'booking',
  'cancellation',
  'reschedule',
  'callback',
  'complaint',
  'out_of_scope',
  'unknown',
] as const;
export const CallIntentSchema = z.enum(CALL_INTENTS);
export type CallIntent = z.infer<typeof CallIntentSchema>;

export const APPOINTMENT_ACTIONS = ['book', 'cancel', 'reschedule', 'lookup', 'none'] as const;
export const ACTION_RESULTS = ['success', 'failed', 'not_attempted'] as const;

/**
 * One structured event per meaningful thing that happened in the call.
 * This is the audit trail that lets a supervisor reconstruct why the agent
 * said what it said, without reading a raw transcript.
 */
export const CallEventSchema = z.object({
  at: IsoDateTimeSchema,
  type: z.enum([
    'call_started',
    'intent_detected',
    'state_changed',
    'tool_call',
    'confirmation_requested',
    'confirmation_received',
    'api_error',
    'retry',
    'guard_tripped',
    'escalated',
    'call_ended',
  ]),
  detail: z.record(z.unknown()),
  /** Present on tool_call events. */
  latencyMs: z.number().int().nonnegative().optional(),
  outcome: z.enum(['success', 'error']).optional(),
});
export type CallEvent = z.infer<typeof CallEventSchema>;

export const CallbackRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: PhoneInputSchema,
  reason: z.string().trim().min(1).max(1000),
  preferredTime: z.string().trim().max(200).nullish(),
});
export type CallbackRequest = z.infer<typeof CallbackRequestSchema>;

export const CreateCallSummarySchema = z
  .object({
    callId: UuidSchema,
    customerId: UuidSchema.nullish(),
    callerPhone: PhoneInputSchema.nullish(),
    intents: z.array(CallIntentSchema).default([]),
    servicesDiscussed: z.array(z.string().max(120)).default([]),
    appointmentAction: z.enum(APPOINTMENT_ACTIONS).default('none'),
    actionResult: z.enum(ACTION_RESULTS).default('not_attempted'),
    failureReason: z.string().trim().max(500).nullish(),
    appointmentId: UuidSchema.nullish(),
    summary: z.string().trim().max(4000).default(''),
    keyEntities: z.record(z.unknown()).default({}),
    events: z.array(CallEventSchema).default([]),
    escalated: z.boolean().default(false),
    escalationReason: z.string().trim().max(500).nullish(),
    callbackRequest: CallbackRequestSchema.nullish(),
  })
  // Mirrors the database CHECK constraints, so a bad payload is rejected with a
  // field-level validation error instead of a raw constraint violation.
  .refine((v) => v.actionResult !== 'failed' || Boolean(v.failureReason), {
    message: 'failureReason is required when actionResult is "failed"',
    path: ['failureReason'],
  })
  .refine((v) => !v.escalated || Boolean(v.escalationReason), {
    message: 'escalationReason is required when escalated is true',
    path: ['escalationReason'],
  });
export type CreateCallSummaryInput = z.infer<typeof CreateCallSummarySchema>;

export const CallSummarySchema = z.object({
  id: UuidSchema,
  callId: UuidSchema,
  customerId: UuidSchema.nullable(),
  customerName: z.string().nullable(),
  callerPhone: z.string().nullable(),
  intents: z.array(z.string()),
  servicesDiscussed: z.array(z.string()),
  appointmentAction: z.enum(APPOINTMENT_ACTIONS),
  actionResult: z.enum(ACTION_RESULTS),
  failureReason: z.string().nullable(),
  appointmentId: UuidSchema.nullable(),
  summary: z.string(),
  keyEntities: z.record(z.unknown()),
  events: z.array(CallEventSchema),
  escalated: z.boolean(),
  escalationReason: z.string().nullable(),
  callbackRequest: CallbackRequestSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  call: CallLogSchema.pick({
    startedAt: true,
    endedAt: true,
    transport: true,
    status: true,
  }).extend({ durationSeconds: z.number().int().nullable() }),
});
export type CallSummary = z.infer<typeof CallSummarySchema>;

export const ListCallSummariesQuerySchema = PaginationQuerySchema.extend({
  escalated: z.coerce.boolean().optional(),
  actionResult: z.enum(ACTION_RESULTS).optional(),
  appointmentAction: z.enum(APPOINTMENT_ACTIONS).optional(),
  intent: CallIntentSchema.optional(),
  customerId: UuidSchema.optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
  /** Free-text over the summary body. */
  search: z.string().trim().min(1).max(200).optional(),
  includeTranscript: z.coerce.boolean().default(false),
});
