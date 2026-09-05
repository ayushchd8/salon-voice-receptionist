import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { ApiError, type Scope } from '@salon/contracts';
import { pool } from '../db/pool.js';
import { hashApiKey } from '../lib/hash.js';
import { config } from '../config.js';
import { currentContext } from '../lib/logger.js';

export interface Principal {
  keyId: string;
  salonId: string;
  name: string;
  scopes: Scope[];
  /** Derived from the key prefix; used only for observability and PII projection. */
  kind: 'agent' | 'staff' | 'other';
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
  interface FastifyInstance {
    /** Route-level guard: `preHandler: app.requireScope('appointments:write')` */
    requireScope: (...scopes: Scope[]) => (request: FastifyRequest) => Promise<void>;
  }
}

interface KeyRow {
  id: string;
  salon_id: string;
  name: string;
  scopes: string[];
  key_prefix: string;
}

/**
 * Short-lived positive cache for key lookups.
 *
 * Every request authenticates, and hitting Postgres for an unchanged row each
 * time is wasteful. The TTL is deliberately small so a revoked key stops
 * working within seconds rather than at the next deploy; `revokeKeyFromCache`
 * makes revocation immediate for the node that performed it.
 */
const CACHE_TTL_MS = 5_000;
const keyCache = new Map<string, { principal: Principal; expiresAt: number }>();

export function clearKeyCache(): void {
  keyCache.clear();
}

function principalKind(prefix: string): Principal['kind'] {
  if (prefix.startsWith('sk_agent')) return 'agent';
  if (prefix.startsWith('sk_staff')) return 'staff';
  return 'other';
}

async function principalForKey(rawKey: string): Promise<Principal | null> {
  const hash = hashApiKey(rawKey);

  const cached = keyCache.get(hash);
  if (cached && cached.expiresAt > Date.now()) return cached.principal;

  const { rows } = await pool.query<KeyRow>(
    `SELECT id, salon_id, name, scopes, key_prefix
       FROM api_keys
      WHERE key_hash = $1 AND revoked_at IS NULL`,
    [hash],
  );
  const row = rows[0];
  if (!row) {
    keyCache.delete(hash);
    return null;
  }

  const principal: Principal = {
    keyId: row.id,
    salonId: row.salon_id,
    name: row.name,
    scopes: row.scopes as Scope[],
    kind: principalKind(row.key_prefix),
  };
  keyCache.set(hash, { principal, expiresAt: Date.now() + CACHE_TTL_MS });

  // Fire-and-forget: last-used is useful for spotting stale credentials but is
  // never worth failing or delaying a request over.
  pool
    .query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id])
    .catch(() => {});

  return principal;
}

/** Look up a principal by key id, for a request authenticated by session cookie. */
async function principalForKeyId(keyId: string): Promise<Principal | null> {
  const { rows } = await pool.query<KeyRow>(
    `SELECT id, salon_id, name, scopes, key_prefix
       FROM api_keys
      WHERE id = $1 AND revoked_at IS NULL`,
    [keyId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    keyId: row.id,
    salonId: row.salon_id,
    name: row.name,
    scopes: row.scopes as Scope[],
    kind: principalKind(row.key_prefix),
  };
}

export const SESSION_COOKIE = 'salon_session';

/** Routes reachable without credentials. */
const PUBLIC_PATHS = new Set(['/health', '/ready', '/v1/auth/session', '/docs', '/docs/json', '/docs/yaml']);

function isPublic(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return PUBLIC_PATHS.has(path) || path.startsWith('/docs/');
}

export const authPlugin: FastifyPluginAsync = fp(
  async (app) => {
    app.decorateRequest('principal', null as unknown as Principal);

    app.addHook('preHandler', async (request) => {
      if (isPublic(request.url)) return;

      let principal: Principal | null = null;

      const header = request.headers.authorization;
      if (header?.startsWith('Bearer ')) {
        principal = await principalForKey(header.slice(7).trim());
      } else {
        // Staff UI: the raw key was exchanged for a signed, httpOnly cookie at
        // login, so a long-lived credential never sits in browser storage where
        // any script on the page could read it.
        const raw = request.cookies?.[SESSION_COOKIE];
        if (raw) {
          const unsigned = request.unsignCookie(raw);
          if (unsigned.valid && unsigned.value) {
            // Re-read the key row on every request, so revoking a key logs the
            // session out immediately rather than when the cookie expires.
            principal = await principalForKeyId(unsigned.value);
          }
        }
      }

      if (!principal) {
        throw new ApiError(
          'UNAUTHENTICATED',
          'Provide a valid API key as `Authorization: Bearer <key>`, or sign in for a session.',
        );
      }

      request.principal = principal;

      // Bind the tenant and caller into the log context for everything downstream.
      const ctx = currentContext();
      if (ctx) {
        ctx.salonId = principal.salonId;
        ctx.principal = `${principal.kind}:${principal.keyId.slice(0, 8)}`;
      }
    });

    app.decorate('requireScope', (...required: Scope[]) => async (request: FastifyRequest) => {
      const held = new Set(request.principal?.scopes ?? []);
      const missing = required.filter((scope) => !held.has(scope));
      if (missing.length > 0) {
        throw new ApiError('FORBIDDEN_SCOPE', 'This credential is not permitted to do that.', {
          required,
          missing,
        });
      }
    });
  },
  { name: 'auth', dependencies: ['context'] },
);

export { principalForKey, principalForKeyId };
export const sessionTtlSeconds = config.SESSION_TTL_HOURS * 3600;
