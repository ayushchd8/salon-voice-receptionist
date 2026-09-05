import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCustomers, useSaveCustomer } from '../api/hooks';
import { Empty, ErrorNote, fieldErrorsOf, Field, Loading, Modal } from '../components/ui';

export function Customers() {
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const customers = useCustomers(search);

  return (
    <>
      <div className="page-head">
        <h1>Customers</h1>
        <button className="primary" onClick={() => setCreating(true)}>New customer</button>
      </div>
      <p className="page-sub">Search by name, or by phone — the same lookup the voice agent uses.</p>

      <div className="toolbar">
        <div className="grow">
          <label>Search</label>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or phone number…"
          />
        </div>
      </div>

      <ErrorNote error={customers.error} />

      {customers.isLoading ? (
        <Loading what="customers" />
      ) : (customers.data ?? []).length === 0 ? (
        <Empty>No customers match that search.</Empty>
      ) : (
        <div className="card card-tight">
          <table>
            <thead>
              <tr><th>Name</th><th>Phone</th><th>Email</th><th>Notes</th></tr>
            </thead>
            <tbody>
              {customers.data!.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/customers/${c.id}`}>{c.firstName} {c.lastName ?? ''}</Link></td>
                  <td>{c.phone}</td>
                  <td className="muted">{c.email ?? '—'}</td>
                  <td className="small muted" style={{ maxWidth: 320 }}>
                    {c.notes ? (c.notes.length > 70 ? `${c.notes.slice(0, 70)}…` : c.notes) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <Modal title="New customer" onClose={() => setCreating(false)}>
          <CustomerForm onDone={() => setCreating(false)} />
        </Modal>
      )}
    </>
  );
}

export function CustomerForm({
  onDone,
  initial,
}: {
  onDone: () => void;
  initial?: { id: string; firstName: string; lastName: string | null; phone: string; email: string | null; notes: string | null };
}) {
  const [form, setForm] = useState({
    firstName: initial?.firstName ?? '',
    lastName: initial?.lastName ?? '',
    phone: initial?.phone ?? '',
    email: initial?.email ?? '',
    notes: initial?.notes ?? '',
  });
  const save = useSaveCustomer();
  const fieldErrors = fieldErrorsOf(save.error);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = () =>
    save.mutate(
      {
        ...(initial ? { id: initial.id } : {}),
        firstName: form.firstName,
        lastName: form.lastName || null,
        phone: form.phone,
        email: form.email || null,
        notes: form.notes || null,
      },
      { onSuccess: onDone },
    );

  return (
    <div className="stack">
      <ErrorNote error={save.error} />
      <div className="row">
        <Field label="First name" error={fieldErrors.firstName}>
          <input value={form.firstName} onChange={set('firstName')} autoFocus />
        </Field>
        <Field label="Last name">
          <input value={form.lastName} onChange={set('lastName')} />
        </Field>
      </div>
      <Field label="Phone" error={fieldErrors.phone}>
        <input value={form.phone} onChange={set('phone')} placeholder="07700 900123" />
      </Field>
      <p className="small muted" style={{ margin: '-8px 0 4px' }}>
        Stored in E.164 form, so the same person is found however the number is typed.
      </p>
      <Field label="Email" error={fieldErrors.email}>
        <input value={form.email} onChange={set('email')} />
      </Field>
      <Field label="Staff notes">
        <textarea rows={3} value={form.notes} onChange={set('notes')} placeholder="Allergies, preferences, anything the stylist should know" />
      </Field>
      <p className="small muted" style={{ margin: '-8px 0 0' }}>
        Notes are staff-only. The voice agent is never sent them.
      </p>
      <div className="modal-actions">
        <button onClick={onDone}>Cancel</button>
        <button className="primary" disabled={!form.firstName || !form.phone || save.isPending} onClick={submit}>
          {save.isPending ? 'Saving…' : 'Save customer'}
        </button>
      </div>
    </div>
  );
}
