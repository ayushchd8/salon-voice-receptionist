/**
 * A controllable stand-in for the CRM API, served over real HTTP.
 *
 * Why a fake here, when the CRM has forty integration tests against real
 * Postgres? Because these tests are about the *agent*: that a retry reuses its
 * idempotency key, that a timeout is reported as uncertain rather than failed,
 * that a guard suppresses a false claim of success. Those need a server that
 * can be told to time out, to fail once and then succeed, or to return a
 * conflict on demand — none of which a real database will do to order.
 *
 * It is a real HTTP server, not a mocked `fetch`, so the agent's actual
 * timeout, retry and idempotency-header code paths are the ones under test.
 * Availability and time resolution are computed with the genuine engine from
 * @salon/core, so the fake cannot drift into answering more helpfully than
 * the real thing.
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import {
  computeAvailability,
  computeBlockRange,
  findAlternatives,
  resolveTimeExpression,
  speakableLabel,
  type BusyBlock,
  type SchedulingContext,
  type ServiceDef,
  type StaffDef,
} from '@salon/core';

const TZ = 'Europe/London';

const SERVICES: Array<ServiceDef & { price: string; currency: string; category: string; description: string }> = [
  { id: 'svc-cut', name: 'Cut & Blow Dry', durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 15, active: true, price: '55.00', currency: 'GBP', category: 'hair', description: 'Consultation, cut and finish.' },
  { id: 'svc-colour', name: 'Full Head Colour', durationMinutes: 120, bufferBeforeMinutes: 0, bufferAfterMinutes: 30, active: true, price: '110.00', currency: 'GBP', category: 'colour', description: 'Single-process colour.' },
  // Enough services that the menu overflows what the agent reads aloud, so
  // "what else do you have?" has something to answer with.
  { id: 'svc-blowdry', name: 'Blow Dry', durationMinutes: 45, bufferBeforeMinutes: 0, bufferAfterMinutes: 10, active: true, price: '38.00', currency: 'GBP', category: 'hair', description: 'Wash and style.' },
  { id: 'svc-mens', name: "Men's Cut", durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 10, active: true, price: '32.00', currency: 'GBP', category: 'hair', description: 'Clipper or scissor cut.' },
  { id: 'svc-keratin', name: 'Keratin Treatment', durationMinutes: 180, bufferBeforeMinutes: 0, bufferAfterMinutes: 30, active: true, price: '220.00', currency: 'GBP', category: 'treatment', description: 'Smoothing treatment.' },
];

const STAFF: StaffDef[] = [
  { id: 'staff-priya', name: 'Priya', active: true, serviceIds: [], workingHours: [] },
];

const CONTEXT: SchedulingContext = {
  salonId: 'salon-test',
  timezone: TZ,
  businessHours: [
    { dayOfWeek: 0, isClosed: true, openTime: null, closeTime: null },
    ...[1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek, isClosed: false, openTime: '09:00:00', closeTime: '18:00:00',
    })),
  ],
  closedDates: [],
  policy: {
    minLeadMinutes: 0,
    maxAdvanceDays: 90,
    cancellationWindowHours: 24,
    lateCancellationFee: '15.00',
    noShowFee: '25.00',
    slotGranularityMinutes: 15,
    allowDoubleBooking: false,
    maxActiveAppointmentsPerCustomer: 5,
    currency: 'GBP',
  },
};

interface StoredAppointment {
  id: string;
  serviceId: string;
  staffId: string;
  customerId: string;
  start: string;
  end: string;
  blockStart: string;
  blockEnd: string;
  status: string;
}

/** Knobs the tests turn to produce specific failures. */
export interface FaultConfig {
  /** Endpoint substring -> how many times to fail before succeeding. */
  failTimes: Map<string, { count: number; status: number; code: string; message: string }>;
  /** Endpoint substring -> hang for this long, to trigger the client timeout. */
  delayMs: Map<string, number>;
  /** Make the requested slot unavailable, whatever the diary says. */
  forceSlotUnavailable: boolean;
}

export class FakeCrm {
  private server: Server | null = null;
  private port = 0;

  readonly appointments = new Map<string, StoredAppointment>();
  readonly callSummaries: Array<Record<string, unknown>> = [];
  /** Transcript as last written mid-call, keyed by call id. */
  readonly callTranscripts = new Map<string, unknown[]>();
  readonly endedCalls = new Set<string>();
  readonly idempotencyKeys = new Map<string, { body: string; response: unknown; status: number }>();
  /** Every write request seen, so a test can assert what was actually sent. */
  readonly writeLog: Array<{ path: string; idempotencyKey: string | null; body: unknown }> = [];

  readonly faults: FaultConfig = {
    failTimes: new Map(),
    delayMs: new Map(),
    forceSlotUnavailable: false,
  };

  private customers = new Map<string, { id: string; firstName: string; phone: string }>();

  constructor() {
    this.customers.set('+447700900001', { id: 'cus-eleanor', firstName: 'Eleanor', phone: '+447700900001' });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Seed an existing appointment, e.g. to create an ambiguous cancellation. */
  addAppointment(daysAhead: number, hour: number, serviceId = 'svc-cut', customerId = 'cus-eleanor'): StoredAppointment {
    const service = SERVICES.find((s) => s.id === serviceId)!;
    let day = DateTime.now().setZone(TZ).plus({ days: daysAhead }).startOf('day');
    if (day.weekday % 7 === 0) day = day.plus({ days: 1 }); // never a Sunday
    const start = day.set({ hour, minute: 0 }).toUTC().toISO()!;
    const range = computeBlockRange(start, service);

    const appointment: StoredAppointment = {
      id: `apt-${randomUUID().slice(0, 8)}`,
      serviceId, staffId: 'staff-priya', customerId,
      start: range.start, end: range.end, blockStart: range.blockStart, blockEnd: range.blockEnd,
      status: 'booked',
    };
    this.appointments.set(appointment.id, appointment);
    return appointment;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        void this.handle(req.url ?? '', req.method ?? 'GET', Buffer.concat(chunks).toString(), req.headers, res);
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        this.port = typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  reset(): void {
    this.appointments.clear();
    this.callSummaries.length = 0;
    this.callTranscripts.clear();
    this.endedCalls.clear();
    this.idempotencyKeys.clear();
    this.writeLog.length = 0;
    this.faults.failTimes.clear();
    this.faults.delayMs.clear();
    this.faults.forceSlotUnavailable = false;
  }

  private async handle(
    url: string,
    method: string,
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const [path, query = ''] = url.split('?');
    const params = new URLSearchParams(query);
    const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    const idempotencyKey = (headers['idempotency-key'] as string | undefined) ?? null;

    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const error = (status: number, code: string, message: string, details?: unknown) =>
      send(status, { error: { code, message, ...(details ? { details } : {}) } });

    // Logged before the fault checks, so a test can see the attempts that were
    // rejected — which is the whole point when asserting retry behaviour.
    if (method === 'POST') this.writeLog.push({ path: path!, idempotencyKey, body });

    // ── injected faults ───────────────────────────────────────────────────────
    for (const [fragment, ms] of this.faults.delayMs) {
      if (path!.includes(fragment)) {
        // Long enough that the agent's own timeout fires first.
        await new Promise((r) => setTimeout(r, ms));
      }
    }
    for (const [fragment, fault] of this.faults.failTimes) {
      if (path!.includes(fragment) && fault.count > 0) {
        fault.count -= 1;
        error(fault.status, fault.code, fault.message);
        return;
      }
    }

    // ── idempotency replay ────────────────────────────────────────────────────
    if (idempotencyKey && method === 'POST') {
      const seen = this.idempotencyKeys.get(idempotencyKey);
      if (seen) {
        // Key-order-independent, matching the real API's stable request hash —
        // otherwise a re-serialised identical body would look like a new one.
        if (seen.body !== stableStringify(body)) {
          error(422, 'IDEMPOTENCY_KEY_REUSED', 'Key reused for a different request.');
          return;
        }
        send(seen.status, seen.response);
        return;
      }
    }

    const remember = (status: number, payload: unknown) => {
      if (idempotencyKey) this.idempotencyKeys.set(idempotencyKey, { body: stableStringify(body), response: payload, status });
      send(status, payload);
    };

    // ── configuration ─────────────────────────────────────────────────────────
    if (path === '/v1/salon') {
      return send(200, {
        id: 'salon-test', name: 'Test Salon', slug: 'test-salon', timezone: TZ,
        phone: '+442079460100', email: null, address: null,
      });
    }
    if (path === '/v1/services') {
      return send(200, { data: SERVICES.map((s) => ({ ...s, description: s.description })) });
    }
    if (path === '/v1/staff') {
      return send(200, {
        data: STAFF.map((s) => ({ ...s, role: null, isDefaultResource: false })),
      });
    }
    if (path === '/v1/business-hours') {
      return send(200, {
        timezone: TZ,
        week: CONTEXT.businessHours.map((h) => ({
          dayOfWeek: h.dayOfWeek, isClosed: h.isClosed, openTime: h.openTime, closeTime: h.closeTime,
        })),
        closedDates: [],
      });
    }
    if (path === '/v1/booking-policy') return send(200, CONTEXT.policy);

    // ── customers ─────────────────────────────────────────────────────────────
    if (path === '/v1/customers/search') {
      const phone = params.get('phone');
      const found = phone ? this.customers.get(phone) : undefined;
      return send(200, {
        data: found ? [{ ...found, isReturning: true }] : [],
        pagination: { limit: 50, offset: 0, total: found ? 1 : 0, hasMore: false },
      });
    }

    // ── time and availability, computed with the real engine ──────────────────
    if (path === '/v1/resolve-time') {
      const expression = params.get('expression') ?? '';
      const resolved = resolveTimeExpression(expression, { now: new Date().toISOString(), timezone: TZ });
      if (!resolved) return error(422, 'UNPARSEABLE_TIME_EXPRESSION', `Could not parse "${expression}".`);
      return send(200, { expression, ...resolved, timezone: TZ });
    }

    if (path === '/v1/availability') {
      const serviceId = params.get('serviceId')!;
      const service = SERVICES.find((s) => s.id === serviceId);
      if (!service) return error(404, 'SERVICE_NOT_FOUND', 'No such service.');

      const now = new Date().toISOString();
      const expression = params.get('timeExpression');
      const window = expression
        ? resolveTimeExpression(expression, { now, timezone: TZ })
        : { from: params.get('from')!, to: params.get('to')!, interpretation: 'that window', isBroad: false };
      if (!window) return error(422, 'UNPARSEABLE_TIME_EXPRESSION', `Could not parse "${expression}".`);

      const request = {
        context: CONTEXT, service, staff: STAFF, busy: this.busyBlocks(),
        from: window.from, to: window.to, now, limit: 6,
      };
      const slots = this.faults.forceSlotUnavailable ? [] : computeAvailability(request);
      const alternatives = slots.length === 0 ? findAlternatives(request, 3) : [];

      return send(200, {
        timezone: TZ,
        service: { id: service.id, name: service.name, durationMinutes: service.durationMinutes },
        requestedWindow: { from: window.from, to: window.to, interpretation: window.interpretation },
        slots,
        alternatives,
        unavailableReason: slots.length === 0 ? 'Fully booked in the window requested.' : null,
      });
    }

    // ── appointments ──────────────────────────────────────────────────────────
    if (path === '/v1/appointments' && method === 'GET') {
      const live = [...this.appointments.values()].filter((a) => a.status === 'booked');
      return send(200, {
        data: live.map((a) => this.serialize(a)),
        pagination: { limit: 20, offset: 0, total: live.length, hasMore: false },
      });
    }

    if (path === '/v1/appointments' && method === 'POST') {
      if (!idempotencyKey) return error(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.');

      const serviceId = body.serviceId as string;
      const service = SERVICES.find((s) => s.id === serviceId);
      if (!service) return error(404, 'SERVICE_NOT_FOUND', 'No such service.');

      const range = computeBlockRange(body.start as string, service);
      const clash = [...this.appointments.values()].some(
        (a) => a.status === 'booked' && a.blockStart < range.blockEnd && range.blockStart < a.blockEnd,
      );
      if (clash || this.faults.forceSlotUnavailable) {
        const alternatives = findAlternatives(
          {
            context: CONTEXT, service, staff: STAFF, busy: this.busyBlocks(),
            from: range.start, to: range.end, now: new Date().toISOString(), limit: 20,
          },
          3,
        );
        return error(409, 'SLOT_UNAVAILABLE', 'That time was just taken.', {
          requestedStart: range.start, alternatives,
        });
      }

      const appointment: StoredAppointment = {
        id: `apt-${randomUUID().slice(0, 8)}`,
        serviceId, staffId: (body.staffId as string) ?? 'staff-priya',
        customerId: 'cus-eleanor',
        start: range.start, end: range.end, blockStart: range.blockStart, blockEnd: range.blockEnd,
        status: 'booked',
      };
      this.appointments.set(appointment.id, appointment);
      return remember(201, this.serialize(appointment));
    }

    const cancelMatch = /^\/v1\/appointments\/([^/]+)\/cancel$/.exec(path!);
    if (cancelMatch && method === 'POST') {
      if (!idempotencyKey) return error(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.');
      const appointment = this.appointments.get(cancelMatch[1]!);
      if (!appointment) return error(404, 'APPOINTMENT_NOT_FOUND', 'No such appointment.');
      appointment.status = 'cancelled';
      return remember(200, this.serialize(appointment));
    }

    const rescheduleMatch = /^\/v1\/appointments\/([^/]+)\/reschedule$/.exec(path!);
    if (rescheduleMatch && method === 'POST') {
      if (!idempotencyKey) return error(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.');
      const original = this.appointments.get(rescheduleMatch[1]!);
      if (!original) return error(404, 'APPOINTMENT_NOT_FOUND', 'No such appointment.');

      const service = SERVICES.find((s) => s.id === ((body.serviceId as string) ?? original.serviceId))!;
      const range = computeBlockRange(body.start as string, service);
      original.status = 'rescheduled';

      const moved: StoredAppointment = {
        ...original, id: `apt-${randomUUID().slice(0, 8)}`, serviceId: service.id,
        start: range.start, end: range.end, blockStart: range.blockStart, blockEnd: range.blockEnd,
        status: 'booked',
      };
      this.appointments.set(moved.id, moved);
      return remember(200, this.serialize(moved));
    }

    // ── call records ──────────────────────────────────────────────────────────
    if (path === '/v1/calls' && method === 'POST') {
      return send(201, { id: `call-${randomUUID().slice(0, 8)}` });
    }
    const patchMatch = /^\/v1\/calls\/([^/]+)$/.exec(path!);
    if (patchMatch && method === 'PATCH') {
      this.callTranscripts.set(patchMatch[1]!, (body.transcript as unknown[]) ?? []);
      return send(200, { id: patchMatch[1], transcript: body.transcript });
    }
    if (/^\/v1\/calls\/[^/]+\/end$/.test(path!)) {
      this.endedCalls.add(path!.split('/')[3]!);
      return send(200, { ok: true });
    }
    if (path === '/v1/call-summaries' && method === 'POST') {
      this.callSummaries.push(body);
      return send(201, { id: 'summary-1', ...body });
    }

    return error(404, 'NOT_FOUND', `No route for ${method} ${path}`);
  }

  private busyBlocks(): BusyBlock[] {
    return [...this.appointments.values()]
      .filter((a) => a.status === 'booked')
      .map((a) => ({ staffId: a.staffId, blockStart: a.blockStart, blockEnd: a.blockEnd, appointmentId: a.id }));
  }

  private serialize(a: StoredAppointment) {
    const service = SERVICES.find((s) => s.id === a.serviceId)!;
    const local = DateTime.fromISO(a.start, { zone: TZ });
    return {
      id: a.id,
      status: a.status,
      source: 'voice',
      start: a.start,
      end: a.end,
      localDate: local.toFormat('yyyy-MM-dd'),
      localTime: local.toFormat('HH:mm'),
      label: speakableLabel(a.start, TZ, new Date().toISOString()),
      service: { id: service.id, name: service.name, durationMinutes: service.durationMinutes },
      staff: { id: a.staffId, name: 'Priya' },
      customer: { id: a.customerId, firstName: 'Eleanor', phone: '+447700900001', isReturning: true },
      priceAtBooking: service.price,
      currency: 'GBP',
      notes: null,
      callId: null,
      rescheduledFromId: null,
      rescheduledToId: null,
      cancellationReason: null,
      cancellationFee: '0.00',
      cancelledAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}

/** Key-order-independent JSON, mirroring the CRM's request hashing. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(',')}}`;
}
