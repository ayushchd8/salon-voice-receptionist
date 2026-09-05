import { z } from 'zod';
import { EmailSchema, PaginationQuerySchema, PhoneInputSchema, PhoneSchema, UuidSchema } from './common.js';

/**
 * Full customer record. Returned only to principals holding
 * `customers:read:full` — i.e. staff.
 */
export const CustomerSchema = z.object({
  id: UuidSchema,
  firstName: z.string(),
  lastName: z.string().nullable(),
  phone: PhoneSchema,
  email: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Customer = z.infer<typeof CustomerSchema>;

/**
 * What the voice agent sees.
 *
 * Surname, email and staff notes are dropped by the serializer before the
 * response is built, so the agent is structurally incapable of reciting a
 * customer's private notes over the phone — it never receives them. This is a
 * projection enforced in code, not an instruction in a prompt.
 */
export const CustomerSummarySchema = z.object({
  id: UuidSchema,
  firstName: z.string(),
  phone: PhoneSchema,
  isReturning: z.boolean(),
});
export type CustomerSummary = z.infer<typeof CustomerSummarySchema>;

export const CreateCustomerSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).nullish(),
  phone: PhoneInputSchema,
  email: EmailSchema.nullish(),
  notes: z.string().trim().max(2000).nullish(),
});
export type CreateCustomerInput = z.infer<typeof CreateCustomerSchema>;

export const UpdateCustomerSchema = CreateCustomerSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'no fields to update' },
);

export const SearchCustomersQuerySchema = PaginationQuerySchema.extend({
  phone: PhoneInputSchema.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().min(1).max(254).optional(),
}).refine((q) => q.phone || q.name || q.email, {
  message: 'provide at least one of phone, name or email',
});
