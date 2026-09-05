import { useMemo, useState } from 'react';
import type { Appointment } from '@salon/contracts';
import {
  useAvailability,
  useBookAppointment,
  useCustomers,
  useRescheduleAppointment,
  useServices,
  useStaff,
} from '../api/hooks';
import { ErrorNote, Field, money } from './ui';
import { ApiRequestError } from '../api/client';

/**
 * Booking and rescheduling share this form because they are the same decision:
 * pick a service, a stylist and a slot. Slots come from `/v1/availability`, so
 * staff can only ever choose a time the API would accept — the UI does not
 * compute availability itself.
 */
export function BookingForm({
  onDone,
  rescheduleOf,
  presetCustomerId,
}: {
  onDone: () => void;
  rescheduleOf?: Appointment;
  presetCustomerId?: string;
}) {
  const services = useServices('true');
  const staff = useStaff();

  const [customerSearch, setCustomerSearch] = useState('');
  const customers = useCustomers(customerSearch);

  const [customerId, setCustomerId] = useState(presetCustomerId ?? rescheduleOf?.customer.id ?? '');
  const [serviceId, setServiceId] = useState(rescheduleOf?.service.id ?? '');
  const [staffId, setStaffId] = useState('');
  const [date, setDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  });
  const [slot, setSlot] = useState<{ start: string; staffId: string } | null>(null);

  const window = useMemo(
    () => ({ from: new Date(`${date}T00:00:00`).toISOString(), to: new Date(`${date}T23:59:00`).toISOString() }),
    [date],
  );
  const availability = useAvailability({
    serviceId: serviceId || undefined,
    staffId: staffId || undefined,
    ...window,
  });

  const book = useBookAppointment();
  const reschedule = useRescheduleAppointment();
  const pending = book.isPending || reschedule.isPending;
  const error = book.error ?? reschedule.error;

  const feeError = error instanceof ApiRequestError && error.code === 'CANCELLATION_WINDOW_PASSED' ? error : null;

  const submit = (acknowledgeFee = false) => {
    if (!slot) return;
    if (rescheduleOf) {
      reschedule.mutate(
        { id: rescheduleOf.id, start: slot.start, staffId: slot.staffId, acknowledgeFee },
        { onSuccess: onDone },
      );
    } else {
      book.mutate({ customerId, serviceId, staffId: slot.staffId, start: slot.start }, { onSuccess: onDone });
    }
  };

  const canSubmit = Boolean(serviceId && slot && (rescheduleOf || customerId));

  return (
    <div className="stack">
      {rescheduleOf && (
        <div className="alert info">
          Moving <strong>{rescheduleOf.customer.firstName}</strong>&apos;s {rescheduleOf.service.name} from {rescheduleOf.label}.
        </div>
      )}

      {feeError ? (
        <div className="alert warn">
          {feeError.message}
          <div className="small" style={{ marginTop: 4 }}>Confirm below to move it anyway and apply the fee.</div>
        </div>
      ) : (
        <ErrorNote error={error} />
      )}

      {!rescheduleOf && !presetCustomerId && (
        <Field label="Customer">
          <input
            placeholder="Search by name or phone…"
            value={customerSearch}
            onChange={(e) => setCustomerSearch(e.target.value)}
            style={{ marginBottom: 6 }}
          />
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} size={5}>
            {(customers.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.firstName} {c.lastName ?? ''} — {c.phone}
              </option>
            ))}
          </select>
        </Field>
      )}

      <div className="row">
        <Field label="Service">
          <select value={serviceId} onChange={(e) => { setServiceId(e.target.value); setSlot(null); }}>
            <option value="">Choose a service…</option>
            {(services.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.durationMinutes} min · {money(s.price, s.currency)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Stylist">
          <select value={staffId} onChange={(e) => { setStaffId(e.target.value); setSlot(null); }}>
            <option value="">Anyone available</option>
            {(staff.data ?? []).filter((s) => s.active).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Date">
        <input type="date" value={date} onChange={(e) => { setDate(e.target.value); setSlot(null); }} />
      </Field>

      <div className="field">
        <label>Available times</label>
        {!serviceId ? (
          <div className="small muted">Choose a service to see availability.</div>
        ) : availability.isLoading ? (
          <div className="small muted">Checking availability…</div>
        ) : (availability.data?.slots.length ?? 0) === 0 ? (
          <div className="small muted">
            {availability.data?.unavailableReason ?? 'Nothing free on this date.'}
          </div>
        ) : (
          <div className="slot-grid">
            {availability.data!.slots.map((s) => (
              <button
                key={`${s.start}-${s.staffId}`}
                type="button"
                className={`slot${slot?.start === s.start ? ' selected' : ''}`}
                onClick={() => setSlot({ start: s.start, staffId: s.staffId })}
                title={`${s.label} with ${s.staffName}`}
              >
                {s.localTime}
                {!staffId && <div className="small" style={{ opacity: 0.75 }}>{s.staffName.split(' ')[0]}</div>}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="modal-actions">
        <button onClick={onDone}>Cancel</button>
        <button className="primary" disabled={!canSubmit || pending} onClick={() => submit(Boolean(feeError))}>
          {pending ? 'Saving…' : feeError ? 'Move and apply fee' : rescheduleOf ? 'Move appointment' : 'Book appointment'}
        </button>
      </div>
    </div>
  );
}
