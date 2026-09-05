import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import type {
  Appointment,
  BookingPolicy,
  BusinessHoursResponse,
  CallSummary,
  Customer,
  Service,
  StaffMember,
} from '@salon/contracts';
import { api, newIdempotencyKey, qs } from './client';

interface Paginated<T> {
  data: T[];
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
}

export interface Session {
  salon: { id: string; name: string; timezone: string };
  credential: { name: string; kind: string; scopes: string[] };
}

const keys = {
  session: ['session'] as const,
  salon: ['salon'] as const,
  services: (filter: string) => ['services', filter] as const,
  staff: ['staff'] as const,
  hours: ['hours'] as const,
  policy: ['policy'] as const,
  customers: (search: string) => ['customers', search] as const,
  customer: (id: string) => ['customer', id] as const,
  appointments: (filter: string) => ['appointments', filter] as const,
  calls: (filter: string) => ['calls', filter] as const,
  call: (id: string) => ['call', id] as const,
};

/**
 * After any write, everything derived from the diary is stale: the calendar,
 * a customer's history, and availability. Rather than enumerate that at each
 * call site — where one will inevitably be forgotten — writes invalidate the
 * affected roots wholesale.
 */
function useInvalidate() {
  const client = useQueryClient();
  return (...roots: string[]) => {
    for (const root of roots) client.invalidateQueries({ queryKey: [root] });
  };
}

// ── session ───────────────────────────────────────────────────────────────────

export function useSession(options?: Partial<UseQueryOptions<Session>>) {
  return useQuery<Session>({
    queryKey: keys.session,
    queryFn: () => api<Session>('/v1/auth/me'),
    retry: false,
    ...options,
  });
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (apiKey: string) => api<Session>('/v1/auth/session', { method: 'POST', body: { apiKey } }),
    onSuccess: (session) => client.setQueryData(keys.session, session),
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/v1/auth/logout', { method: 'POST' }),
    onSuccess: () => client.clear(),
  });
}

// ── catalogue ─────────────────────────────────────────────────────────────────

export function useServices(active: 'true' | 'false' | 'all' = 'all') {
  return useQuery({
    queryKey: keys.services(active),
    queryFn: () => api<{ data: Service[] }>(`/v1/services${qs({ active })}`).then((r) => r.data),
  });
}

export function useSaveService() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<Service> & { id?: string }) =>
      id
        ? api<Service>(`/v1/services/${id}`, { method: 'PATCH', body })
        : api<Service>('/v1/services', { method: 'POST', body }),
    onSuccess: () => invalidate('services', 'appointments'),
  });
}

export function useStaff() {
  return useQuery({
    queryKey: keys.staff,
    queryFn: () => api<{ data: StaffMember[] }>('/v1/staff').then((r) => r.data),
  });
}

// ── hours and policy ──────────────────────────────────────────────────────────

export function useBusinessHours() {
  return useQuery({ queryKey: keys.hours, queryFn: () => api<BusinessHoursResponse>('/v1/business-hours') });
}

export function useSaveBusinessHours() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (week: BusinessHoursResponse['week']) =>
      api<BusinessHoursResponse>('/v1/business-hours', { method: 'PUT', body: { week } }),
    onSuccess: () => invalidate('hours', 'appointments'),
  });
}

export function useAddClosedDate() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { date: string; reason: string | null; openTime: string | null; closeTime: string | null }) =>
      api('/v1/closed-dates', { method: 'POST', body }),
    onSuccess: () => invalidate('hours', 'appointments'),
  });
}

export function useDeleteClosedDate() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/v1/closed-dates/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate('hours'),
  });
}

export function usePolicy() {
  return useQuery({ queryKey: keys.policy, queryFn: () => api<BookingPolicy>('/v1/booking-policy') });
}

export function useSavePolicy() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: Partial<BookingPolicy>) =>
      api<BookingPolicy>('/v1/booking-policy', { method: 'PATCH', body }),
    onSuccess: () => invalidate('policy', 'appointments'),
  });
}

// ── customers ─────────────────────────────────────────────────────────────────

export function useCustomers(search: string) {
  return useQuery({
    queryKey: keys.customers(search),
    queryFn: () => {
      const path = search.trim()
        ? `/v1/customers/search${qs(/\d/.test(search) ? { phone: search } : { name: search })}`
        : `/v1/customers${qs({ limit: 100 })}`;
      return api<Paginated<Customer>>(path).then((r) => r.data);
    },
  });
}

export function useCustomer(id: string | undefined) {
  return useQuery({
    queryKey: keys.customer(id ?? ''),
    queryFn: () => api<Customer>(`/v1/customers/${id}`),
    enabled: Boolean(id),
  });
}

export function useSaveCustomer() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<Customer> & { id?: string }) =>
      id
        ? api<Customer>(`/v1/customers/${id}`, { method: 'PATCH', body })
        : api<Customer>('/v1/customers', { method: 'POST', body }),
    onSuccess: () => invalidate('customers', 'customer'),
  });
}

// ── appointments ──────────────────────────────────────────────────────────────

export interface AppointmentFilters {
  from?: string;
  to?: string;
  customerId?: string;
  staffId?: string;
  status?: string;
  upcomingOnly?: boolean;
}

export function useAppointments(filters: AppointmentFilters) {
  const query = qs({ ...filters, limit: 200, order: 'asc' });
  return useQuery({
    queryKey: keys.appointments(query),
    queryFn: () => api<Paginated<Appointment>>(`/v1/appointments${query}`).then((r) => r.data),
  });
}

export function useAvailability(params: { serviceId?: string; staffId?: string; from?: string; to?: string }) {
  const enabled = Boolean(params.serviceId && params.from && params.to);
  const query = qs({ ...params, limit: 60 });
  return useQuery({
    queryKey: ['availability', query],
    queryFn: () =>
      api<{ slots: Array<{ start: string; localTime: string; staffId: string; staffName: string; label: string }>; alternatives: unknown[]; unavailableReason: string | null }>(
        `/v1/availability${query}`,
      ),
    enabled,
  });
}

export function useBookAppointment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Appointment>('/v1/appointments', {
        method: 'POST',
        body: { source: 'staff', ...body },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => invalidate('appointments', 'availability', 'customer'),
  });
}

export function useCancelAppointment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; reason?: string | null; acknowledgeFee?: boolean }) =>
      api<Appointment>(`/v1/appointments/${id}/cancel`, {
        method: 'POST',
        body,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => invalidate('appointments', 'availability', 'customer'),
  });
}

export function useRescheduleAppointment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; start: string; staffId?: string; acknowledgeFee?: boolean }) =>
      api<Appointment>(`/v1/appointments/${id}/reschedule`, {
        method: 'POST',
        body,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => invalidate('appointments', 'availability', 'customer'),
  });
}

export function useSetAppointmentStatus() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'completed' | 'no_show' }) =>
      api<Appointment>(`/v1/appointments/${id}/status`, { method: 'POST', body: { status } }),
    onSuccess: () => invalidate('appointments', 'customer'),
  });
}

// ── calls ─────────────────────────────────────────────────────────────────────

export interface CallFilters {
  escalated?: boolean;
  actionResult?: string;
  appointmentAction?: string;
  search?: string;
}

export function useCallSummaries(filters: CallFilters) {
  const query = qs({ ...filters, limit: 100 });
  return useQuery({
    queryKey: keys.calls(query),
    queryFn: () => api<Paginated<CallSummary>>(`/v1/call-summaries${query}`).then((r) => r.data),
    // Calls are written as they happen, so this screen shows live ones too.
    // Polling keeps a call in progress moving on a supervisor's screen.
    refetchInterval: 10_000,
  });
}

export function useCallSummary(callId: string | undefined) {
  return useQuery({
    queryKey: keys.call(callId ?? ''),
    queryFn: () => api<CallSummary & { call: { transcript?: unknown[] } }>(`/v1/call-summaries/${callId}`),
    enabled: Boolean(callId),
  });
}
