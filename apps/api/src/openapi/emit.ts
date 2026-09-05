/**
 * Emit docs/openapi.json from the live route definitions.
 *
 * Generated from the same Zod schemas the handlers validate with, so the
 * published spec cannot describe a contract the server does not enforce.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app.js';
import { closePool } from '../db/pool.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/openapi.json');

const app = await buildApp();
await app.ready();

const spec = app.swagger();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(spec, null, 2)}\n`);

const paths = Object.keys((spec as { paths?: Record<string, unknown> }).paths ?? {});
console.log(`Wrote ${OUT}`);
console.log(`  ${paths.length} paths documented`);

await app.close();
await closePool();
