import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  AGENT_PORT: z.coerce.number().int().positive().default(4100),
  AGENT_HOST: z.string().default('127.0.0.1'),

  // The agent's only route into the CRM. Note the absence of DATABASE_URL —
  // this process has no database credentials at all, by design.
  CRM_API_URL: z.string().url().default('http://127.0.0.1:4000'),
  CRM_API_KEY: z.string().min(8),
  CRM_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  CRM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  LLM_PROVIDER: z.enum(['anthropic', 'scripted']).default('anthropic'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  LLM_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),

  STT_PROVIDER: z.enum(['browser', 'deepgram', 'mock']).default('browser'),
  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_MODEL: z.string().default('nova-2-phonecall'),

  TTS_PROVIDER: z.enum(['browser', 'cartesia', 'elevenlabs', 'mock']).default('browser'),
  CARTESIA_API_KEY: z.string().optional(),
  CARTESIA_VOICE_ID: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  PUBLIC_AGENT_WSS_URL: z.string().optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid agent configuration:\n${issues}\n\nCopy .env.example to .env.`);
  process.exit(1);
}

/**
 * Falls back to the scripted LLM when Anthropic is selected but no key is
 * present, so the demo and the test suite both run without credentials rather
 * than crashing at the first turn.
 */
const llmProvider =
  parsed.data.LLM_PROVIDER === 'anthropic' && !parsed.data.ANTHROPIC_API_KEY
    ? 'scripted'
    : parsed.data.LLM_PROVIDER;

export const config = {
  ...parsed.data,
  llmProvider,
  llmFellBack: llmProvider !== parsed.data.LLM_PROVIDER,
  isTest: parsed.data.NODE_ENV === 'test',
} as const;

export type Config = typeof config;
