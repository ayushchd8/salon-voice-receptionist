import type { ApiErrorBody, ErrorCode } from '@salon/contracts';

/**
 * The staff UI's only route into the system.
 *
 * There is no database client in this app's dependency tree — the CRM is
 * reached exactly the way any third-party integration would reach it, which is
 * what keeps the published API contract honest rather than aspirational.
 */

export class ApiRequestError extends Error {
  readonly code: ErrorCode | 'NETWORK_ERROR';
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode | 'NETWORK_ERROR', message: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** Field errors keyed by path, for rendering inline against form inputs. */
  get fieldErrors(): Record<string, string> {
    const fields = this.details?.fields;
    if (!Array.isArray(fields)) return {};
    return Object.fromEntries(
      (fields as Array<{ path: string; message: string }>).map((f) => [f.path, f.message]),
    );
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Required by the API on state-changing appointment endpoints. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    throw new ApiRequestError('NETWORK_ERROR', 'Could not reach the CRM API. Is it running?', 0, {
      cause: String(err),
    });
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = (payload as ApiErrorBody | null)?.error;
    throw new ApiRequestError(
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? `Request failed with status ${response.status}.`,
      response.status,
      error?.details,
    );
  }

  return payload as T;
}

/** Every write from the UI is retry-safe for the same reason the agent's are. */
export function newIdempotencyKey(): string {
  return `admin-${crypto.randomUUID()}`;
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}
