import { useEffect, useState } from 'react';
import type { BusinessHoursResponse } from '@salon/contracts';
import { useAddClosedDate, useBusinessHours, useDeleteClosedDate, useSaveBusinessHours } from '../api/hooks';
import { Empty, ErrorNote, Field, Loading } from '../components/ui';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function Hours() {
  const hours = useBusinessHours();
  const save = useSaveBusinessHours();
  const [week, setWeek] = useState<BusinessHoursResponse['week']>([]);

  useEffect(() => {
    if (hours.data) setWeek(hours.data.week);
  }, [hours.data]);

  const update = (dayOfWeek: number, patch: Partial<BusinessHoursResponse['week'][number]>) =>
    setWeek((w) => w.map((d) => (d.dayOfWeek === dayOfWeek ? { ...d, ...patch } : d)));

  if (hours.isLoading) return <Loading what="opening hours" />;

  return (
    <>
      <h1>Hours &amp; closures</h1>
      <p className="page-sub">
        Times are the salon&apos;s own wall clock ({hours.data?.timezone}). Availability, the voice
        agent&apos;s answers and every booking rule follow from these.
      </p>

      <ErrorNote error={hours.error ?? save.error} />

      <div className="card">
        <h2>Weekly opening hours</h2>
        <table>
          <thead><tr><th style={{ width: 130 }}>Day</th><th style={{ width: 100 }}>Open?</th><th>Opens</th><th>Closes</th></tr></thead>
          <tbody>
            {week.map((day) => (
              <tr key={day.dayOfWeek}>
                <td><strong>{DAY_NAMES[day.dayOfWeek]}</strong></td>
                <td>
                  <label className="inline" style={{ marginBottom: 0, textTransform: 'none', fontWeight: 400 }}>
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      checked={!day.isClosed}
                      onChange={(e) =>
                        update(day.dayOfWeek, e.target.checked
                          ? { isClosed: false, openTime: day.openTime ?? '09:00:00', closeTime: day.closeTime ?? '18:00:00' }
                          : { isClosed: true, openTime: null, closeTime: null })
                      }
                    />
                    <span>{day.isClosed ? 'Closed' : 'Open'}</span>
                  </label>
                </td>
                <td>
                  <input
                    type="time" disabled={day.isClosed} value={(day.openTime ?? '').slice(0, 5)}
                    onChange={(e) => update(day.dayOfWeek, { openTime: `${e.target.value}:00` })}
                  />
                </td>
                <td>
                  <input
                    type="time" disabled={day.isClosed} value={(day.closeTime ?? '').slice(0, 5)}
                    onChange={(e) => update(day.dayOfWeek, { closeTime: `${e.target.value}:00` })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="modal-actions">
          <button className="primary" disabled={save.isPending} onClick={() => save.mutate(week)}>
            {save.isPending ? 'Saving…' : 'Save opening hours'}
          </button>
        </div>
      </div>

      <ClosedDates closures={hours.data?.closedDates ?? []} />
    </>
  );
}

function ClosedDates({ closures }: { closures: BusinessHoursResponse['closedDates'] }) {
  const add = useAddClosedDate();
  const remove = useDeleteClosedDate();
  const [form, setForm] = useState({ date: '', reason: '', openTime: '', closeTime: '' });

  const submit = () =>
    add.mutate(
      {
        date: form.date,
        reason: form.reason || null,
        openTime: form.openTime ? `${form.openTime}:00` : null,
        closeTime: form.closeTime ? `${form.closeTime}:00` : null,
      },
      { onSuccess: () => setForm({ date: '', reason: '', openTime: '', closeTime: '' }) },
    );

  return (
    <div className="card">
      <h2>Holidays &amp; one-off changes</h2>
      <p className="small muted" style={{ marginTop: -4 }}>
        Leave both times empty to close all day. Fill both in to replace that date&apos;s hours —
        a Christmas Eve half-day, say.
      </p>

      <ErrorNote error={add.error ?? remove.error} />

      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="Date"><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
        <Field label="Reason"><input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Bank holiday" /></Field>
        <Field label="Opens (optional)"><input type="time" value={form.openTime} onChange={(e) => setForm({ ...form, openTime: e.target.value })} /></Field>
        <Field label="Closes (optional)"><input type="time" value={form.closeTime} onChange={(e) => setForm({ ...form, closeTime: e.target.value })} /></Field>
        <div className="field">
          <button className="primary" disabled={!form.date || add.isPending} onClick={submit}>Add</button>
        </div>
      </div>

      {closures.length === 0 ? (
        <Empty>No upcoming closures.</Empty>
      ) : (
        <table>
          <thead><tr><th>Date</th><th>Reason</th><th>Hours</th><th /></tr></thead>
          <tbody>
            {closures.map((c) => (
              <tr key={c.id}>
                <td>{c.date}</td>
                <td>{c.reason ?? <span className="muted">—</span>}</td>
                <td>
                  {c.openTime && c.closeTime
                    ? <span className="badge warn">{c.openTime.slice(0, 5)}–{c.closeTime.slice(0, 5)}</span>
                    : <span className="badge cancelled">Closed all day</span>}
                </td>
                <td className="right">
                  <button className="small danger" onClick={() => remove.mutate(c.id!)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
