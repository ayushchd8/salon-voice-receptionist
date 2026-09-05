import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { buildApp } from '../app.js';
import { clearKeyCache } from '../plugins/auth.js';
import {
  AGENT_KEY,
  resetDatabase,
  seedTestSalon,
  type TestSalon,
} from '../test-support/db.js';
import { pool } from '../db/pool.js';

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let salon: TestSalon;

const agent = { authorization: `Bearer ${AGENT_KEY}` };

let keyCounter = 0;
const idem = () => ({ 'idempotency-key': `test-key-${Date.now()}-${keyCounter++}` });

/** The next occurrence of a weekday at a salon-local time, comfortably in the future. */
function futureSlot(weekday: number, localTime: string, weeksAhead = 1): string {
  let dt = DateTime.now().setZone('Europe/London').plus({ weeks: weeksAhead }).startOf('day');
  while (dt.weekday % 7 !== weekday) dt = dt.plus({ days: 1 });
  const [h, m] = localTime.split(':').map(Number);
  return dt.set({ hour: h, minute: m }).toUTC().toISO()!;
}

const body = (r: { body: string }) => JSON.parse(r.body);

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDatabase();
  clearKeyCache();
  salon = await seedTestSalon();
});

describe('POST /v1/appointments — happy path', () => {
  it('books an appointment for an existing customer', async () => {
    const start = futureSlot(2, '10:00'); // Tuesday
    const res = await app.inject({
      method: 'POST',
      url: '/v1/appointments',
      headers: { ...agent, ...idem() },
      payload: { customerId: salon.customerIds.eleanor, serviceId: salon.serviceIds.cut, start, source: 'voice' },
    });

    expect(res.statusCode).toBe(201);
    const appointment = body(res);
    expect(appointment.status).toBe('booked');
    expect(appointment.service.name).toBe('Cut & Blow Dry');
    // Salon-local rendering travels with the appointment so no consumer re-derives it.
    expect(appointment.localTime).toBe('10:00');
    expect(appointment.label).toMatch(/10 am/);
    expect(appointment.priceAtBooking).toBe('55.00');
  });

  it('creates the customer and the appointment together for a first-time caller', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/appointments',
      headers: { ...agent, ...idem() },
      payload: {
        customer: { firstName: 'Nadia', phone: '07700 900 555' },
        serviceId: salon.serviceIds.cut,
        start: futureSlot(2, '11:00'),
        source: 'voice',
      },
    });

    expect(res.statusCode).toBe(201);
    // The number was given in national format and must be stored canonically,
    // or the caller becomes a second record next time they ring.
    expect(body(res).customer.phone).toBe('+447700900555');
  });

  it('assigns a qualified staff member when the caller has no preference', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/appointments',
      headers: { ...agent, ...idem() },
      payload: {
        customerId: salon.customerIds.marcus,
        serviceId: salon.serviceIds.colour, // only Priya does colour
        start: futureSlot(4, '10:00'),
        source: 'voice',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(body(res).staff.name).toBe('Priya');
  });
});

describe('POST /v1/appointments — validation and policy', () => {
  const cases: Array<[string, () => Record<string, unknown>, string]> = [
    ['a time in the past', () => ({ start: DateTime.now().minus({ days: 2 }).toUTC().toISO() }), 'BOOKING_IN_PAST'],
    ['a day the salon is closed', () => ({ start: futureSlot(0, '10:00') }), 'SALON_CLOSED_ON_DATE'],
    ['a time before opening', () => ({ start: futureSlot(2, '07:00') }), 'OUTSIDE_BUSINESS_HOURS'],
    ['a service that would overrun closing', () => ({ start: futureSlot(2, '17:30') }), 'OUTSIDE_BUSINESS_HOURS'],
    ['a retired service', () => ({ serviceId: salon.serviceIds.retired, start: futureSlot(2, '10:00') }), 'SERVICE_INACTIVE'],
    ['an unknown service', () => ({ serviceId: '00000000-0000-0000-0000-000000000000', start: futureSlot(2, '10:00') }), 'SERVICE_NOT_FOUND'],
  ];

  it.each(cases)('rejects %s with %s', async (_label, overrides, expectedCode) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/appointments',
      headers: { ...agent, ...idem() },
      payload: {
        customerId: salon.customerIds.eleanor,
        serviceId: salon.serviceIds.cut,
        source: 'voice',
        ...overrides(),
      },
    });
    expect(body(res).error.code).toBe(expectedCode);
  });

  it('enforces the minimum notice period and says when the earliest slot is', async () => {
    // The notice period is set absurdly long rather than the target time being
    // set absurdly close. Picking "an hour from now" made this test depend on
    // the wall clock *and* the day of the week — it passed in the morning and
    // failed on a Saturday evening, when "tomorrow" is a Sunday and the salon is
    // shut. Lead time is checked before opening hours, so a distant, perfectly
    // valid slot isolates the rule under test.
    const THIRTY_DAYS = 60 * 24 * 30;
    await resetDatabase();
    clearKeyCache();
    salon = await seedTestSalon({ minLeadMinutes: THIRTY_DAYS });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/appointments',
      headers: { ...agent, ...idem() },
      payload: {
        customerId: salon.customerIds.eleanor,
        serviceId: salon.serviceIds.cut,
        start: futureSlot(2, '10:00'), // a Tuesday, comfortably inside opening hours
        source: 'voice',
      },
    });

    const err = body(res).error;
    expect(err.code).toBe('LEAD_TIME_TOO_SHORT');
    // The agent needs a concrete earliest time to offer, not just a refusal.
    expect(err.details.minLeadMinutes).toBe(THIRTY_DAYS);
    expect(err.details.earliestStart).toBeTruthy();
    expect(new Date(err.details.earliestStart as string).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects a staff member who does not offer the service', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/appointments',
      headers: { ...agent, ...idem() },
      payload: {
        customerId: salon.customerIds.eleanor,
        serviceId: salon.serviceIds.colour,
        staffId: salon.staffIds.sam, // Sam does cuts only
        start: futureSlot(2, '10:00'),
        source: 'voice',
      },
    });
    expect(body(res).error.code).toBe('STAFF_CANNOT_PERFORM_SERVICE');
    expect(body(res).error.message).toContain('Sam');
  });

  it('rejects a staff member outside their shift', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/appointments',
      headers: { ...agent, ...idem() },
      payload: {
        customerId: salon.customerIds.eleanor,
        serviceId: salon.serviceIds.cut,
        staffId: salon.staffIds.sam, // Sam works Mon–Wed only
        start: futureSlot(5, '10:00'), // Friday
        source: 'voice',
      },
    });
    expect(body(res).error.code).toBe('STAFF_NOT_WORKING');
  });

  it('returns field-level detail for a malformed body rather than a bare 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/appointments',
      headers: { ...agent, ...idem() },
      payload: { serviceId: 'not-a-uuid', start: 'yesterday' },
    });
    expect(res.statusCode).toBe(400);
    const err = body(res).error;
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.details.fields.length).toBeGreaterThan(0);
    expect(err.details.fields.map((f: { path: string }) => f.path)).toContain('serviceId');
  });
});

describe('double-booking prevention', () => {
  async function book(start: string, customerId: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/appointments',
      headers: { ...agent, ...idem() },
      payload: { customerId, serviceId: salon.serviceIds.colour, start, source: 'voice' },
    });
  }

  it('refuses a second booking in a slot already taken, and offers alternatives', async () => {
    const start = futureSlot(4, '10:00');
    expect((await book(start, salon.customerIds.eleanor)).statusCode).toBe(201);

    const second = await book(start, salon.customerIds.marcus);
    const err = body(second).error;
    expect(err.code).toBe('SLOT_UNAVAILABLE');
    // Being told "no" is exactly when a caller needs concrete options.
    expect(err.details.alternatives.length).toBeGreaterThan(0);
    expect(err.details.alternatives[0]).toHaveProperty('label');
  });

  it("refuses a booking that lands inside the previous appointment's buffer", async () => {
    // A colour runs 2 hours with a 30-minute buffer: 10:00 blocks up to 12:30.
    expect((await book(futureSlot(4, '10:00'), salon.customerIds.eleanor)).statusCode).toBe(201);
    const inBuffer = await book(futureSlot(4, '12:15'), salon.customerIds.marcus);
    expect(body(inBuffer).error.code).toBe('SLOT_UNAVAILABLE');

    const afterBuffer = await book(futureSlot(4, '12:30'), salon.customerIds.marcus);
    expect(afterBuffer.statusCode).toBe(201);
  });

  /**
   * The concurrency requirement, tested directly.
   *
   * Eight callers race for one slot with distinct idempotency keys, so nothing
   * but the database can arbitrate. Exactly one must win — this is what the
   * `EXCLUDE USING gist` constraint buys, and it is the assertion that would
   * fail if someone ever "optimised" it into a check-then-write.
   */
  it('lets exactly one of eight concurrent bookings win the same slot', async () => {
    const start = futureSlot(4, '14:00');

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: '/v1/appointments',
          headers: { ...agent, 'idempotency-key': `race-${Date.now()}-${i}` },
          payload: {
            customer: { firstName: `Racer${i}`, phone: `+4477009100${String(i).padStart(2, '0')}` },
            serviceId: salon.serviceIds.colour,
            start,
            source: 'voice',
          },
        }),
      ),
    );

    const created = results.filter((r) => r.statusCode === 201);
    const rejected = results.filter((r) => r.statusCode !== 201);

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(7);

    // Every loser must get a code the agent knows what to do with. Under heavy
    // contention that may be SERVICE_UNAVAILABLE — a deadlock, a lock timeout,
    // an exhausted pool — which is honest and retryable. What it must never be
    // is an untyped INTERNAL_ERROR, which reaches a caller as "something went
    // wrong" and gives the agent nothing to act on.
    for (const r of rejected) {
      const { code } = body(r).error;
      expect(code).not.toBe('INTERNAL_ERROR');
      expect(['SLOT_UNAVAILABLE', 'NO_STAFF_AVAILABLE', 'SERVICE_UNAVAILABLE']).toContain(code);
    }

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM appointments WHERE start_time = $1 AND status = 'booked'`,
      [start],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('idempotency', () => {
  const payloadFor = (start: string) => ({
    customerId: salon.customerIds.eleanor,
    serviceId: salon.serviceIds.cut,
    start,
    source: 'voice' as const,
  });

  it('replays the original response instead of booking twice', async () => {
    const start = futureSlot(2, '13:00');
    const key = { 'idempotency-key': `retry-${Date.now()}` };

    const first = await app.inject({ method: 'POST', url: '/v1/appointments', headers: { ...agent, ...key }, payload: payloadFor(start) });
    const second = await app.inject({ method: 'POST', url: '/v1/appointments', headers: { ...agent, ...key }, payload: payloadFor(start) });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(body(second).id).toBe(body(first).id);
    expect(first.headers['idempotent-replay']).toBe('false');
    expect(second.headers['idempotent-replay']).toBe('true');

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM appointments`);
    expect(rows[0].n).toBe(1);
  });

  it('rejects a key reused for a different request', async () => {
    const key = { 'idempotency-key': `reuse-${Date.now()}` };
    await app.inject({ method: 'POST', url: '/v1/appointments', headers: { ...agent, ...key }, payload: payloadFor(futureSlot(2, '13:00')) });
    const other = await app.inject({ method: 'POST', url: '/v1/appointments', headers: { ...agent, ...key }, payload: payloadFor(futureSlot(2, '15:00')) });

    // Replaying here would answer a question the caller did not ask.
    expect(body(other).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('requires a key on every state-changing endpoint', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/appointments', headers: agent, payload: payloadFor(futureSlot(2, '13:00')) });
    expect(body(res).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('replays a deterministic failure rather than re-running it', async () => {
    const key = { 'idempotency-key': `fail-${Date.now()}` };
    const payload = { ...payloadFor(futureSlot(0, '10:00')) }; // Sunday: closed

    const first = await app.inject({ method: 'POST', url: '/v1/appointments', headers: { ...agent, ...key }, payload });
    const second = await app.inject({ method: 'POST', url: '/v1/appointments', headers: { ...agent, ...key }, payload });

    expect(body(first).error.code).toBe('SALON_CLOSED_ON_DATE');
    expect(body(second).error.code).toBe('SALON_CLOSED_ON_DATE');
    expect(second.headers['idempotent-replay']).toBe('true');
  });
});
