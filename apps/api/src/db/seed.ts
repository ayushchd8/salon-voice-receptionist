/**
 * Demo seed.
 *
 * Seeds two salons on purpose. The brief only asks for one, but a second salon
 * with different opening hours, services, currency, timezone and booking policy
 * is the cheapest possible proof that onboarding is a data change rather than a
 * code change — and it gives the tenancy-isolation tests something real to try
 * to leak across.
 *
 * Appointments are placed by running the real availability engine against the
 * seeded configuration, so the demo data is always valid against the salon's
 * own rules and is always in the future, whenever the seed happens to be run.
 */
import { DateTime } from 'luxon';
import {
  computeAvailability,
  computeBlockRange,
  normalizePhone,
  type BusyBlock,
  type SchedulingContext,
  type ServiceDef,
  type StaffDef,
} from '@salon/core';
import { AGENT_SCOPES, STAFF_SCOPES } from '@salon/contracts';
import { config } from '../config.js';
import { pool, closePool, withTransaction } from './pool.js';
import { hashApiKey, keyPrefixOf } from '../lib/hash.js';
import type { PoolClient } from 'pg';

// ─────────────────────────────────────────────────────────────────────────────
// Salon definitions — everything below is data. No branch anywhere in the
// codebase reads a salon slug.
// ─────────────────────────────────────────────────────────────────────────────

interface SalonSeed {
  slug: string;
  name: string;
  timezone: string;
  phone: string;
  email: string;
  address: string;
  currency: string;
  /** [dayOfWeek, open, close] — omit a day to close it. */
  hours: Array<[number, string, string]>;
  closedDates: Array<{ daysFromNow: number; reason: string; open?: string; close?: string }>;
  policy: {
    minLeadMinutes: number;
    maxAdvanceDays: number;
    cancellationWindowHours: number;
    lateCancellationFee: string;
    noShowFee: string;
    slotGranularityMinutes: number;
    maxActiveAppointmentsPerCustomer: number;
  };
  services: Array<{
    name: string; description: string; category: string;
    duration: number; bufferAfter: number; price: string; active?: boolean;
  }>;
  staff: Array<{
    name: string; role: string;
    services: string[] | 'all';
    hours?: Array<[number, string, string]>;
  }>;
  customers: Array<{ firstName: string; lastName: string; phone: string; email?: string; notes?: string }>;
  agentKey: string;
  staffKey: string;
}

const LUXE: SalonSeed = {
  slug: 'luxe-hair-studio',
  name: 'Luxe Hair Studio',
  timezone: 'Europe/London',
  phone: '+442079460100',
  email: 'hello@luxehair.example',
  address: '14 Marlborough Street, London W1F 7JJ',
  currency: 'GBP',
  hours: [
    [1, '09:00', '18:00'],
    [2, '09:00', '18:00'],
    [3, '09:00', '20:00'], // late night Wednesday
    [4, '09:00', '20:00'],
    [5, '09:00', '18:00'],
    [6, '09:00', '16:00'],
    // Sunday omitted — closed.
  ],
  closedDates: [
    { daysFromNow: 21, reason: 'Staff training day' },
    { daysFromNow: 40, reason: 'Bank holiday — reduced hours', open: '10:00', close: '14:00' },
  ],
  policy: {
    minLeadMinutes: 120,
    maxAdvanceDays: 90,
    cancellationWindowHours: 24,
    lateCancellationFee: '15.00',
    noShowFee: '25.00',
    slotGranularityMinutes: 15,
    maxActiveAppointmentsPerCustomer: 5,
  },
  services: [
    { name: 'Cut & Blow Dry', description: 'Consultation, cut and finish.', category: 'hair', duration: 60, bufferAfter: 15, price: '55.00' },
    { name: "Men's Cut", description: 'Clipper or scissor cut.', category: 'hair', duration: 30, bufferAfter: 10, price: '32.00' },
    { name: 'Blow Dry', description: 'Wash and style.', category: 'hair', duration: 45, bufferAfter: 10, price: '38.00' },
    { name: 'Full Head Colour', description: 'Single-process colour, roots to ends.', category: 'colour', duration: 120, bufferAfter: 30, price: '110.00' },
    { name: 'Highlights', description: 'Half or full head foils.', category: 'colour', duration: 150, bufferAfter: 30, price: '145.00' },
    { name: 'Root Touch-Up', description: 'Regrowth colour only.', category: 'colour', duration: 75, bufferAfter: 20, price: '68.00' },
    { name: 'Keratin Treatment', description: 'Smoothing treatment, lasts up to 12 weeks.', category: 'treatment', duration: 180, bufferAfter: 30, price: '220.00' },
    { name: 'Colour Consultation', description: 'Free 15-minute consultation and patch test.', category: 'consultation', duration: 15, bufferAfter: 5, price: '0.00' },
    { name: 'Perm', description: 'Discontinued — kept for historical bookings.', category: 'hair', duration: 120, bufferAfter: 20, price: '95.00', active: false },
  ],
  staff: [
    { name: 'Priya Raman', role: 'Senior Stylist & Colourist', services: 'all' },
    {
      name: 'Sam Okonkwo', role: 'Stylist',
      services: ['Cut & Blow Dry', "Men's Cut", 'Blow Dry'],
      hours: [[1, '09:00', '17:00'], [2, '09:00', '17:00'], [3, '12:00', '20:00'], [5, '09:00', '17:00'], [6, '09:00', '16:00']],
    },
    {
      name: 'Alex Whitfield', role: 'Colour Specialist',
      services: ['Full Head Colour', 'Highlights', 'Root Touch-Up', 'Keratin Treatment', 'Colour Consultation'],
      hours: [[2, '10:00', '18:00'], [3, '10:00', '20:00'], [4, '10:00', '20:00'], [5, '10:00', '18:00']],
    },
  ],
  customers: [
    { firstName: 'Eleanor', lastName: 'Whitfield', phone: '+447700900001', email: 'eleanor@example.com', notes: 'Allergic to ammonia-based colour. Patch test on file, 2025-11-02.' },
    { firstName: 'Marcus', lastName: 'Bell', phone: '+447700900002', email: 'marcus.bell@example.com', notes: 'Prefers Sam. Always books the 30-minute slot.' },
    { firstName: 'Aisha', lastName: 'Kaur', phone: '+447700900003', email: 'aisha.k@example.com' },
    { firstName: 'Tom', lastName: 'Reeves', phone: '+447700900004', notes: 'No-showed twice in 2025. Card on file required.' },
    { firstName: 'Grace', lastName: 'Adeyemi', phone: '+447700900005', email: 'grace.a@example.com' },
    { firstName: 'Danny', lastName: 'Cole', phone: '+447700900006' },
  ],
  agentKey: config.SEED_AGENT_API_KEY,
  staffKey: config.SEED_STAFF_API_KEY,
};

/**
 * Second salon: different country, timezone, currency, opening days, services,
 * granularity and cancellation policy. Nothing but rows.
 */
const BELLA: SalonSeed = {
  slug: 'bella-beauty-bar',
  name: 'Bella Beauty Bar',
  timezone: 'America/New_York',
  phone: '+12125550100',
  email: 'front-desk@bellabeauty.example',
  address: '88 Spring Street, New York, NY 10012',
  currency: 'USD',
  hours: [
    [2, '10:00', '19:00'],
    [3, '10:00', '19:00'],
    [4, '10:00', '21:00'],
    [5, '10:00', '21:00'],
    [6, '09:00', '18:00'],
    [0, '11:00', '17:00'], // open Sundays, closed Mondays — the inverse of Luxe
  ],
  closedDates: [{ daysFromNow: 30, reason: 'Independence Day' }],
  policy: {
    minLeadMinutes: 1440, // a full day's notice
    maxAdvanceDays: 45,
    cancellationWindowHours: 48,
    lateCancellationFee: '25.00',
    noShowFee: '50.00',
    slotGranularityMinutes: 30,
    maxActiveAppointmentsPerCustomer: 3,
  },
  services: [
    { name: 'Signature Blowout', description: 'Wash, blow dry and style.', category: 'hair', duration: 45, bufferAfter: 15, price: '65.00' },
    { name: 'Balayage', description: 'Hand-painted highlights.', category: 'colour', duration: 180, bufferAfter: 30, price: '285.00' },
    { name: 'Gel Manicure', description: 'Shape, cuticle work and gel polish.', category: 'nails', duration: 60, bufferAfter: 10, price: '55.00' },
    { name: 'Classic Facial', description: 'Cleanse, exfoliate, mask.', category: 'skin', duration: 60, bufferAfter: 15, price: '95.00' },
  ],
  staff: [
    { name: 'Renata Alves', role: 'Master Colourist', services: ['Balayage', 'Signature Blowout'] },
    { name: 'Jo Kim', role: 'Nail & Skin Technician', services: ['Gel Manicure', 'Classic Facial'] },
  ],
  customers: [
    { firstName: 'Dana', lastName: 'Price', phone: '+12125550111', email: 'dana@example.com' },
    { firstName: 'Luis', lastName: 'Ferrer', phone: '+12125550112' },
  ],
  agentKey: 'sk_agent_bella_1111111111111111111111111111',
  staffKey: 'sk_staff_bella_2222222222222222222222222222',
};

// ─────────────────────────────────────────────────────────────────────────────

async function seedSalon(client: PoolClient, seed: SalonSeed) {
  const { rows: [salon] } = await client.query<{ id: string }>(
    `INSERT INTO salons (name, slug, timezone, phone, email, address)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [seed.name, seed.slug, seed.timezone, seed.phone, seed.email, seed.address],
  );
  const salonId = salon!.id;

  // Business hours: every day gets a row so "closed" is explicit data rather
  // than an absent row the reader has to interpret.
  for (let dow = 0; dow < 7; dow += 1) {
    const open = seed.hours.find(([d]) => d === dow);
    await client.query(
      `INSERT INTO business_hours (salon_id, day_of_week, is_closed, open_time, close_time)
       VALUES ($1,$2,$3,$4,$5)`,
      [salonId, dow, !open, open?.[1] ?? null, open?.[2] ?? null],
    );
  }

  const today = DateTime.now().setZone(seed.timezone).startOf('day');
  for (const cd of seed.closedDates) {
    await client.query(
      `INSERT INTO closed_dates (salon_id, date, reason, open_time, close_time)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (salon_id, date) DO NOTHING`,
      [salonId, today.plus({ days: cd.daysFromNow }).toFormat('yyyy-MM-dd'), cd.reason, cd.open ?? null, cd.close ?? null],
    );
  }

  await client.query(
    `INSERT INTO booking_policies
       (salon_id, min_lead_minutes, max_advance_days, cancellation_window_hours,
        late_cancellation_fee, no_show_fee, slot_granularity_minutes,
        max_active_appointments_per_customer, currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      salonId, seed.policy.minLeadMinutes, seed.policy.maxAdvanceDays,
      seed.policy.cancellationWindowHours, seed.policy.lateCancellationFee,
      seed.policy.noShowFee, seed.policy.slotGranularityMinutes,
      seed.policy.maxActiveAppointmentsPerCustomer, seed.currency,
    ],
  );

  const serviceIdByName = new Map<string, string>();
  const serviceDefs: ServiceDef[] = [];
  for (const s of seed.services) {
    const { rows: [row] } = await client.query<{ id: string }>(
      `INSERT INTO services
         (salon_id, name, description, category, duration_minutes,
          buffer_before_minutes, buffer_after_minutes, price, currency, active)
       VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9) RETURNING id`,
      [salonId, s.name, s.description, s.category, s.duration, s.bufferAfter, s.price, seed.currency, s.active ?? true],
    );
    serviceIdByName.set(s.name, row!.id);
    serviceDefs.push({
      id: row!.id, name: s.name, durationMinutes: s.duration,
      bufferBeforeMinutes: 0, bufferAfterMinutes: s.bufferAfter, active: s.active ?? true,
    });
  }

  const staffDefs: StaffDef[] = [];
  for (const st of seed.staff) {
    const { rows: [row] } = await client.query<{ id: string }>(
      `INSERT INTO staff_members (salon_id, name, role, is_default_resource, active)
       VALUES ($1,$2,$3,false,true) RETURNING id`,
      [salonId, st.name, st.role],
    );
    const staffId = row!.id;

    const serviceIds =
      st.services === 'all' ? [] : st.services.map((n) => serviceIdByName.get(n)!).filter(Boolean);
    for (const serviceId of serviceIds) {
      await client.query(`INSERT INTO staff_services (staff_id, service_id) VALUES ($1,$2)`, [staffId, serviceId]);
    }
    for (const [dow, start, end] of st.hours ?? []) {
      await client.query(
        `INSERT INTO staff_working_hours (staff_id, day_of_week, start_time, end_time) VALUES ($1,$2,$3,$4)`,
        [staffId, dow, start, end],
      );
    }
    staffDefs.push({
      id: staffId, name: st.name, active: true, serviceIds,
      workingHours: (st.hours ?? []).map(([dayOfWeek, startTime, endTime]) => ({ dayOfWeek, startTime, endTime })),
    });
  }

  const customerIdByPhone = new Map<string, string>();
  for (const c of seed.customers) {
    const phone = normalizePhone(c.phone) ?? c.phone;
    const { rows: [row] } = await client.query<{ id: string }>(
      `INSERT INTO customers (salon_id, first_name, last_name, phone, email, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [salonId, c.firstName, c.lastName, phone, c.email ?? null, c.notes ?? null],
    );
    customerIdByPhone.set(phone, row!.id);
  }

  for (const [rawKey, scopes, name] of [
    [seed.agentKey, AGENT_SCOPES, 'Voice agent'],
    [seed.staffKey, STAFF_SCOPES, 'Staff admin UI'],
  ] as const) {
    await client.query(
      `INSERT INTO api_keys (salon_id, name, key_hash, key_prefix, scopes)
       VALUES ($1,$2,$3,$4,$5)`,
      [salonId, name, hashApiKey(rawKey), keyPrefixOf(rawKey), scopes],
    );
  }

  return { salonId, serviceIdByName, serviceDefs, staffDefs, customerIdByPhone };
}

/** Load the scheduling context back out of the database, exactly as the API does. */
async function loadContext(client: PoolClient, salonId: string, timezone: string): Promise<SchedulingContext> {
  const { rows: hours } = await client.query(
    `SELECT day_of_week, is_closed, open_time, close_time FROM business_hours WHERE salon_id = $1`, [salonId]);
  const { rows: closed } = await client.query(
    `SELECT to_char(date,'YYYY-MM-DD') AS date, reason, open_time, close_time FROM closed_dates WHERE salon_id = $1`, [salonId]);
  const { rows: [policy] } = await client.query(`SELECT * FROM booking_policies WHERE salon_id = $1`, [salonId]);

  return {
    salonId,
    timezone,
    businessHours: hours.map((h) => ({
      dayOfWeek: h.day_of_week, isClosed: h.is_closed, openTime: h.open_time, closeTime: h.close_time,
    })),
    closedDates: closed.map((c) => ({
      date: c.date, reason: c.reason, openTime: c.open_time, closeTime: c.close_time,
    })),
    policy: {
      minLeadMinutes: policy!.min_lead_minutes,
      maxAdvanceDays: policy!.max_advance_days,
      cancellationWindowHours: policy!.cancellation_window_hours,
      lateCancellationFee: policy!.late_cancellation_fee,
      noShowFee: policy!.no_show_fee,
      slotGranularityMinutes: policy!.slot_granularity_minutes,
      allowDoubleBooking: policy!.allow_double_booking,
      maxActiveAppointmentsPerCustomer: policy!.max_active_appointments_per_customer,
      currency: policy!.currency,
    },
  };
}

/**
 * Book a demo appointment into a genuinely free slot.
 *
 * Uses the real availability engine against the seeded configuration, so seed
 * data can never contradict the salon's own rules — and re-running the seed on
 * a different day still produces valid, future appointments.
 */
async function bookDemoAppointment(
  client: PoolClient,
  args: {
    context: SchedulingContext; salonId: string; currency: string;
    service: ServiceDef; price: string; staff: StaffDef[]; customerId: string;
    searchFromDays: number; source: 'voice' | 'staff' | 'web'; preferStaffId?: string;
    /** Which of the free slots to take, so the demo day is not all 09:00s. */
    slotIndex?: number;
  },
): Promise<string | null> {
  // Day boundaries in the salon's own timezone, not the machine's — otherwise a
  // developer in a different zone seeds appointments onto the wrong day.
  const now = DateTime.now().setZone(args.context.timezone);
  const from = now.plus({ days: args.searchFromDays }).startOf('day');
  const to = from.plus({ days: 14 });

  const { rows: busyRows } = await client.query(
    `SELECT staff_id, block_start, block_end FROM appointments
      WHERE salon_id = $1 AND status IN ('booked','completed')`, [args.salonId]);
  const busy: BusyBlock[] = busyRows.map((b) => ({
    staffId: b.staff_id,
    blockStart: new Date(b.block_start).toISOString(),
    blockEnd: new Date(b.block_end).toISOString(),
  }));

  const slots = computeAvailability({
    context: args.context, service: args.service, staff: args.staff, busy,
    from: from.toUTC().toISO()!, to: to.toUTC().toISO()!, now: now.toUTC().toISO()!,
    staffId: args.preferStaffId, limit: 40,
  });
  // Spread the demo bookings across the day rather than stacking them all on
  // the first free slot, which makes the seeded calendar look machine-made.
  const slot = slots[Math.min(args.slotIndex ?? 3, slots.length - 1)];
  if (!slot) return null;

  const range = computeBlockRange(slot.start, args.service);
  const { rows: [row] } = await client.query<{ id: string }>(
    `INSERT INTO appointments
       (salon_id, customer_id, service_id, staff_id, start_time, end_time,
        block_start, block_end, status, source, price_at_booking, currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'booked',$9,$10,$11) RETURNING id`,
    [
      args.salonId, args.customerId, args.service.id, slot.staffId,
      range.start, range.end, range.blockStart, range.blockEnd,
      args.source, args.price, args.currency,
    ],
  );
  return row!.id;
}

async function seedCalls(
  client: PoolClient,
  salonId: string,
  customerId: string,
  appointmentId: string | null,
) {
  const now = DateTime.now();

  // A successful booking call.
  const { rows: [ok] } = await client.query<{ id: string }>(
    `INSERT INTO call_logs (salon_id, caller_phone, started_at, ended_at, transport, status, transcript)
     VALUES ($1,$2,$3,$4,'browser','completed',$5) RETURNING id`,
    [
      salonId, '+447700900001',
      now.minus({ hours: 5 }).toISO(), now.minus({ hours: 5 }).plus({ seconds: 96 }).toISO(),
      JSON.stringify([
        { role: 'agent', text: 'Good morning, Luxe Hair Studio — how can I help?', at: now.minus({ hours: 5 }).toISO() },
        { role: 'caller', text: "Hi, I'd like to book a cut and blow dry for next week if you have anything.", at: now.minus({ hours: 5 }).plus({ seconds: 6 }).toISO() },
        { role: 'agent', text: 'Of course. I have Tuesday at 10:30 or Wednesday at 2pm — would either of those work?', at: now.minus({ hours: 5 }).plus({ seconds: 14 }).toISO() },
        { role: 'caller', text: 'Wednesday at two, please.', at: now.minus({ hours: 5 }).plus({ seconds: 22 }).toISO() },
        { role: 'agent', text: "That's a Cut & Blow Dry on Wednesday at 2pm with Priya, for Eleanor. Shall I book that?", at: now.minus({ hours: 5 }).plus({ seconds: 30 }).toISO() },
        { role: 'caller', text: 'Yes please.', at: now.minus({ hours: 5 }).plus({ seconds: 36 }).toISO() },
        { role: 'agent', text: "You're booked in. See you Wednesday.", at: now.minus({ hours: 5 }).plus({ seconds: 44 }).toISO() },
      ]),
    ],
  );
  await client.query(
    `INSERT INTO call_summaries
       (call_id, salon_id, customer_id, caller_phone, intents, services_discussed,
        appointment_action, action_result, appointment_id, summary, key_entities, events)
     VALUES ($1,$2,$3,$4,$5,$6,'book','success',$7,$8,$9,$10)`,
    [
      ok!.id, salonId, customerId, '+447700900001',
      ['booking', 'availability'], ['Cut & Blow Dry'], appointmentId,
      'Eleanor asked for a cut and blow dry next week. Offered two slots, she took Wednesday 2pm with Priya. Booked and confirmed.',
      JSON.stringify({ service: 'Cut & Blow Dry', staff: 'Priya Raman', confirmed: true }),
      JSON.stringify([
        { at: now.minus({ hours: 5 }).toISO(), type: 'call_started', detail: { transport: 'browser' } },
        { at: now.minus({ hours: 5 }).plus({ seconds: 8 }).toISO(), type: 'intent_detected', detail: { intent: 'booking' } },
        { at: now.minus({ hours: 5 }).plus({ seconds: 12 }).toISO(), type: 'tool_call', detail: { tool: 'check_availability' }, latencyMs: 84, outcome: 'success' },
        { at: now.minus({ hours: 5 }).plus({ seconds: 30 }).toISO(), type: 'confirmation_requested', detail: { action: 'book' } },
        { at: now.minus({ hours: 5 }).plus({ seconds: 36 }).toISO(), type: 'confirmation_received', detail: { affirmative: true } },
        { at: now.minus({ hours: 5 }).plus({ seconds: 40 }).toISO(), type: 'tool_call', detail: { tool: 'commit_booking' }, latencyMs: 132, outcome: 'success' },
      ]),
    ],
  );

  // An escalated call — the one a supervisor actually wants to find.
  const { rows: [bad] } = await client.query<{ id: string }>(
    `INSERT INTO call_logs (salon_id, caller_phone, started_at, ended_at, transport, status, transcript)
     VALUES ($1,$2,$3,$4,'browser','completed',$5) RETURNING id`,
    [
      salonId, '+447700900004',
      now.minus({ hours: 2 }).toISO(), now.minus({ hours: 2 }).plus({ seconds: 71 }).toISO(),
      JSON.stringify([
        { role: 'caller', text: 'I want a refund for the colour you did last month, it went completely wrong.', at: now.minus({ hours: 2 }).plus({ seconds: 4 }).toISO() },
        { role: 'agent', text: "I'm sorry to hear that. Refunds are handled by the salon manager rather than by me — can I take your number and have them call you back?", at: now.minus({ hours: 2 }).plus({ seconds: 12 }).toISO() },
        { role: 'caller', text: 'Fine. Tom Reeves, and my number is the one I am calling from. Any time after four.', at: now.minus({ hours: 2 }).plus({ seconds: 24 }).toISO() },
      ]),
    ],
  );
  await client.query(
    `INSERT INTO call_summaries
       (call_id, salon_id, customer_id, caller_phone, intents, services_discussed,
        appointment_action, action_result, summary, key_entities, events,
        escalated, escalation_reason, callback_request)
     VALUES ($1,$2,$3,$4,$5,$6,'none','not_attempted',$7,$8,$9,true,$10,$11)`,
    [
      bad!.id, salonId, null, '+447700900004',
      ['complaint', 'out_of_scope', 'callback'], ['Full Head Colour'],
      'Caller requested a refund for a colour service. Out of scope for the receptionist; collected a callback request for the salon manager.',
      JSON.stringify({ complaintAbout: 'Full Head Colour', refundRequested: true }),
      JSON.stringify([
        { at: now.minus({ hours: 2 }).plus({ seconds: 8 }).toISO(), type: 'intent_detected', detail: { intent: 'complaint' } },
        { at: now.minus({ hours: 2 }).plus({ seconds: 30 }).toISO(), type: 'escalated', detail: { reason: 'refund_request' } },
      ]),
      'Refund request — outside the receptionist’s scope',
      JSON.stringify({ name: 'Tom Reeves', phone: '+447700900004', reason: 'Refund request for a full head colour', preferredTime: 'any time after 4pm' }),
    ],
  );
}

async function main() {
  console.log('Seeding demo data…\n');

  await withTransaction(async (client) => {
    // Idempotent: wipe and rebuild the demo salons only. Cascades handle the rest.
    await client.query(`DELETE FROM salons WHERE slug = ANY($1)`, [[LUXE.slug, BELLA.slug]]);

    // ── Salon 1 ───────────────────────────────────────────────────────────────
    const luxe = await seedSalon(client, LUXE);
    const luxeContext = await loadContext(client, luxe.salonId, LUXE.timezone);
    const svc = (name: string) => luxe.serviceDefs.find((s) => s.name === name)!;
    const priceOf = (name: string) => LUXE.services.find((s) => s.name === name)!.price;
    const cust = (phone: string) => luxe.customerIdByPhone.get(phone)!;

    const book = (
      serviceName: string, customerPhone: string, searchFromDays: number,
      slotIndex: number, source: 'voice' | 'staff' | 'web' = 'voice',
    ) =>
      bookDemoAppointment(client, {
        context: luxeContext, salonId: luxe.salonId, currency: LUXE.currency,
        service: svc(serviceName), price: priceOf(serviceName), staff: luxe.staffDefs,
        customerId: cust(customerPhone), searchFromDays, source, slotIndex,
      });

    const eleanorCut = await book('Cut & Blow Dry', '+447700900001', 2, 6);
    // Eleanor deliberately gets a second upcoming appointment: "cancel my
    // appointment" from her must force the agent to disambiguate rather than
    // guess. This is a fixture for a Definition-of-Done requirement.
    await book('Root Touch-Up', '+447700900001', 9, 14);

    await book("Men's Cut", '+447700900002', 3, 20);
    await book('Highlights', '+447700900003', 5, 4, 'web');
    await book('Blow Dry', '+447700900005', 4, 12, 'staff');
    await book('Keratin Treatment', '+447700900006', 11, 2);

    // Some history, so the CRM has something to show on a customer record.
    const pastStart = DateTime.now()
      .setZone(LUXE.timezone)
      .minus({ days: 28 })
      .set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
    const pastRange = computeBlockRange(pastStart.toUTC().toISO()!, svc('Full Head Colour'));
    await client.query(
      `INSERT INTO appointments
         (salon_id, customer_id, service_id, staff_id, start_time, end_time, block_start, block_end,
          status, source, price_at_booking, currency, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed','voice',$9,$10,$11)`,
      [
        luxe.salonId, cust('+447700900001'), svc('Full Head Colour').id, luxe.staffDefs[0]!.id,
        pastRange.start, pastRange.end, pastRange.blockStart, pastRange.blockEnd,
        priceOf('Full Head Colour'), LUXE.currency, pastRange.end,
      ],
    );

    await seedCalls(client, luxe.salonId, cust('+447700900001'), eleanorCut);

    // ── Salon 2 ───────────────────────────────────────────────────────────────
    const bella = await seedSalon(client, BELLA);
    const bellaContext = await loadContext(client, bella.salonId, BELLA.timezone);
    for (const [serviceName, phone] of [
      ['Signature Blowout', '+12125550111'],
      ['Gel Manicure', '+12125550112'],
    ] as const) {
      await bookDemoAppointment(client, {
        context: bellaContext, salonId: bella.salonId, currency: BELLA.currency,
        service: bella.serviceDefs.find((s) => s.name === serviceName)!,
        price: BELLA.services.find((s) => s.name === serviceName)!.price,
        staff: bella.staffDefs, customerId: bella.customerIdByPhone.get(phone)!,
        searchFromDays: 2, source: 'voice', slotIndex: serviceName === 'Gel Manicure' ? 9 : 3,
      });
    }
  });

  const { rows: [counts] } = await pool.query(`
    SELECT
      (SELECT count(*) FROM salons)       AS salons,
      (SELECT count(*) FROM services)     AS services,
      (SELECT count(*) FROM staff_members) AS staff,
      (SELECT count(*) FROM customers)    AS customers,
      (SELECT count(*) FROM appointments) AS appointments,
      (SELECT count(*) FROM call_summaries) AS call_summaries
  `);

  console.log('Seeded:');
  for (const [k, v] of Object.entries(counts!)) console.log(`  ${k.padEnd(16)} ${v}`);
  console.log('\nAPI keys (stored hashed — these raw values are shown once):');
  console.log(`  ${LUXE.name}`);
  console.log(`    agent  ${LUXE.agentKey}`);
  console.log(`    staff  ${LUXE.staffKey}`);
  console.log(`  ${BELLA.name}`);
  console.log(`    agent  ${BELLA.agentKey}`);
  console.log(`    staff  ${BELLA.staffKey}`);
  console.log('\nSign in to the CRM at http://localhost:5173 with the staff key.\n');
}

main()
  .then(closePool)
  .catch(async (err) => {
    console.error('\nSeed failed:', err.message);
    if (err.detail) console.error('  detail:', err.detail);
    await closePool();
    process.exit(1);
  });
