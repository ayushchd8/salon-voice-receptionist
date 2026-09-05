import { z } from 'zod';
import { IanaTimezoneSchema, IsoDateTimeSchema, UuidSchema } from './common.js';

export const SlotSchema = z.object({
  start: IsoDateTimeSchema,
  end: IsoDateTimeSchema,
  staffId: UuidSchema,
  staffName: z.string(),
  /** Salon-local rendering, so the agent never does timezone maths itself. */
  localDate: z.string(),
  localTime: z.string(),
  label: z.string().describe('Speakable form, e.g. "Friday 3 October at 2:30pm"'),
});
export type Slot = z.infer<typeof SlotSchema>;

export const GetAvailabilityQuerySchema = z
  .object({
    serviceId: UuidSchema,
    staffId: UuidSchema.optional(),
    from: IsoDateTimeSchema.optional(),
    to: IsoDateTimeSchema.optional(),
    /**
     * Natural-language window, resolved server-side by the same deterministic
     * resolver the voice agent uses ("next friday afternoon", "after 3 on
     * tuesday"). Callers may send this instead of from/to; an LLM should never
     * be doing date arithmetic itself.
     */
    timeExpression: z.string().trim().min(2).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    /** When the requested window has nothing free, also return nearby options. */
    includeAlternatives: z.coerce.boolean().default(true),
  })
  .refine((q) => q.timeExpression !== undefined || (q.from !== undefined && q.to !== undefined), {
    message: 'provide either timeExpression, or both from and to',
  })
  .refine((q) => !q.from || !q.to || q.from < q.to, { message: 'from must be before to' });
export type GetAvailabilityQuery = z.infer<typeof GetAvailabilityQuerySchema>;

export const AvailabilityResponseSchema = z.object({
  timezone: IanaTimezoneSchema,
  service: z.object({
    id: UuidSchema,
    name: z.string(),
    durationMinutes: z.number().int(),
  }),
  requestedWindow: z.object({
    from: IsoDateTimeSchema,
    to: IsoDateTimeSchema,
    /** How a natural-language expression was understood, for read-back. */
    interpretation: z.string().nullable(),
  }),
  slots: z.array(SlotSchema),
  /**
   * Nearest bookable slots outside the requested window. Populated when
   * `slots` is empty so "we're full then" is never a dead end for the caller.
   */
  alternatives: z.array(SlotSchema),
  /** Why the window yielded nothing, when it yielded nothing. */
  unavailableReason: z.string().nullable(),
});
export type AvailabilityResponse = z.infer<typeof AvailabilityResponseSchema>;

/** Standalone deterministic time-phrase resolution, exposed as a tool. */
export const ResolveTimeQuerySchema = z.object({
  expression: z.string().trim().min(2).max(200),
  /** Reference instant; defaults to now. Present so tests are deterministic. */
  now: IsoDateTimeSchema.optional(),
});

export const ResolveTimeResponseSchema = z.object({
  expression: z.string(),
  from: IsoDateTimeSchema,
  to: IsoDateTimeSchema,
  interpretation: z.string(),
  timezone: IanaTimezoneSchema,
  /** True when the phrase named a broad window (e.g. "next week") rather than a time. */
  isBroad: z.boolean(),
});
