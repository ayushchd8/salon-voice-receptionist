import { useState } from 'react';
import type { Service } from '@salon/contracts';
import { useSaveService, useServices } from '../api/hooks';
import { Badge, Empty, ErrorNote, fieldErrorsOf, Field, Loading, Modal, money } from '../components/ui';

export function Services() {
  const services = useServices('all');
  const [editing, setEditing] = useState<Service | 'new' | null>(null);
  const save = useSaveService();

  return (
    <>
      <div className="page-head">
        <h1>Services</h1>
        <button className="primary" onClick={() => setEditing('new')}>New service</button>
      </div>
      <p className="page-sub">
        The menu the voice agent quotes from. Retiring a service hides it from callers without
        touching appointments already booked against it.
      </p>

      <ErrorNote error={services.error} />

      {services.isLoading ? (
        <Loading what="services" />
      ) : (services.data ?? []).length === 0 ? (
        <Empty>No services configured.</Empty>
      ) : (
        <div className="card card-tight">
          <table>
            <thead>
              <tr><th>Service</th><th>Category</th><th>Duration</th><th>Buffer</th><th className="right">Price</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {services.data!.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.name}</strong>
                    {s.description && <div className="small muted">{s.description}</div>}
                  </td>
                  <td className="muted">{s.category}</td>
                  <td>{s.durationMinutes} min</td>
                  <td className="muted small">
                    {s.bufferBeforeMinutes || s.bufferAfterMinutes
                      ? `${s.bufferBeforeMinutes} / ${s.bufferAfterMinutes} min`
                      : '—'}
                  </td>
                  <td className="right">{money(s.price, s.currency)}</td>
                  <td><Badge value={s.active ? 'booked' : 'inactive'} /></td>
                  <td className="right">
                    <div className="inline" style={{ justifyContent: 'flex-end' }}>
                      <button className="small" onClick={() => setEditing(s)}>Edit</button>
                      <button
                        className="small"
                        onClick={() => save.mutate({ id: s.id, active: !s.active })}
                        disabled={save.isPending}
                      >
                        {s.active ? 'Retire' : 'Restore'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Modal title={editing === 'new' ? 'New service' : `Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <ServiceForm service={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />
        </Modal>
      )}
    </>
  );
}

function ServiceForm({ service, onDone }: { service?: Service; onDone: () => void }) {
  const [form, setForm] = useState({
    name: service?.name ?? '',
    description: service?.description ?? '',
    category: service?.category ?? 'hair',
    durationMinutes: service?.durationMinutes ?? 60,
    bufferBeforeMinutes: service?.bufferBeforeMinutes ?? 0,
    bufferAfterMinutes: service?.bufferAfterMinutes ?? 15,
    price: service?.price ?? '0.00',
  });
  const save = useSaveService();
  const errors = fieldErrorsOf(save.error);

  const num = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: Number(e.target.value) }));
  const str = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <div className="stack">
      <ErrorNote error={save.error} />
      <Field label="Name" error={errors.name}><input value={form.name} onChange={str('name')} autoFocus /></Field>
      <Field label="Description"><textarea rows={2} value={form.description} onChange={str('description')} /></Field>
      <div className="row">
        <Field label="Category"><input value={form.category} onChange={str('category')} /></Field>
        <Field label="Price" error={errors.price}><input value={form.price} onChange={str('price')} placeholder="55.00" /></Field>
      </div>
      <div className="row">
        <Field label="Duration (min)" error={errors.durationMinutes}>
          <input type="number" min={5} step={5} value={form.durationMinutes} onChange={num('durationMinutes')} />
        </Field>
        <Field label="Buffer before"><input type="number" min={0} step={5} value={form.bufferBeforeMinutes} onChange={num('bufferBeforeMinutes')} /></Field>
        <Field label="Buffer after"><input type="number" min={0} step={5} value={form.bufferAfterMinutes} onChange={num('bufferAfterMinutes')} /></Field>
      </div>
      <p className="small muted" style={{ margin: '-6px 0 0' }}>
        Buffers block the diary either side of the appointment without changing the time the
        customer is quoted.
      </p>
      <div className="modal-actions">
        <button onClick={onDone}>Cancel</button>
        <button
          className="primary"
          disabled={!form.name || save.isPending}
          onClick={() => save.mutate({ ...(service ? { id: service.id } : {}), ...form } as never, { onSuccess: onDone })}
        >
          {save.isPending ? 'Saving…' : 'Save service'}
        </button>
      </div>
    </div>
  );
}
