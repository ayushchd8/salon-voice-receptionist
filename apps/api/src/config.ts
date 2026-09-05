import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env from the repo root before anything reads process.env. Node's
// built-in loader is used rather than dotenv so the dependency list stays
// honest about what is actually required at runtime.
const envPath = resolve(process.cwd(), '.env');
const rootEnvPath = resolve(process.cwd(), '../../.env');
for (const candidate of [envPath, rootEnvPath]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required — see .env.example'),
  TEST_DATABASE_URL: z.string().optional(),

  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),

  /** See the comment in db/pool.ts — must exceed same-slot booking concurrency. */
  DB_POOL_MAX: z.coerce.number().int().min(4).max(100).default(20),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  IDEMPOTENCY_STALE_SECONDS: z.coerce.number().int().positive().default(60),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().positive().default(24),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),

  SEED_AGENT_API_KEY: z.string().default('sk_agent_dev_0000000000000000000000000000'),
  SEED_STAFF_API_KEY: z.string().default('sk_staff_dev_0000000000000000000000000000'),

  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env.`);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  isTest: parsed.data.NODE_ENV === 'test',
  isProduction: parsed.data.NODE_ENV === 'production',
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  /** Test runs point at a separate database so integration tests can drop it. */
  databaseUrl:
    parsed.data.NODE_ENV === 'test' && parsed.data.TEST_DATABASE_URL
      ? parsed.data.TEST_DATABASE_URL
      : parsed.data.DATABASE_URL,
} as const;

export type Config = typeof config;
