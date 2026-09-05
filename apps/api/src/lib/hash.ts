import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * API keys are stored as SHA-256 hashes; the raw value is shown once at
 * creation and never persisted. A database dump therefore contains no usable
 * credentials.
 *
 * SHA-256 rather than a password KDF is deliberate: these are 128-bit random
 * secrets, not user-chosen passwords, so there is no dictionary to slow down —
 * and key lookup happens on every request, where a deliberately slow hash
 * would be a latency problem rather than a security gain.
 */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

export function generateApiKey(prefix: 'agent' | 'staff'): string {
  return `sk_${prefix}_${randomBytes(24).toString('hex')}`;
}

/** First characters only, for display in the UI next to a revoke button. */
export function keyPrefixOf(rawKey: string): string {
  return rawKey.slice(0, 16);
}

/** Stable hash of a request body, used to detect idempotency-key reuse. */
export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method} ${path}\n${stableStringify(body)}`)
    .digest('hex');
}

/** Key-order-independent JSON, so `{a,b}` and `{b,a}` hash identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
