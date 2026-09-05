import { z } from 'zod';
import { CurrencySchema, MoneyInputSchema, MoneySchema, UuidSchema } from './common.js';

export const ServiceSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  category: z.string(),
  durationMinutes: z.number().int().positive(),
  bufferBeforeMinutes: z.number().int().min(0),
  bufferAfterMinutes: z.number().int().min(0),
  price: MoneySchema,
  currency: CurrencySchema,
  active: z.boolean(),
});
export type Service = z.infer<typeof ServiceSchema>;

export const CreateServiceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullish(),
  category: z.string().trim().min(1).max(60).default('general'),
  durationMinutes: z.number().int().positive().max(600),
  bufferBeforeMinutes: z.number().int().min(0).max(120).default(0),
  bufferAfterMinutes: z.number().int().min(0).max(120).default(0),
  price: MoneyInputSchema,
  active: z.boolean().default(true),
});
export type CreateServiceInput = z.infer<typeof CreateServiceSchema>;

export const UpdateServiceSchema = CreateServiceSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'no fields to update' },
);

export const ListServicesQuerySchema = z.object({
  category: z.string().trim().min(1).max(60).optional(),
  active: z
    .enum(['true', 'false', 'all'])
    .default('true')
    .describe('Defaults to "true" — callers asking "what do you offer" must not hear retired services'),
  search: z.string().trim().min(1).max(120).optional(),
});
