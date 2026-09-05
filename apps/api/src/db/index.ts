import { drizzle } from 'drizzle-orm/node-postgres';
import { pool } from './pool.js';
import * as schema from './schema.js';

export const db = drizzle(pool, { schema });

export type Database = typeof db;
/** The transaction-scoped handle passed to `db.transaction(async (tx) => …)`. */
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Either handle — repositories accept both so they compose inside transactions. */
export type Executor = Database | Transaction;

export * as schema from './schema.js';
export { pool, withTransaction } from './pool.js';
