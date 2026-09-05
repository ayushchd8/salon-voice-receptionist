import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { buildApp } from '../app.js';
import { clearKeyCache } from '../plugins/auth.js';
import {
  AGENT_KEY,
  OTHER_SALON_KEY,
  STAFF_KEY,
  resetDatabase,
  seedOtherSalon,
  seedTestSalon,
  type TestSalon,
} from '../test-support/db.js';
import { pool } from '../db/pool.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let salon: TestSalon;

const agent = { authorization: `Bearer ${AGENT_KEY}` };
const staff = { authorization: `Bearer ${STAFF_KEY}` };
const other = { authorization: `Bearer ${OTHER_SALON_KEY}` };

let n = 0;
const idem = () => ({ 'idempotency-key': `lc-${Date.now()}-${n++}` });
const body = (r: { body: string }) => JSON.parse(r.body);

function futureSlot(weekday: number, localTime: string, weeksAhead = 1): string {
  let dt = DateTime.now().setZone('Europe/London').plus({ weeks: weeksAhead }).startOf('day');
  while (dt.weekday % 7 !== weekday) dt = dt.plus({ days: 1 });
  const [h, m] = localTime.split(':').map(Number);
  return dt.set({ hour: h, minute: m }).toUTC().toISO()!;
}

async function book(overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/appointments',
    headers: { ...agent, ...idem() },
    payload: {
      customerId: salon.customerIds.eleanor,
      serviceId: salon.serviceIds.cut,
      start: futureSlot(2, '10:00'),
      source: 'voice',
      ...overrides,
    },
  });
  if (res.statusCode !== 201) throw new Error(`booking failed: ${res.body}`);
  return body(res);
}

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

describe('cancellation', () => {
  it('cancels an appointment with plenty of notice and charges nothing', async () => {
    const appointment = await book();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/appointments/${appointment.id}/cancel`,
      headers: { ...agent, ...idem() },
      payload: { reason: 'Away that week' },
    });

    expect(res.statusCode).toBe(200);
    expect(body(res).status).toBe('cancelled');
    expect(body(res).cancellationFee).toBe('0.00');
  });

  it('explains the fee instead of refusing, when inside the notice window', async () => {
    // Seed a salon whose window is wide enough that any future booking is inside it.
    await resetDatabase();
    clearKeyCache();
    salon = await seedTestSalon({ cancellationWindowHours: 24 * 60 });
    const appointment = await book();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/appointments/${appointment.id}/cancel`,
      headers: { ...agent, ...idem() },
      payload: {},
    });

    const err = body(res).error;
    expect(err.code).toBe('CANCELLATION_WINDOW_PASSED');
    // Everything the agent needs to explain the charge and ask the caller.
    expect(err.details.fee).toBe('15.00');
    expect(err.details.currency).toBe('GBP');
    expect(err.details.feeApplies).toBe(true);
    expect(err.details.proceedWith).toBe('acknowledgeFee');
    expect(typeof err.details.hoursUntilAppointment).toBe('number');

    // The appointment must still stand — a refused cancellation cancels nothing.
    const check = await app.inject({ method: 'GET', url: `/v1/appointments/${appointment.id}`, headers: agent });
    expect(body(check).status).toBe('booked');
  });

  it('proceeds once the caller has acknowledged the fee, and records it', async () => {
    await resetDatabase();
    clearKeyCache();
    salon = await seedTestSalon({ cancellationWindowHours: 24 * 60 });
    const appointment = await book();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/appointments/${appointment.id}/cancel`,
      headers: { ...agent, ...idem() },
      payload: { acknowledgeFee: true, reason: 'Cannot make it' },
    });

    expect(res.statusCode).toBe(200);
    expect(body(res).status).toBe('cancelled');
    expect(body(res).cancellationFee).toBe('15.00');
  });

  it('refuses to cancel an appointment twice', async () => {
    const appointment = await book();
    await app.inject({
      method: 'POST',
      url: `/v1/appointments/${appointment.id}/cancel`,
      headers: { ...agent, ...idem() },
      payload: {},
    });
    const again = await app.inject({
      method: 'POST',
      url: `/v1/appointments/${appointment.id}/cancel`,
      headers: { ...agent, ...idem() },
      payload: {},
    });
    expect(body(again).error.code).toBe('APPOINTMENT_NOT_MODIFIABLE');
  });

  it('frees the slot for someone else once cancelled', async () => {
    const start = futureSlot(2, '10:00');
    const appointment = await book({ start });
    await app.inject({
      method: 'POST',
      url: `/v1/appointments/${appointment.id}/cancel`,
      headers: { ...agent, ...idem() },
      payload: {},
    });

    const rebooked = await app.inject({
      method: 'POST',
      url: '/v1/appointments',
      headers: { ...agent, ...idem() },
      payload: { customerId: salon.customerIds.marcus, serviceId: salon.serviceIds.cut, start, source: 'voice' },
    });
    expect(rebooked.statusCode).toBe(201);
  });
});

describe('reschedule', () => {
  it('moves an appointment and links the old row forward', async () => {
    const appointment = await book({ start: futureSlot(2, '10:00') });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/appointments/${appointment.id}/reschedule`,
      headers: { ...agent, ...idem() },
      payload: { start: futureSlot(3, '14:00') },
    });

    expect(res.statusCode).toBe(200);
    const moved = body(res);
    expect(moved.id).not.toBe(appointment.id);
    expect(moved.status).toBe('booked');
    expect(moved.localTime).toBe('14:00');
    expect(moved.rescheduledFromId).toBe(appointment.id);

    // The history stays navigable from either end.
    const original = await app.inject({ method: 'GET', url: `/v1/appointments/${appointment.id}`, headers: agent });
    expect(body(original).status).toBe('rescheduled');
    expect(body(original).rescheduledToId).toBe(moved.id);
  });

  it('can move an appointment by a few minutes without colliding with itself', async () => {
    // The old row must leave the exclusion constraint's predicate before the new
    // row is inserted, or overlapping moves would be impossible.
    const appointment = await book({ start: futureSlot(2, '10:00') });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/appointments/${appointment.id}/reschedule`,
      headers: { ...agent, ...idem() },
      payload: { start: futureSlot(2, '10:15') },
    });
    expect(res.statusCode).toBe(200);
    expect(body(res).localTime).toBe('10:15');
  });

  it('changes the service in the same move', async () => {
    const appointment = await book();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/appointments/${appointment.id}/reschedule`,
      headers: { ...agent, ...idem() },
      payload: { start: futureSlot(4, '10:00'), serviceId: salon.serviceIds.colour },
    });
    expect(res.statusCode).toBe(200);
    expect(body(res).service.name).toBe('Full Head Colour');
    expect(body(res).priceAtBooking).toBe('110.00');
  });

  /**
   * The "never leaves an orphaned cancellation" requirement, tested directly.
   */
  it('leaves the original appointment intact when the new slot is taken', async () => {
    const taken = futureSlot(4, '11:00');
    await book({ customerId: salon.customerIds.marcus, serviceId: salon.serviceIds.colour, start: taken });
    const mine = await book({ start: futureSlot(2, '10:00') });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/appointments/${mine.id}/reschedule`,
      headers: { ...agent, ...idem() },
      payload: { start: taken, serviceId: salon.serviceIds.colour },
    });

    expect(body(res).error.code).toBe('SLOT_UNAVAILABLE');

    // The customer must not have lost their original slot in the attempt.
    const check = await app.inject({ method: 'GET', url: `/v1/appointments/${mine.id}`, headers: agent });
    expect(body(check).status).toBe('booked');
    expect(body(check).rescheduledToId).toBeNull();

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM appointments WHERE status = 'booked'`);
    expect(rows[0].n).toBe(2);
  });
});

describe('availability', () => {
  it('resolves a natural-language window and returns bookable slots', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/availability?serviceId=${salon.serviceIds.cut}&timeExpression=${encodeURIComponent('next tuesday afternoon')}`,
      headers: agent,
    });

    expect(res.statusCode).toBe(200);
    const data = body(res);
    expect(data.requestedWindow.interpretation).toMatch(/afternoon/);
    expect(data.slots.length).toBeGreaterThan(0);
    // Every slot must be speakable without the agent doing date maths.
    expect(data.slots[0]).toHaveProperty('label');
    expect(data.slots[0].localTime >= '12:00').toBe(true);
  });

  it('asks rather than guesses when the phrase is not understandable', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/availability?serviceId=${salon.serviceIds.cut}&timeExpression=whenever`,
      headers: agent,
    });
    expect(body(res).error.code).toBe('UNPARSEABLE_TIME_EXPRESSION');
    expect(body(res).error.details.hint).toBeTruthy();
  });

  it('offers alternatives on a day the salon is shut', async () => {
    const sunday = futureSlot(0, '10:00');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/availability?serviceId=${salon.serviceIds.cut}&from=${sunday}&to=${futureSlot(0, '18:00')}`,
      headers: agent,
    });

    const data = body(res);
    expect(data.slots).toHaveLength(0);
    expect(data.unavailableReason).toMatch(/closed/i);
    expect(data.alternatives.length).toBeGreaterThan(0);
  });

  it('never offers a slot that the booking endpoint would then refuse', () => {
    // Availability and booking share one implementation of "is this slot legal".
    // This asserts they have not drifted: re-query after each booking, take
    // whatever is offered, and book it. A stale or over-generous availability
    // list would surface here as a 409.
    return (async () => {
      for (let round = 0; round < 3; round += 1) {
        const listed = await app.inject({
          method: 'GET',
          url: `/v1/availability?serviceId=${salon.serviceIds.colour}&timeExpression=${encodeURIComponent('next thursday')}&limit=5`,
          headers: agent,
        });
        const slots = body(listed).slots;
        expect(slots.length).toBeGreaterThan(0);

        const slot = slots[0];
        const booked = await app.inject({
          method: 'POST',
          url: '/v1/appointments',
          headers: { ...agent, ...idem() },
          payload: {
            customer: { firstName: `Probe${round}`, phone: `+44770091100${round}` },
            serviceId: salon.serviceIds.colour,
            start: slot.start,
            staffId: slot.staffId,
            source: 'voice',
          },
        });
        expect(booked.statusCode).toBe(201);
        // ...and the slot just taken must disappear from the next listing.
        expect(body(booked).start).toBe(slot.start);
      }
    })();
  });
});

describe('privacy and tenancy', () => {
  it('withholds surname, email and staff notes from the voice agent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/customers/${salon.customerIds.eleanor}`,
      headers: agent,
    });

    const customer = body(res);
    expect(customer.firstName).toBe('Eleanor');
    // These are withheld by the serializer, so the agent cannot read them aloud
    // even if it were asked to.
    expect(customer).not.toHaveProperty('notes');
    expect(customer).not.toHaveProperty('email');
    expect(customer).not.toHaveProperty('lastName');
    expect(JSON.stringify(customer)).not.toContain('ammonia');
  });

  it('gives staff the full record', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/customers/${salon.customerIds.eleanor}`,
      headers: staff,
    });
    expect(body(res).notes).toContain('ammonia');
    expect(body(res).lastName).toBe('Whitfield');
  });

  it('refuses to let the agent write staff notes', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/customers/${salon.customerIds.eleanor}`,
      headers: agent,
      payload: { notes: 'injected by the agent' },
    });
    expect(body(res).error.code).toBe('FORBIDDEN_SCOPE');
  });

  it('cannot reach another salon data with a valid credential', async () => {
    await seedOtherSalon();
    const appointment = await book();

    for (const [url, expected] of [
      [`/v1/customers/${salon.customerIds.eleanor}`, 'CUSTOMER_NOT_FOUND'],
      [`/v1/appointments/${appointment.id}`, 'APPOINTMENT_NOT_FOUND'],
      [`/v1/services/${salon.serviceIds.cut}`, 'SERVICE_NOT_FOUND'],
    ] as const) {
      const res = await app.inject({ method: 'GET', url, headers: other });
      expect(body(res).error.code).toBe(expected);
    }

    // ...and its listings are empty rather than leaking a neighbour's diary.
    const list = await app.inject({ method: 'GET', url: '/v1/appointments', headers: other });
    expect(body(list).data).toHaveLength(0);
  });

  it('rejects an unknown or revoked credential', async () => {
    const bad = await app.inject({ method: 'GET', url: '/v1/services', headers: { authorization: 'Bearer sk_agent_nope' } });
    expect(body(bad).error.code).toBe('UNAUTHENTICATED');

    await pool.query(`UPDATE api_keys SET revoked_at = now() WHERE key_prefix = $1`, [AGENT_KEY.slice(0, 16)]);
    clearKeyCache();
    const revoked = await app.inject({ method: 'GET', url: '/v1/services', headers: agent });
    expect(body(revoked).error.code).toBe('UNAUTHENTICATED');
  });
});

describe('appointment lookup', () => {
  it('returns every upcoming appointment for a caller, so the agent can disambiguate', async () => {
    // Two live appointments for one person is the situation that must never be
    // resolved by guessing.
    await book({ start: futureSlot(2, '10:00') });
    await book({ start: futureSlot(3, '15:00') });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/appointments?phone=${encodeURIComponent('07700900001')}&upcomingOnly=true`,
      headers: agent,
    });

    expect(body(res).data).toHaveLength(2);
    expect(body(res).pagination.total).toBe(2);
  });

  it('excludes cancelled appointments from an upcoming lookup', async () => {
    const appointment = await book({ start: futureSlot(2, '10:00') });
    await book({ start: futureSlot(3, '15:00') });
    await app.inject({
      method: 'POST',
      url: `/v1/appointments/${appointment.id}/cancel`,
      headers: { ...agent, ...idem() },
      payload: {},
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/appointments?customerId=${salon.customerIds.eleanor}&upcomingOnly=true`,
      headers: agent,
    });
    expect(body(res).data).toHaveLength(1);
  });
});
