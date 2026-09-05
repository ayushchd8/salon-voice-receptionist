/**
 * The voice agent's client for the CRM API.
 *
 * This file is the entire surface between the agent and the salon's data.
 * There is no database driver in this package — the agent is a client of the
 * published HTTP API exactly like any third-party integration, which is what
 * makes the API contract real rather than aspirational.
 *
 * Two behaviours here carry the reliability requirements:
 *
 *  - **Every call has a deadline.** A hung request would leave a caller
 *    listening to silence, so requests are aborted at `CRM_TIMEOUT_MS` and the
 *    failure is surfaced as a typed error the conversation can act on.
 *
 *  - **Retries reuse the idempotency key.** A booking that timed out may
 *    already have succeeded; retrying with the same key replays that result
 *    instead of booking the customer twice.
 */
import {
  RETRYABLE_ERROR_CODES,
  type ApiErrorBody,
  type Appointment,
  type AvailabilityResponse,
  type BookingPolicy,
  type BusinessHoursResponse,
  type CustomerSummary,
  type ErrorCode,
  type Salon,
  type Service,
  type StaffMember,
} from '@salon/contracts';
import { config } from '../config.js';
import { logger } from '../logger.js';

export class CrmError extends Error {
  readonly code: ErrorCode | 'TIMEOUT' | 'NETWORK_ERROR';
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode | 'TIMEOUT' | 'NETWORK_ERROR',
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CrmError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryable =
      code === 'TIMEOUT' ||
      code === 'NETWORK_ERROR' ||
      RETRYABLE_ERROR_CODES.has(code as ErrorCode);
  }
}

interface Paginated<T> {
  data: T[];
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
}

export interface RequestContext {
  callId?: string | undefined;
}

interface CallOptions extends RequestContext {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  /** Retries are safe for reads and for keyed writes; unkeyed writes get one shot. */
  retries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CrmClientOptions {
  /** Per-request deadline. Overridable so tests can force a timeout quickly. */
  timeoutMs?: number;
  maxRetries?: number;
}

export class CrmClient {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(
    private readonly baseUrl: string = config.CRM_API_URL,
    private readonly apiKey: string = config.CRM_API_KEY,
    options: CrmClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? config.CRM_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? config.CRM_MAX_RETRIES;
  }

  private async request<T>(path: string, options: CallOptions = {}): Promise<T> {
    const retries = options.retries ?? this.maxRetries;
    let lastError: CrmError | undefined;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.attempt<T>(path, options, attempt);
      } catch (err) {
        const error = err instanceof CrmError ? err : new CrmError('NETWORK_ERROR', String(err), 0);
        lastError = error;

        // A definitive answer — "that slot is taken", "no such customer" —
        // will not change on a second attempt. Retrying only burns call time.
        if (!error.retryable || attempt === retries) throw error;

        // Exponential backoff with jitter, so a struggling API is not
        // hammered in lockstep by every concurrent call.
        const backoff = Math.min(2000, 150 * 2 ** attempt) + Math.random() * 100;
        logger.warn(
          { path, attempt: attempt + 1, code: error.code, backoffMs: Math.round(backoff), callId: options.callId },
          'CRM request failed — retrying with the same idempotency key',
        );
        await sleep(backoff);
      }
    }

    throw lastError ?? new CrmError('NETWORK_ERROR', 'request failed', 0);
  }

  private async attempt<T>(path: string, options: CallOptions, attempt: number): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    // Reused across retries — this is what makes a retried booking safe.
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    if (options.callId) headers['X-Call-Id'] = options.callId;

    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        // Nothing in a live call may hang indefinitely.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw isTimeout
        ? new CrmError('TIMEOUT', `The salon system did not respond within ${this.timeoutMs}ms.`, 0)
        : new CrmError('NETWORK_ERROR', `Could not reach the salon system: ${String(err)}`, 0);
    }

    const latencyMs = Date.now() - started;
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const payload: unknown = text ? JSON.parse(text) : null;

    if (!response.ok) {
      const error = (payload as ApiErrorBody | null)?.error;
      logger.warn(
        { path, status: response.status, code: error?.code, latencyMs, attempt, callId: options.callId },
        'CRM returned an error',
      );
      throw new CrmError(
        error?.code ?? 'INTERNAL_ERROR',
        error?.message ?? `Request failed with status ${response.status}.`,
        response.status,
        error?.details,
      );
    }

    logger.debug({ path, status: response.status, latencyMs, callId: options.callId }, 'CRM call ok');
    return payload as T;
  }

  // ── reads ───────────────────────────────────────────────────────────────────

  getSalon(ctx: RequestContext = {}) {
    return this.request<Salon>('/v1/salon', ctx);
  }

  getBusinessHours(ctx: RequestContext = {}) {
    return this.request<BusinessHoursResponse>('/v1/business-hours', ctx);
  }

  getPolicy(ctx: RequestContext = {}) {
    return this.request<BookingPolicy>('/v1/booking-policy', ctx);
  }

  listServices(ctx: RequestContext = {}) {
    return this.request<{ data: Service[] }>('/v1/services?active=true', ctx).then((r) => r.data);
  }

  listStaff(ctx: RequestContext = {}) {
    return this.request<{ data: StaffMember[] }>('/v1/staff', ctx).then((r) => r.data);
  }

  findCustomerByPhone(phone: string, ctx: RequestContext = {}) {
    return this.request<Paginated<CustomerSummary>>(
      `/v1/customers/search?phone=${encodeURIComponent(phone)}`,
      ctx,
    ).then((r) => r.data[0] ?? null);
  }

  searchCustomersByName(name: string, ctx: RequestContext = {}) {
    return this.request<Paginated<CustomerSummary>>(
      `/v1/customers/search?name=${encodeURIComponent(name)}`,
      ctx,
    ).then((r) => r.data);
  }

  resolveTime(expression: string, ctx: RequestContext = {}) {
    return this.request<{
      expression: string; from: string; to: string; interpretation: string; timezone: string; isBroad: boolean;
    }>(`/v1/resolve-time?expression=${encodeURIComponent(expression)}`, ctx);
  }

  getAvailability(
    params: { serviceId: string; staffId?: string | undefined; timeExpression?: string | undefined; from?: string | undefined; to?: string | undefined; limit?: number },
    ctx: RequestContext = {},
  ) {
    const search = new URLSearchParams({ serviceId: params.serviceId });
    if (params.staffId) search.set('staffId', params.staffId);
    if (params.timeExpression) search.set('timeExpression', params.timeExpression);
    if (params.from) search.set('from', params.from);
    if (params.to) search.set('to', params.to);
    search.set('limit', String(params.limit ?? 8));
    return this.request<AvailabilityResponse>(`/v1/availability?${search}`, ctx);
  }

  findAppointments(
    params: { phone?: string; customerId?: string; upcomingOnly?: boolean },
    ctx: RequestContext = {},
  ) {
    const search = new URLSearchParams();
    if (params.phone) search.set('phone', params.phone);
    if (params.customerId) search.set('customerId', params.customerId);
    if (params.upcomingOnly !== false) search.set('upcomingOnly', 'true');
    search.set('limit', '20');
    return this.request<Paginated<Appointment>>(`/v1/appointments?${search}`, ctx).then((r) => r.data);
  }

  // ── writes (all idempotency-keyed) ──────────────────────────────────────────

  bookAppointment(body: Record<string, unknown>, idempotencyKey: string, ctx: RequestContext = {}) {
    return this.request<Appointment>('/v1/appointments', {
      ...ctx, method: 'POST', body, idempotencyKey,
    });
  }

  cancelAppointment(
    appointmentId: string,
    body: { reason?: string | null; acknowledgeFee?: boolean },
    idempotencyKey: string,
    ctx: RequestContext = {},
  ) {
    return this.request<Appointment>(`/v1/appointments/${appointmentId}/cancel`, {
      ...ctx, method: 'POST', body, idempotencyKey,
    });
  }

  rescheduleAppointment(
    appointmentId: string,
    body: Record<string, unknown>,
    idempotencyKey: string,
    ctx: RequestContext = {},
  ) {
    return this.request<Appointment>(`/v1/appointments/${appointmentId}/reschedule`, {
      ...ctx, method: 'POST', body, idempotencyKey,
    });
  }

  // ── call records ────────────────────────────────────────────────────────────

  startCall(body: { callerPhone?: string | null; transport: string }) {
    return this.request<{ id: string }>('/v1/calls', { method: 'POST', body, retries: 1 });
  }

  /** Progress update mid-call. One shot only — never delay a live call to retry. */
  updateCall(callId: string, body: Record<string, unknown>) {
    return this.request(`/v1/calls/${callId}`, { method: 'PATCH', body, callId, retries: 0 });
  }

  endCall(callId: string, body: Record<string, unknown>) {
    return this.request(`/v1/calls/${callId}/end`, { method: 'POST', body, callId, retries: 1 });
  }

  saveCallSummary(body: Record<string, unknown>) {
    return this.request('/v1/call-summaries', {
      method: 'POST', body, callId: body.callId as string, retries: 2,
    });
  }
}

export const crm = new CrmClient();
