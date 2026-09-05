#!/usr/bin/env node
// Blocks until the dockerised Postgres accepts connections, so `pnpm db:up`
// can be chained straight into `pnpm migrate` without a sleep guess.
import { execFileSync } from 'node:child_process';

const DEADLINE_MS = 60_000;
const started = Date.now();

process.stdout.write('waiting for postgres');
for (;;) {
  try {
    execFileSync('docker', ['compose', 'exec', '-T', 'db', 'pg_isready', '-U', 'salon', '-d', 'salon'], {
      stdio: 'ignore',
    });
    process.stdout.write(' ready\n');
    process.exit(0);
  } catch {
    if (Date.now() - started > DEADLINE_MS) {
      process.stdout.write('\n');
      console.error('postgres did not become ready within 60s. Is Docker running?');
      process.exit(1);
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 1000));
  }
}
