import { and, asc, eq, ilike, inArray, sql } from 'drizzle-orm';
import type { ServiceDef, StaffDef } from '@salon/core';
import { db, type Executor } from '../db/index.js';
import { services, staffMembers, staffServices, staffWorkingHours } from '../db/schema.js';

// ── services ──────────────────────────────────────────────────────────────────

export async function listServices(
  salonId: string,
  filters: { category?: string | undefined; active?: 'true' | 'false' | 'all'; search?: string | undefined } = {},
  exec: Executor = db,
) {
  const conditions = [eq(services.salonId, salonId)];
  if (filters.category) conditions.push(eq(services.category, filters.category));
  if (filters.active === 'true') conditions.push(eq(services.active, true));
  if (filters.active === 'false') conditions.push(eq(services.active, false));
  if (filters.search) conditions.push(ilike(services.name, `%${filters.search}%`));

  return exec
    .select()
    .from(services)
    .where(and(...conditions))
    .orderBy(asc(services.category), asc(services.name));
}

export async function getService(salonId: string, serviceId: string, exec: Executor = db) {
  const [row] = await exec
    .select()
    .from(services)
    .where(and(eq(services.salonId, salonId), eq(services.id, serviceId)))
    .limit(1);
  return row ?? null;
}

export async function createService(salonId: string, input: Record<string, unknown>) {
  const [row] = await db.insert(services).values({ salonId, ...input } as never).returning();
  return row!;
}

export async function updateService(salonId: string, serviceId: string, patch: Record<string, unknown>) {
  const [row] = await db
    .update(services)
    .set(patch as never)
    .where(and(eq(services.salonId, salonId), eq(services.id, serviceId)))
    .returning();
  return row ?? null;
}

export function toServiceDef(row: typeof services.$inferSelect): ServiceDef {
  return {
    id: row.id,
    name: row.name,
    durationMinutes: row.durationMinutes,
    bufferBeforeMinutes: row.bufferBeforeMinutes,
    bufferAfterMinutes: row.bufferAfterMinutes,
    active: row.active,
  };
}

// ── staff ─────────────────────────────────────────────────────────────────────

export interface StaffRecord {
  id: string;
  name: string;
  role: string | null;
  isDefaultResource: boolean;
  active: boolean;
  serviceIds: string[];
  workingHours: Array<{ dayOfWeek: number; startTime: string; endTime: string }>;
}

/**
 * Load staff with their service competencies and shifts.
 *
 * Done as three queries plus an in-memory join rather than one query with two
 * lateral aggregates: a salon has a handful of staff, so the join is free, and
 * the resulting code is something a reviewer can check at a glance.
 */
export async function listStaff(
  salonId: string,
  options: { activeOnly?: boolean } = {},
  exec: Executor = db,
): Promise<StaffRecord[]> {
  const conditions = [eq(staffMembers.salonId, salonId)];
  if (options.activeOnly) conditions.push(eq(staffMembers.active, true));

  const members = await exec
    .select()
    .from(staffMembers)
    .where(and(...conditions))
    .orderBy(asc(staffMembers.name));
  if (members.length === 0) return [];

  const ids = members.map((m) => m.id);
  const [competencies, shifts] = await Promise.all([
    exec.select().from(staffServices).where(inArray(staffServices.staffId, ids)),
    exec.select().from(staffWorkingHours).where(inArray(staffWorkingHours.staffId, ids)),
  ]);

  const servicesByStaff = new Map<string, string[]>();
  for (const c of competencies) {
    const list = servicesByStaff.get(c.staffId);
    if (list) list.push(c.serviceId);
    else servicesByStaff.set(c.staffId, [c.serviceId]);
  }

  const hoursByStaff = new Map<string, StaffRecord['workingHours']>();
  for (const h of shifts) {
    const entry = { dayOfWeek: h.dayOfWeek, startTime: h.startTime, endTime: h.endTime };
    const list = hoursByStaff.get(h.staffId);
    if (list) list.push(entry);
    else hoursByStaff.set(h.staffId, [entry]);
  }

  return members.map((m) => ({
    id: m.id,
    name: m.name,
    role: m.role,
    isDefaultResource: m.isDefaultResource,
    active: m.active,
    serviceIds: servicesByStaff.get(m.id) ?? [],
    workingHours: (hoursByStaff.get(m.id) ?? []).sort((a, b) => a.dayOfWeek - b.dayOfWeek),
  }));
}

export async function getStaff(salonId: string, staffId: string, exec: Executor = db) {
  const all = await listStaff(salonId, {}, exec);
  return all.find((s) => s.id === staffId) ?? null;
}

export function toStaffDef(record: StaffRecord): StaffDef {
  return {
    id: record.id,
    name: record.name,
    active: record.active,
    serviceIds: record.serviceIds,
    workingHours: record.workingHours,
  };
}

export async function createStaff(
  salonId: string,
  input: { name: string; role?: string | null; active: boolean; serviceIds: string[]; workingHours: StaffRecord['workingHours'] },
) {
  return db.transaction(async (tx) => {
    const [member] = await tx
      .insert(staffMembers)
      .values({ salonId, name: input.name, role: input.role ?? null, active: input.active })
      .returning();
    await writeStaffRelations(tx, member!.id, input.serviceIds, input.workingHours);
    return (await listStaff(salonId, {}, tx)).find((s) => s.id === member!.id)!;
  });
}

export async function updateStaff(
  salonId: string,
  staffId: string,
  patch: {
    name?: string; role?: string | null; active?: boolean;
    serviceIds?: string[]; workingHours?: StaffRecord['workingHours'];
  },
) {
  return db.transaction(async (tx) => {
    const fields: Record<string, unknown> = {};
    if (patch.name !== undefined) fields.name = patch.name;
    if (patch.role !== undefined) fields.role = patch.role;
    if (patch.active !== undefined) fields.active = patch.active;

    if (Object.keys(fields).length > 0) {
      const updated = await tx
        .update(staffMembers)
        .set(fields as never)
        .where(and(eq(staffMembers.salonId, salonId), eq(staffMembers.id, staffId)))
        .returning({ id: staffMembers.id });
      if (updated.length === 0) return null;
    } else {
      const [exists] = await tx
        .select({ id: staffMembers.id })
        .from(staffMembers)
        .where(and(eq(staffMembers.salonId, salonId), eq(staffMembers.id, staffId)))
        .limit(1);
      if (!exists) return null;
    }

    if (patch.serviceIds !== undefined || patch.workingHours !== undefined) {
      await writeStaffRelations(tx, staffId, patch.serviceIds, patch.workingHours);
    }
    return (await listStaff(salonId, {}, tx)).find((s) => s.id === staffId) ?? null;
  });
}

async function writeStaffRelations(
  tx: Executor,
  staffId: string,
  serviceIds: string[] | undefined,
  workingHours: StaffRecord['workingHours'] | undefined,
) {
  if (serviceIds !== undefined) {
    await tx.delete(staffServices).where(eq(staffServices.staffId, staffId));
    if (serviceIds.length > 0) {
      await tx.insert(staffServices).values(serviceIds.map((serviceId) => ({ staffId, serviceId })));
    }
  }
  if (workingHours !== undefined) {
    await tx.delete(staffWorkingHours).where(eq(staffWorkingHours.staffId, staffId));
    if (workingHours.length > 0) {
      await tx.insert(staffWorkingHours).values(workingHours.map((h) => ({ staffId, ...h })));
    }
  }
}

/** Count of active services, used by the admin dashboard. */
export async function countActiveServices(salonId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(services)
    .where(and(eq(services.salonId, salonId), eq(services.active, true)));
  return row?.count ?? 0;
}
