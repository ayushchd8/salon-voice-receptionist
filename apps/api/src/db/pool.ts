import pg from 'pg';
import { config } from '../config.js';

// Postgres returns numeric/decimal as string by default to avoid precision
// loss. Money in this system is numeric(10,2) and is carried as a string all
// the way to the API boundary, where it is formatted — never parsed into a
// float. The int8 parser is left alone for the same reason.

/**
 * Pool size must exceed the number of callers who might contend for the *same
 * slot* at once.
 *
 * Concurrent bookings of one slot are serialised by the exclusion constraint,
 * and a blocked INSERT holds its connection while it waits its turn. So N
 * simultaneous attempts on one slot occupy N connections for the duration. A
 * pool smaller than that starves the remaining requests, which then fail on
 * `connectionTimeoutMillis` with a 500 rather than the SLOT_UNAVAILABLE they
 * should have received.
 *
 * This was not theoretical: the eight-way race test was given a pool of 5 and
 * failed intermittently for exactly this reason — the concurrency guarantee was
 * fine, the harness was starving it. See SCALING.md for the production shape.
 */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
  // A single slow query must never hold a connection forever.
  statement_timeout: 15_000,
  query_timeout: 15_000,
});

pool.on('error', (err) => {
  console.error('unexpected idle client error', err);
});

export type PoolClient = pg.PoolClient;

/**
 * Runs `fn` inside a transaction, rolling back on any throw.
 *
 * Every multi-statement write in this codebase goes through here rather than
 * hand-rolling BEGIN/COMMIT, so a `return` inside a handler cannot leak an
 * open transaction back into the pool.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; releasing it is all we can do.
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
