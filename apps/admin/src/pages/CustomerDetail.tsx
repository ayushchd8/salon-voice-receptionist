import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAppointments, useCallSummaries, useCustomer } from '../api/hooks';
import { Badge, Empty, ErrorNote, Loading, Modal, money } from '../components/ui';
import { CustomerForm } from './Customers';
import { BookingForm } from '../components/BookingForm';

export function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const customer = useCustomer(id);
  const appointments = useAppointments({ customerId: id, status: '' });
  const calls = useCallSummaries({});
  const [editing, setEditing] = useState(false);
  const [booking, setBooking] = useState(false);

  if (customer.isLoading) return <Loading what="customer" />;
  if (customer.isError) return <ErrorNote error={customer.error} />;
  const c = customer.data!;

  const theirCalls = (calls.data ?? []).filter((call) => call.customerId === id);
  const history = [...(appointments.data ?? [])].sort((a, b) => b.start.localeCompare(a.start));

  return (
    <>
      <div className="page-head">
        <h1>{c.firstName} {c.lastName ?? ''}</h1>
        <div className="inline">
          <button onClick={() => setEditing(true)}>Edit</button>
          <button className="primary" onClick={() => setBooking(true)}>Book appointment</button>
        </div>
      </div>
      <p className="page-sub">
        <Link to="/customers">← All customers</Link>
      </p>

      <div className="card">
        <div className="row">
          <div><label>Phone</label>{c.phone}</div>
          <div><label>Email</label>{c.email ?? <span className="muted">—</span>}</div>
          <div><label>Customer since</label>{new Date(c.createdAt).toLocaleDateString()}</div>
        </div>
        {c.notes && (
          <>
            <label style={{ marginTop: 14 }}>Staff notes</label>
            <div className="alert warn" style={{ marginBottom: 0 }}>{c.notes}</div>
          </>
        )}
      </div>

      <h2>Appointment history</h2>
      {history.length === 0 ? (
        <Empty>No appointments yet.</Empty>
      ) : (
        <div className="card card-tight">
          <table>
            <thead><tr><th>When</th><th>Service</th><th>Stylist</th><th>Status</th><th className="right">Price</th></tr></thead>
            <tbody>
              {history.map((a) => (
                <tr key={a.id}>
                  <td>{a.localDate} <span className="muted">{a.localTime}</span></td>
                  <td>{a.service.name}</td>
                  <td>{a.staff.name}</td>
                  <td><Badge value={a.status} />{a.source === 'voice' && <span className="small muted"> via phone</span>}</td>
                  <td className="right">{money(a.priceAtBooking, a.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginTop: 24 }}>Calls</h2>
      {theirCalls.length === 0 ? (
        <Empty>No recorded calls from this customer.</Empty>
      ) : (
        <div className="card card-tight">
          <table>
            <thead><tr><th>When</th><th>Summary</th><th>Outcome</th></tr></thead>
            <tbody>
              {theirCalls.map((call) => (
                <tr key={call.id}>
                  <td style={{ width: 150 }}>{new Date(call.createdAt).toLocaleString()}</td>
                  <td>{call.summary}</td>
                  <td style={{ width: 130 }}>
                    <Badge value={call.actionResult === 'success' ? 'success' : call.actionResult === 'failed' ? 'failed' : 'neutral'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Modal title="Edit customer" onClose={() => setEditing(false)}>
          <CustomerForm initial={c} onDone={() => setEditing(false)} />
        </Modal>
      )}
      {booking && (
        <Modal title={`Book for ${c.firstName}`} onClose={() => setBooking(false)}>
          <BookingForm presetCustomerId={c.id} onDone={() => setBooking(false)} />
        </Modal>
      )}
    </>
  );
}
