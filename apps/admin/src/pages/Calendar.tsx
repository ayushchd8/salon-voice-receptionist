import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Appointment } from '@salon/contracts';
import {
  useAppointments,
  useCancelAppointment,
  useSetAppointmentStatus,
  useStaff,
} from '../api/hooks';
import { Badge, Empty, ErrorNote, Loading, Modal, money } from '../components/ui';
import { BookingForm } from '../components/BookingForm';
import { ApiRequestError } from '../api/client';

const RANGES = {
  today: { label: 'Today', days: 1 },
  week: { label: 'Next 7 days', days: 7 },
  month: { label: 'Next 30 days', days: 30 },
} as const;

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export function Calendar() {
  const [range, setRange] = useState<keyof typeof RANGES>('week');
  const [staffId, setStaffId] = useState('');
  const [status, setStatus] = useState('booked');
  const [booking, setBooking] = useState(false);
  const [acting, setActing] = useState<{ appointment: Appointment; mode: 'cancel' | 'reschedule' } | null>(null);

  const staff = useStaff();
  const appointments = useAppointments({
    from: isoDaysFromNow(0),
    to: isoDaysFromNow(RANGES[range].days),
    ...(staffId ? { staffId } : {}),
    ...(status ? { status } : {}),
  });

  // Group by salon-local date, which the API already supplies — the UI never
  // does timezone arithmetic of its own.
  const byDay = useMemo(() => {
    const groups = new Map<string, Appointment[]>();
    for (const a of appointments.data ?? []) {
      const list = groups.get(a.localDate);
      if (list) list.push(a);
      else groups.set(a.localDate, [a]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [appointments.data]);

  return (
    <>
      <div className="page-head">
        <h1>Appointments</h1>
        <button className="primary" onClick={() => setBooking(true)}>
          New appointment
        </button>
      </div>
      <p className="page-sub">The salon diary. Times shown in the salon&apos;s own timezone.</p>

      <div className="toolbar">
        <div>
          <label>Range</label>
          <select value={range} onChange={(e) => setRange(e.target.value as keyof typeof RANGES)}>
            {Object.entries(RANGES).map(([key, r]) => (
              <option key={key} value={key}>{r.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label>Stylist</label>
          <select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">Everyone</option>
            {(staff.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label>Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="booked">Booked</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="no_show">No-show</option>
            <option value="">All</option>
          </select>
        </div>
      </div>

      <ErrorNote error={appointments.error} />

      {appointments.isLoading ? (
        <Loading what="appointments" />
      ) : byDay.length === 0 ? (
        <Empty>Nothing in the diary for this range.</Empty>
      ) : (
        byDay.map(([date, list]) => (
          <div className="day-group" key={date}>
            <div className="day-heading">
              {new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
                weekday: 'long', day: 'numeric', month: 'long',
              })}
              <span className="muted"> · {list.length}</span>
            </div>
            <div className="card card-tight">
              <table>
                <tbody>
                  {list.map((a) => (
                    <AppointmentRow key={a.id} appointment={a} onAct={(mode) => setActing({ appointment: a, mode })} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {booking && <Modal title="New appointment" onClose={() => setBooking(false)}><BookingForm onDone={() => setBooking(false)} /></Modal>}
      {acting && (
        <Modal
          title={acting.mode === 'cancel' ? 'Cancel appointment' : 'Reschedule appointment'}
          onClose={() => setActing(null)}
        >
          {acting.mode === 'cancel' ? (
            <CancelForm appointment={acting.appointment} onDone={() => setActing(null)} />
          ) : (
            <BookingForm rescheduleOf={acting.appointment} onDone={() => setActing(null)} />
          )}
        </Modal>
      )}
    </>
  );
}

function AppointmentRow({ appointment: a, onAct }: { appointment: Appointment; onAct: (mode: 'cancel' | 'reschedule') => void }) {
  const setStatus = useSetAppointmentStatus();
  const editable = a.status === 'booked';

  return (
    <tr>
      <td style={{ width: 70, fontWeight: 600 }}>{a.localTime}</td>
      <td style={{ width: 190 }}>
        <Link to={`/customers/${a.customer.id}`}>{a.customer.firstName}</Link>
        <div className="small muted">{a.customer.phone}</div>
      </td>
      <td>
        {a.service.name}
        <div className="small muted">{a.service.durationMinutes} min · {money(a.priceAtBooking, a.currency)}</div>
      </td>
      <td style={{ width: 130 }}>{a.staff.name}</td>
      <td style={{ width: 110 }}>
        <Badge value={a.status} />
        {a.source === 'voice' && <div className="small muted">via phone</div>}
      </td>
      <td className="right" style={{ width: 230 }}>
        {editable ? (
          <div className="inline" style={{ justifyContent: 'flex-end' }}>
            <button className="small" onClick={() => onAct('reschedule')}>Move</button>
            <button className="small danger" onClick={() => onAct('cancel')}>Cancel</button>
            <button className="small" onClick={() => setStatus.mutate({ id: a.id, status: 'completed' })}>Done</button>
            <button className="small" onClick={() => setStatus.mutate({ id: a.id, status: 'no_show' })}>No-show</button>
          </div>
        ) : (
          <span className="small muted">
            {a.cancellationFee !== '0.00' ? `fee ${money(a.cancellationFee, a.currency)}` : '—'}
          </span>
        )}
      </td>
    </tr>
  );
}

function CancelForm({ appointment, onDone }: { appointment: Appointment; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const cancel = useCancelAppointment();

  // The API refuses a late cancellation once, returning the fee. The UI shows
  // that and re-submits with acknowledgement — the same two-step the voice
  // agent walks a caller through.
  const feeError = cancel.error instanceof ApiRequestError && cancel.error.code === 'CANCELLATION_WINDOW_PASSED'
    ? cancel.error
    : null;

  const submit = (acknowledgeFee: boolean) =>
    cancel.mutate({ id: appointment.id, reason: reason || null, acknowledgeFee }, { onSuccess: onDone });

  return (
    <div className="stack">
      <p style={{ margin: 0 }}>
        <strong>{appointment.customer.firstName}</strong> — {appointment.service.name}, {appointment.label}, with {appointment.staff.name}.
      </p>

      {feeError ? (
        <div className="alert warn">
          {feeError.message}
          <div className="small" style={{ marginTop: 6 }}>
            {String(feeError.details?.hoursUntilAppointment)} hours away · notice window {String(feeError.details?.windowHours)}h
          </div>
        </div>
      ) : (
        <ErrorNote error={cancel.error} />
      )}

      <div className="field">
        <label>Reason (optional)</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer called to cancel" />
      </div>

      <div className="modal-actions">
        <button onClick={onDone}>Keep it</button>
        <button className="danger" disabled={cancel.isPending} onClick={() => submit(Boolean(feeError))}>
          {feeError ? 'Cancel and apply the fee' : 'Cancel appointment'}
        </button>
      </div>
    </div>
  );
}
