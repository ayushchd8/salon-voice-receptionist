import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db, type Executor } from '../db/index.js';
import { customers } from '../db/schema.js';

export type CustomerRow = typeof customers.$inferSelect;

export async function getCustomer(salonId: string, customerId: string, exec: Executor = db) {
  const [row] = await exec
    .select()
    .from(customers)
    .where(and(eq(customers.salonId, salonId), eq(customers.id, customerId)))
    .limit(1);
  return row ?? null;
}

export async function findByPhone(salonId: string, phone: string, exec: Executor = db) {
  const [row] = await exec
    .select()
    .from(customers)
    .where(and(eq(customers.salonId, salonId), eq(customers.phone, phone)))
    .limit(1);
  return row ?? null;
}

export async function searchCustomers(
  salonId: string,
  query: { phone?: string | undefined; name?: string | undefined; email?: string | undefined; limit: number; offset: number },
) {
  const conditions = [eq(customers.salonId, salonId)];

  if (query.phone) {
    // Match on a trailing fragment too: callers read out the last six digits far
    // more often than a full E.164 number.
    conditions.push(
      or(
        eq(customers.phone, query.phone),
        ilike(customers.phone, `%${query.phone.replace(/\D/g, '').slice(-6)}`),
      )!,
    );
  }
  if (query.name) {
    const term = `%${query.name}%`;
    conditions.push(
      or(
        ilike(customers.firstName, term),
        ilike(customers.lastName, term),
        ilike(sql`${customers.firstName} || ' ' || coalesce(${customers.lastName}, '')`, term),
      )!,
    );
  }
  if (query.email) conditions.push(ilike(customers.email, `%${query.email}%`));

  const where = and(...conditions);
  const [rows, [total]] = await Promise.all([
    db.select().from(customers).where(where).orderBy(desc(customers.updatedAt)).limit(query.limit).offset(query.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(customers).where(where),
  ]);

  return { rows, total: total?.count ?? 0 };
}

export async function listCustomers(salonId: string, limit: number, offset: number) {
  const where = eq(customers.salonId, salonId);
  const [rows, [total]] = await Promise.all([
    db.select().from(customers).where(where).orderBy(desc(customers.createdAt)).limit(limit).offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(customers).where(where),
  ]);
  return { rows, total: total?.count ?? 0 };
}

export async function createCustomer(
  salonId: string,
  input: { firstName: string; lastName?: string | null; phone: string; email?: string | null; notes?: string | null },
  exec: Executor = db,
) {
  const [row] = await exec
    .insert(customers)
    .values({
      salonId,
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      phone: input.phone,
      email: input.email ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  return row!;
}

/**
 * Find an existing customer by phone, or create one.
 *
 * Runs as a single statement with ON CONFLICT rather than SELECT-then-INSERT:
 * two concurrent calls from the same new number would otherwise race and one
 * would fail on the unique index. The name is only filled in when the row is
 * created, so a returning customer keeps the name already on file rather than
 * having it overwritten by whatever they said this time.
 */
export async function findOrCreateByPhone(
  salonId: string,
  input: { firstName: string; lastName?: string | null; phone: string; email?: string | null },
  exec: Executor = db,
): Promise<{ customer: CustomerRow; created: boolean }> {
  const existing = await findByPhone(salonId, input.phone, exec);
  if (existing) return { customer: existing, created: false };

  const [row] = await exec
    .insert(customers)
    .values({
      salonId,
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      phone: input.phone,
      email: input.email ?? null,
    })
    .onConflictDoUpdate({
      target: [customers.salonId, customers.phone],
      // A no-op update so the row is returned rather than nothing on conflict.
      set: { updatedAt: new Date() },
    })
    .returning();

  return { customer: row!, created: row!.createdAt.getTime() === row!.updatedAt.getTime() };
}

export async function updateCustomer(
  salonId: string,
  customerId: string,
  patch: Partial<Pick<CustomerRow, 'firstName' | 'lastName' | 'phone' | 'email' | 'notes'>>,
) {
  const [row] = await db
    .update(customers)
    .set(patch)
    .where(and(eq(customers.salonId, salonId), eq(customers.id, customerId)))
    .returning();
  return row ?? null;
}
