import { z } from 'zod';
import { DayOfWeekSchema, LocalTimeSchema, UuidSchema } from './common.js';

export const StaffWorkingHoursSchema = z
  .object({
    dayOfWeek: DayOfWeekSchema,
    startTime: LocalTimeSchema,
    endTime: LocalTimeSchema,
  })
  .refine((d) => d.startTime < d.endTime, { message: 'startTime must be before endTime' });
export type StaffWorkingHours = z.infer<typeof StaffWorkingHoursSchema>;

export const StaffMemberSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  role: z.string().nullable(),
  isDefaultResource: z.boolean(),
  active: z.boolean(),
  /** Empty array means "can perform every service" — small salons never fill this in. */
  serviceIds: z.array(UuidSchema),
  /** Empty array means "works the salon's full opening hours". */
  workingHours: z.array(StaffWorkingHoursSchema),
});
export type StaffMember = z.infer<typeof StaffMemberSchema>;

export const CreateStaffSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().max(60).nullish(),
  active: z.boolean().default(true),
  serviceIds: z.array(UuidSchema).default([]),
  workingHours: z.array(StaffWorkingHoursSchema).max(7).default([]),
});

export const UpdateStaffSchema = CreateStaffSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'no fields to update' },
);
