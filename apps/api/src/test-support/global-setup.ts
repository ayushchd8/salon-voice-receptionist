import { prepareTestDatabase } from './db.js';
import { closePool } from '../db/pool.js';

export async function setup(): Promise<void> {
  await prepareTestDatabase();
}

export async function teardown(): Promise<void> {
  await closePool();
}
