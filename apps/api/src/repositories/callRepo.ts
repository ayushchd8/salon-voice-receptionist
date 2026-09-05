import { and, desc, eq, gte, ilike, lte, sql } from 'drizzle-orm';
import { db, type Executor } from '../db/index.js';
import { callLogs, callSummaries, customers } from '../db/schema.js';

export type CallLogRow = typeof callLogs.$inferSelect;
export type CallSummaryRow = typeof callSummaries.$inferSelect;

export async function startCall(
  salonId: string,
  input: { callerPhone: string | null; transport: string },
) {
  const [row] = await db
    .insert(callLogs)
    .values({ salonId, callerPhone: input.callerPhone, transport: input.transport, status: 'in_progress' })
    .returning();
  return row!;
}

export async function getCall(salonId: string, callId: string, exec: Executor = db) {
  const [row] = await exec
    .select()
    .from(callLogs)
    .where(and(eq(callLogs.salonId, salonId), eq(callLogs.id, callId)))
    .limit(1);
  return row ?? null;
}

/** Store what has been said so far, without closing the call. */
export async function updateCallTranscript(
  salonId: string,
  callId: string,
  transcript: unknown[],
) {
  const [row] = await db
    .update(callLogs)
    .set({ transcript })
    .where(and(eq(callLogs.salonId, salonId), eq(callLogs.id, callId)))
    .returning();
  return row ?? null;
}

export async function endCall(
  salonId: string,
  callId: string,
  input: { status: string; transcript: unknown[]; recordingRef: string | null },
) {
  const [row] = await db
    .update(callLogs)
    .set({
      status: input.status,
      transcript: input.transcript,
      recordingRef: input.recordingRef,
      endedAt: new Date(),
    })
    .where(and(eq(callLogs.salonId, salonId), eq(callLogs.id, callId)))
    .returning();
  return row ?? null;
}

/**
 * Upsert the summary for a call.
 *
 * Upsert rather than insert because the agent writes the summary in a `finally`
 * block: a call that fails and is retried, or one whose summary is written
 * twice during shutdown, must not blow up on the unique constraint and lose the
 * record entirely. The last write wins.
 */
export async function saveCallSummary(
  salonId: string,
  input: Omit<typeof callSummaries.$inferInsert, 'salonId'>,
) {
  const [row] = await db
    .insert(callSummaries)
    .values({ ...input, salonId })
    .onConflictDoUpdate({
      target: callSummaries.callId,
      set: {
        customerId: input.customerId ?? null,
        callerPhone: input.callerPhone ?? null,
        intents: input.intents ?? [],
        servicesDiscussed: input.servicesDiscussed ?? [],
        appointmentAction: input.appointmentAction ?? 'none',
        actionResult: input.actionResult ?? 'not_attempted',
        failureReason: input.failureReason ?? null,
        appointmentId: input.appointmentId ?? null,
        summary: input.summary ?? '',
        keyEntities: input.keyEntities ?? {},
        events: input.events ?? [],
        escalated: input.escalated ?? false,
        escalationReason: input.escalationReason ?? null,
        callbackRequest: input.callbackRequest ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row!;
}

export interface CallSummaryFilters {
  escalated?: boolean | undefined;
  actionResult?: string | undefined;
  appointmentAction?: string | undefined;
  intent?: string | undefined;
  customerId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  search?: string | undefined;
  limit: number;
  offset: number;
}

export interface CallSummaryDetail {
  summary: CallSummaryRow;
  call: CallLogRow;
  customerName: string | null;
}

export async function listCallSummaries(
  salonId: string,
  filters: CallSummaryFilters,
): Promise<{ rows: CallSummaryDetail[]; total: number }> {
  const conditions = [eq(callSummaries.salonId, salonId)];

  if (filters.escalated !== undefined) conditions.push(eq(callSummaries.escalated, filters.escalated));
  if (filters.actionResult) conditions.push(eq(callSummaries.actionResult, filters.actionResult));
  if (filters.appointmentAction) conditions.push(eq(callSummaries.appointmentAction, filters.appointmentAction));
  if (filters.customerId) conditions.push(eq(callSummaries.customerId, filters.customerId));
  if (filters.from) conditions.push(gte(callSummaries.createdAt, filters.from));
  if (filters.to) conditions.push(lte(callSummaries.createdAt, filters.to));
  if (filters.search) conditions.push(ilike(callSummaries.summary, `%${filters.search}%`));
  if (filters.intent) conditions.push(sql`${filters.intent} = ANY(${callSummaries.intents})`);

  const where = and(...conditions);

  const [rows, [total]] = await Promise.all([
    db
      .select({
        summary: callSummaries,
        call: callLogs,
        customerName: sql<string | null>`${customers.firstName}`.as('customer_name'),
      })
      .from(callSummaries)
      .innerJoin(callLogs, eq(callLogs.id, callSummaries.callId))
      .leftJoin(customers, eq(customers.id, callSummaries.customerId))
      .where(where)
      .orderBy(desc(callSummaries.createdAt))
      .limit(filters.limit)
      .offset(filters.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(callSummaries).where(where),
  ]);

  return { rows: rows as CallSummaryDetail[], total: total?.count ?? 0 };
}

export async function getCallSummary(salonId: string, callId: string): Promise<CallSummaryDetail | null> {
  const rows = await db
    .select({
      summary: callSummaries,
      call: callLogs,
      customerName: sql<string | null>`${customers.firstName}`.as('customer_name'),
    })
    .from(callSummaries)
    .innerJoin(callLogs, eq(callLogs.id, callSummaries.callId))
    .leftJoin(customers, eq(customers.id, callSummaries.customerId))
    .where(and(eq(callSummaries.salonId, salonId), eq(callSummaries.callId, callId)))
    .limit(1);
  return (rows[0] as CallSummaryDetail | undefined) ?? null;
}
