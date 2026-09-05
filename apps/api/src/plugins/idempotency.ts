import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, IdempotencyKeySchema } from '@salon/contracts';
import { pool } from '../db/pool.js';
import { hashRequest } from '../lib/hash.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Idempotency for state-changing endpoints.
 *
 * The failure this exists to prevent: the voice agent sends a booking, the
 * response is lost to a timeout, the agent retries, and the customer is booked
 * twice. With a key, the retry replays the original response instead.
 *
 * Two implementation details carry the weight:
 *
 *  1. **The reservation commits before the handler runs.** An uncommitted
 *     INSERT is invisible to other transactions, so reserving inside the
 *     business transaction would let a concurrent retry see no row and execute
 *     the booking a second time. Reserve, commit, then work.
 *
 *  2. **Only deterministic failures are stored.** Replaying a 422 is correct —
 *     the same request will fail the same way, and the agent should not retry
 *     it. Replaying a 500 or a timeout would be wrong: the agent retries
 *     precisely because it wants a fresh attempt, so the key is released.
 */

interface KeyRow {
  status: 'in_progress' | 'completed';
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
  updated_at: string;
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
}

function readKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(
      'IDEMPOTENCY_KEY_REQUIRED',
      'This endpoint requires an `Idempotency-Key` header so a retry cannot create a duplicate.',
      { header: 'Idempotency-Key' },
    );
  }
  const parsed = IdempotencyKeySchema.safeParse(raw.trim());
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', 'Malformed `Idempotency-Key` header.', {
      header: 'Idempotency-Key',
      reason: parsed.error.issues[0]?.message,
    });
  }
  return parsed.data;
}

export async function withIdempotency<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  endpoint: string,
  handler: () => Promise<IdempotentResult<T>>,
): Promise<T> {
  const key = readKey(request);
  const salonId = request.principal.salonId;
  const requestHash = hashRequest(request.method, endpoint, request.body ?? null);
  const expiresAt = new Date(Date.now() + config.IDEMPOTENCY_TTL_HOURS * 3600_000);

  // Step 1 — reserve. Committed immediately (single statement, no open
  // transaction), so a concurrent retry sees the row.
  const reserved = await pool.query(
    `INSERT INTO idempotency_keys (salon_id, key, endpoint, request_hash, status, expires_at)
     VALUES ($1, $2, $3, $4, 'in_progress', $5)
     ON CONFLICT (salon_id, key) DO NOTHING
     RETURNING key`,
    [salonId, key, endpoint, requestHash, expiresAt],
  );

  if (reserved.rowCount === 0) {
    const outcome = await inspectExistingKey({ salonId, key, endpoint, requestHash, expiresAt });
    if (outcome.kind === 'replay') {
      reply.header('Idempotent-Replay', 'true');
      reply.status(outcome.status);
      return outcome.body as T;
    }
    // outcome.kind === 'took_over' — the previous attempt died; we own it now.
  }

  reply.header('Idempotent-Replay', 'false');

  let result: IdempotentResult<T>;
  try {
    result = await handler();
  } catch (err) {
    await recordFailure(salonId, key, err);
    throw err;
  }

  await pool.query(
    `UPDATE idempotency_keys
        SET status = 'completed', response_status = $3, response_body = $4, updated_at = now()
      WHERE salon_id = $1 AND key = $2`,
    [salonId, key, result.status, JSON.stringify(result.body)],
  );

  reply.status(result.status);
  return result.body;
}

type ExistingKeyOutcome =
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'took_over' };

async function inspectExistingKey(args: {
  salonId: string;
  key: string;
  endpoint: string;
  requestHash: string;
  expiresAt: Date;
}): Promise<ExistingKeyOutcome> {
  const { salonId, key, endpoint, requestHash, expiresAt } = args;

  const { rows } = await pool.query<KeyRow>(
    `SELECT status, request_hash, response_status, response_body, updated_at
       FROM idempotency_keys
      WHERE salon_id = $1 AND key = $2`,
    [salonId, key],
  );
  const row = rows[0];

  // Swept between the INSERT and the SELECT; treat as a fresh reservation.
  if (!row) {
    await pool.query(
      `INSERT INTO idempotency_keys (salon_id, key, endpoint, request_hash, status, expires_at)
       VALUES ($1,$2,$3,$4,'in_progress',$5)
       ON CONFLICT (salon_id, key) DO UPDATE SET status = 'in_progress', updated_at = now()`,
      [salonId, key, endpoint, requestHash, expiresAt],
    );
    return { kind: 'took_over' };
  }

  // A key reused for a *different* request is a client bug, and replaying the
  // first response would answer a question that was not asked. Fail loudly.
  if (row.request_hash !== requestHash) {
    throw new ApiError(
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used for a different request. Generate a new key.',
      { key },
    );
  }

  if (row.status === 'completed') {
    return {
      kind: 'replay',
      status: row.response_status ?? 200,
      body: row.response_body,
    };
  }

  // Still in flight. If the owning request died mid-flight the key would block
  // every retry forever, so a sufficiently stale reservation can be taken over.
  const staleBefore = new Date(Date.now() - config.IDEMPOTENCY_STALE_SECONDS * 1000);
  const takeover = await pool.query(
    `UPDATE idempotency_keys
        SET updated_at = now()
      WHERE salon_id = $1 AND key = $2 AND status = 'in_progress' AND updated_at < $3
      RETURNING key`,
    [salonId, key, staleBefore],
  );
  if (takeover.rowCount && takeover.rowCount > 0) {
    logger.warn({ key: '[redacted]', endpoint }, 'took over a stale idempotency reservation');
    return { kind: 'took_over' };
  }

  throw new ApiError(
    'IDEMPOTENCY_REQUEST_IN_PROGRESS',
    'An identical request is already being processed. Retry shortly with the same key.',
    { retryAfterMs: 500 },
  );
}

/**
 * Decide whether a failure should be remembered.
 *
 * Deterministic client errors are stored so a retry replays them rather than
 * re-running work that will fail identically. Server errors and rate limits
 * release the key, because the agent's retry is a request for a genuinely
 * fresh attempt.
 */
async function recordFailure(salonId: string, key: string, err: unknown): Promise<void> {
  const isDeterministic =
    err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429;

  try {
    if (isDeterministic) {
      const apiErr = err as ApiError;
      await pool.query(
        `UPDATE idempotency_keys
            SET status = 'completed', response_status = $3, response_body = $4, updated_at = now()
          WHERE salon_id = $1 AND key = $2`,
        [salonId, key, apiErr.status, JSON.stringify(apiErr.toBody())],
      );
    } else {
      await pool.query(`DELETE FROM idempotency_keys WHERE salon_id = $1 AND key = $2`, [salonId, key]);
    }
  } catch (cleanupErr) {
    // Never let bookkeeping mask the original failure.
    logger.error({ err: cleanupErr }, 'failed to record idempotency outcome');
  }
}

/** Periodic sweep of expired keys. Started by the server, stopped on shutdown. */
export function startIdempotencySweeper(intervalMs = 3_600_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    pool
      .query(`DELETE FROM idempotency_keys WHERE expires_at < now()`)
      .then((res) => {
        if (res.rowCount) logger.debug({ removed: res.rowCount }, 'swept expired idempotency keys');
      })
      .catch((err) => logger.error({ err }, 'idempotency sweep failed'));
  }, intervalMs);
  timer.unref();
  return timer;
}
