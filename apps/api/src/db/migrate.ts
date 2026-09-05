/**
 * Minimal forward-only migration runner.
 *
 * Deliberately hand-rolled rather than using `drizzle-kit generate`: the schema
 * depends on `EXCLUDE USING gist`, partial-predicate constraints, composite
 * foreign keys and trigger functions, none of which an ORM schema-differ
 * round-trips faithfully. Reviewable SQL is worth more here than generated SQL.
 *
 * Each file runs inside its own transaction, so a failed migration leaves no
 * partial schema behind. Applied files are recorded with a checksum; editing an
 * already-applied migration is a hard error rather than a silent no-op.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

function loadMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16) };
    });
}

export async function migrate(options: { silent?: boolean } = {}): Promise<number> {
  const log = options.silent ? () => {} : (msg: string) => console.log(msg);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows: applied } = await pool.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  );
  const appliedByName = new Map(applied.map((r) => [r.name, r.checksum]));

  const migrations = loadMigrations();
  let ran = 0;

  for (const migration of migrations) {
    const previous = appliedByName.get(migration.name);
    if (previous !== undefined) {
      if (previous !== migration.checksum) {
        throw new Error(
          `Migration ${migration.name} has changed since it was applied ` +
            `(${previous} -> ${migration.checksum}). Migrations are immutable; ` +
            `add a new one instead, or run \`pnpm db:reset\` in development.`,
        );
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
      await client.query('COMMIT');
      log(`  ✓ ${migration.name}`);
      ran += 1;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${migration.name} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }

  if (ran === 0) log('  (no pending migrations)');
  return ran;
}

// Only run when invoked directly (`pnpm migrate`), not when imported by tests.
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  console.log('Running migrations…');
  migrate()
    .then(async (ran) => {
      console.log(`Done — ${ran} migration(s) applied.`);
      await closePool();
    })
    .catch(async (err) => {
      console.error(err.message);
      await closePool();
      process.exit(1);
    });
}
