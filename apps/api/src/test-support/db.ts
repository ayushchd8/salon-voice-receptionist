/**
 * Integration-test harness.
 *
 * Tests run against a real Postgres, not a mock. The behaviour under test —
 * the exclusion constraint that prevents double-booking, transactional
 * rollback on a failed reschedule, ON CONFLICT idempotency reservation — is
 * behaviour *of Postgres*. Mocking the database would leave those tests
 * asserting that the mock does what the mock was told to do.
 */
import pg from 'pg';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { hashApiKey } from '../lib/hash.js';
import { AGENT_SCOPES, STAFF_SCOPES } from '@salon/contracts';

export const AGENT_KEY = 'sk_agent_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const STAFF_KEY = 'sk_staff_test_bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
export const OTHER_SALON_KEY = 'sk_staff_test_cccccccccccccccccccccccccccc';

/** Create the test database if it does not exist, then bring the schema up to date. */
export async function prepareTestDatabase(): Promise<void> {
  const url = new URL(config.databaseUrl);
  const dbName = url.pathname.slice(1);

  const admin = new pg.Client({ connectionString: new URL('/postgres', url).toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rowCount === 0) await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  await migrate({ silent: true });
}

const TABLES = [
  'idempotency_keys',
  'call_summaries',
  'appointments',
  'call_logs',
  'staff_working_hours',
  'staff_services',
  'customers',
  'staff_members',
  'services',
  'booking_policies',
  'closed_dates',
  'business_hours',
  'api_keys',
  'salons',
];

export async function resetDatabase(): Promise<void> {
  await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

export interface TestSalon {
  salonId: string;
  timezone: string;
  serviceIds: { cut: string; colour: string; consult: string; retired: string };
  staffIds: { priya: string; sam: string };
  customerIds: { eleanor: string; marcus: string };
}

/**
 * A deterministic fixture salon: open Mon–Sat, two stylists with different
 * competencies, two customers. Deliberately small — tests assert on specific
 * rows, so every row here exists because some test needs it.
 */
export async function seedTestSalon(options: { minLeadMinutes?: number; cancellationWindowHours?: number } = {}): Promise<TestSalon> {
  const { rows: [salon] } = await pool.query<{ id: string }>(
    `INSERT INTO salons (name, slug, timezone, phone) VALUES ($1,$2,$3,$4) RETURNING id`,
    ['Test Salon', `test-salon-${Date.now()}`, 'Europe/London', '+442079460100'],
  );
  const salonId = salon!.id;

  for (let dow = 0; dow < 7; dow += 1) {
    const closed = dow === 0;
    await pool.query(
      `INSERT INTO business_hours (salon_id, day_of_week, is_closed, open_time, close_time) VALUES ($1,$2,$3,$4,$5)`,
      [salonId, dow, closed, closed ? null : '09:00', closed ? null : '18:00'],
    );
  }

  await pool.query(
    `INSERT INTO booking_policies
       (salon_id, min_lead_minutes, max_advance_days, cancellation_window_hours,
        late_cancellation_fee, no_show_fee, slot_granularity_minutes,
        max_active_appointments_per_customer, currency)
     VALUES ($1,$2,90,$3,'15.00','25.00',15,5,'GBP')`,
    [salonId, options.minLeadMinutes ?? 0, options.cancellationWindowHours ?? 24],
  );

  const service = async (name: string, duration: number, bufferAfter: number, price: string, active = true) => {
    const { rows: [row] } = await pool.query<{ id: string }>(
      `INSERT INTO services (salon_id, name, category, duration_minutes, buffer_after_minutes, price, currency, active)
       VALUES ($1,$2,'hair',$3,$4,$5,'GBP',$6) RETURNING id`,
      [salonId, name, duration, bufferAfter, price, active],
    );
    return row!.id;
  };
  const serviceIds = {
    cut: await service('Cut & Blow Dry', 60, 15, '55.00'),
    colour: await service('Full Head Colour', 120, 30, '110.00'),
    consult: await service('Consultation', 15, 0, '0.00'),
    retired: await service('Perm', 120, 20, '95.00', false),
  };

  const staff = async (name: string, serviceIdList: string[], hours?: Array<[number, string, string]>) => {
    const { rows: [row] } = await pool.query<{ id: string }>(
      `INSERT INTO staff_members (salon_id, name) VALUES ($1,$2) RETURNING id`,
      [salonId, name],
    );
    for (const serviceId of serviceIdList) {
      await pool.query(`INSERT INTO staff_services (staff_id, service_id) VALUES ($1,$2)`, [row!.id, serviceId]);
    }
    for (const [dow, start, end] of hours ?? []) {
      await pool.query(
        `INSERT INTO staff_working_hours (staff_id, day_of_week, start_time, end_time) VALUES ($1,$2,$3,$4)`,
        [row!.id, dow, start, end],
      );
    }
    return row!.id;
  };
  const staffIds = {
    // Priya: no competency rows and no shift rows => everything, all hours.
    priya: await staff('Priya', []),
    // Sam: cuts only, and only Monday to Wednesday.
    sam: await staff('Sam', [serviceIds.cut], [[1, '09:00', '17:00'], [2, '09:00', '17:00'], [3, '09:00', '17:00']]),
  };

  const customer = async (first: string, last: string, phone: string, notes: string | null) => {
    const { rows: [row] } = await pool.query<{ id: string }>(
      `INSERT INTO customers (salon_id, first_name, last_name, phone, email, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [salonId, first, last, phone, `${first.toLowerCase()}@example.com`, notes],
    );
    return row!.id;
  };
  const customerIds = {
    eleanor: await customer('Eleanor', 'Whitfield', '+447700900001', 'Allergic to ammonia. Never read aloud.'),
    marcus: await customer('Marcus', 'Bell', '+447700900002', null),
  };

  for (const [key, scopes, name] of [
    [AGENT_KEY, AGENT_SCOPES, 'agent'],
    [STAFF_KEY, STAFF_SCOPES, 'staff'],
  ] as const) {
    await pool.query(
      `INSERT INTO api_keys (salon_id, name, key_hash, key_prefix, scopes) VALUES ($1,$2,$3,$4,$5)`,
      [salonId, name, hashApiKey(key), key.slice(0, 16), scopes],
    );
  }

  return { salonId, timezone: 'Europe/London', serviceIds, staffIds, customerIds };
}

/** A second salon, for proving that tenancy isolation actually holds. */
export async function seedOtherSalon(): Promise<{ salonId: string }> {
  const { rows: [salon] } = await pool.query<{ id: string }>(
    `INSERT INTO salons (name, slug, timezone) VALUES ('Other Salon', $1, 'America/New_York') RETURNING id`,
    [`other-salon-${Date.now()}`],
  );
  const salonId = salon!.id;
  await pool.query(`INSERT INTO booking_policies (salon_id) VALUES ($1)`, [salonId]);
  for (let dow = 0; dow < 7; dow += 1) {
    await pool.query(
      `INSERT INTO business_hours (salon_id, day_of_week, is_closed, open_time, close_time) VALUES ($1,$2,false,'09:00','18:00')`,
      [salonId, dow],
    );
  }
  await pool.query(
    `INSERT INTO api_keys (salon_id, name, key_hash, key_prefix, scopes) VALUES ($1,'staff',$2,$3,$4)`,
    [salonId, hashApiKey(OTHER_SALON_KEY), OTHER_SALON_KEY.slice(0, 16), STAFF_SCOPES],
  );
  return { salonId };
}
