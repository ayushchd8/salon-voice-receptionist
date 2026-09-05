/**
 * Guards against drift between the two halves of the schema.
 *
 * The SQL migrations are authoritative for DDL; the Drizzle definitions are
 * authoritative for query types. That split is deliberate — an ORM differ will
 * not round-trip an `EXCLUDE USING gist` constraint — but it means the two can
 * disagree, and a disagreement surfaces as a runtime error in production
 * rather than a compile error here.
 *
 * So the schema is reflected out of `information_schema` and compared against
 * what Drizzle believes. Renaming a column in SQL without updating the TS
 * definition fails this test instead of a customer's booking.
 */
import { describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { pool } from './pool.js';
import * as schema from './schema.js';

interface ColumnRow {
  table_name: string;
  column_name: string;
  is_nullable: 'YES' | 'NO';
  data_type: string;
}

// Drizzle's own brand check, rather than a try/catch — it narrows correctly and
// will not silently skip a table whose config throws for some other reason.
// Widened to unknown[] first: Object.values gives a union of the specific table
// types, and a type predicate must narrow to a subtype of its parameter.
const TABLES = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableConfig(table));

describe('Drizzle schema matches the migrated database', () => {
  it('reflects at least the tables the application queries', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const actual = new Set(rows.map((r) => r.table_name));

    for (const table of TABLES) {
      expect(actual, `table "${table.name}" is declared in Drizzle`).toContain(table.name);
    }
  });

  it.each(TABLES.map((t) => [t.name, t] as const))(
    'every column of %s exists in the database with matching nullability',
    async (_name, table) => {
      const { rows } = await pool.query<ColumnRow>(
        `SELECT table_name, column_name, is_nullable, data_type
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [table.name],
      );
      const actual = new Map(rows.map((r) => [r.column_name, r]));

      for (const column of table.columns) {
        const found = actual.get(column.name);
        expect(found, `${table.name}.${column.name} exists in SQL`).toBeDefined();

        // A column Drizzle thinks is NOT NULL but the database allows to be
        // null produces `T` where the value can be `null` — the exact shape of
        // a "cannot read property of null" in production.
        const sqlNotNull = found!.is_nullable === 'NO';
        expect(
          sqlNotNull,
          `${table.name}.${column.name}: Drizzle says notNull=${column.notNull}, SQL says notNull=${sqlNotNull}`,
        ).toBe(column.notNull);
      }
    },
  );

  it('has no application table missing from the Drizzle definitions', async () => {
    // The reverse direction: a table added in SQL that nothing can query.
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const declared = new Set(TABLES.map((t) => t.name));
    // `schema_migrations` is the migrator's own bookkeeping and is queried with raw SQL.
    const undeclared = rows
      .map((r) => r.table_name)
      .filter((name) => !declared.has(name) && name !== 'schema_migrations');

    expect(undeclared).toEqual([]);
  });
});

describe('the constraints the design depends on actually exist', () => {
  it('has the no-overlap exclusion constraint on appointments', async () => {
    // The single most important line of DDL in the system.
    const { rows } = await pool.query<{ condef: string }>(
      `SELECT pg_get_constraintdef(oid) AS condef
         FROM pg_constraint
        WHERE conname = 'appointments_no_overlap'`,
    );
    expect(rows).toHaveLength(1);
    const definition = rows[0]!.condef;
    expect(definition).toContain('EXCLUDE USING gist');
    expect(definition).toContain('tstzrange');
    // Cancelled and rescheduled rows must fall outside it, or an appointment
    // could never be moved or its slot reused.
    expect(definition).toMatch(/WHERE.*status.*booked/s);
    expect(definition).toMatch(/NOT overbooked/);
  });

  it('has composite foreign keys that make cross-tenant references impossible', async () => {
    const { rows } = await pool.query<{ conname: string; condef: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS condef
         FROM pg_constraint
        WHERE conrelid = 'appointments'::regclass AND contype = 'f'`,
    );
    const byName = new Map(rows.map((r) => [r.conname, r.condef]));

    for (const name of ['appointments_customer_fk', 'appointments_service_fk', 'appointments_staff_fk']) {
      expect(byName.has(name), `${name} exists`).toBe(true);
      // Both columns in the key — that is what ties the child to the same salon.
      expect(byName.get(name)).toMatch(/FOREIGN KEY \([a-z_]+, salon_id\)/);
    }
  });

  it('enforces that a recorded failure explains itself', async () => {
    const { rows } = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'call_summaries'::regclass AND contype = 'c'`,
    );
    const names = rows.map((r) => r.conname);
    expect(names).toContain('call_summaries_failure_explained');
    expect(names).toContain('call_summaries_escalation_explained');
  });

  it('indexes the columns the hot queries filter on', async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const indexes = new Set(rows.map((r) => r.indexname));

    for (const expected of [
      'appointments_salon_start_idx',
      'appointments_salon_customer_idx',
      'customers_salon_phone_key',
      'call_summaries_escalated_idx',
      'idempotency_keys_expiry_idx',
    ]) {
      expect(indexes, `index ${expected}`).toContain(expected);
    }
  });
});
