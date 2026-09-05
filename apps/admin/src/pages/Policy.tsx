import { useEffect, useState } from 'react';
import type { BookingPolicy } from '@salon/contracts';
import { usePolicy, useSavePolicy } from '../api/hooks';
import { ErrorNote, Field, Loading } from '../components/ui';

/** Each knob, with the sentence explaining what a caller will actually experience. */
const EXPLANATIONS: Record<string, string> = {
  minLeadMinutes: 'How much notice a booking needs. Slots inside this window are never offered.',
  maxAdvanceDays: 'How far ahead customers may book.',
  cancellationWindowHours: 'Cancel or move inside this window and the late fee applies.',
  lateCancellationFee: 'Charged for a late cancellation. Set to 0 to never charge one.',
  noShowFee: 'Recorded against a customer marked as a no-show.',
  slotGranularityMinutes: 'The spacing of offered start times — 15 gives :00, :15, :30, :45.',
  maxActiveAppointmentsPerCustomer: 'Upcoming appointments one customer may hold at once.',
};

export function Policy() {
  const policy = usePolicy();
  const save = useSavePolicy();
  const [form, setForm] = useState<BookingPolicy | null>(null);

  useEffect(() => {
    if (policy.data) setForm(policy.data);
  }, [policy.data]);

  if (policy.isLoading || !form) return <Loading what="booking policy" />;

  const set = (key: keyof BookingPolicy, value: unknown) => setForm({ ...form, [key]: value } as BookingPolicy);

  const numberField = (key: keyof BookingPolicy, label: string, step = 1) => (
    <Field label={label}>
      <input type="number" min={0} step={step} value={String(form[key])} onChange={(e) => set(key, Number(e.target.value))} />
      <div className="small muted" style={{ marginTop: 4 }}>{EXPLANATIONS[key]}</div>
    </Field>
  );

  const moneyField = (key: keyof BookingPolicy, label: string) => (
    <Field label={`${label} (${form.currency})`}>
      <input value={String(form[key])} onChange={(e) => set(key, e.target.value)} placeholder="0.00" />
      <div className="small muted" style={{ marginTop: 4 }}>{EXPLANATIONS[key]}</div>
    </Field>
  );

  return (
    <>
      <h1>Booking policy</h1>
      <p className="page-sub">
        These rules are enforced by the API, so the voice agent, this screen and any future
        integration all obey them identically. Changing a salon&apos;s behaviour happens here, not in code.
      </p>

      <ErrorNote error={policy.error ?? save.error} />
      {save.isSuccess && <div className="alert info">Policy saved.</div>}

      <div className="card">
        <div className="row">
          {numberField('minLeadMinutes', 'Minimum notice (minutes)', 15)}
          {numberField('maxAdvanceDays', 'Maximum advance booking (days)')}
        </div>
        <div className="row">
          {numberField('cancellationWindowHours', 'Cancellation window (hours)')}
          {moneyField('lateCancellationFee', 'Late cancellation fee')}
          {moneyField('noShowFee', 'No-show fee')}
        </div>
        <div className="row">
          <Field label="Slot granularity (minutes)">
            <select
              value={form.slotGranularityMinutes}
              onChange={(e) => set('slotGranularityMinutes', Number(e.target.value))}
            >
              {[5, 10, 15, 20, 30, 60].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <div className="small muted" style={{ marginTop: 4 }}>{EXPLANATIONS.slotGranularityMinutes}</div>
          </Field>
          {numberField('maxActiveAppointmentsPerCustomer', 'Max upcoming per customer')}
          <Field label="Allow staff double-booking">
            <select value={String(form.allowDoubleBooking)} onChange={(e) => set('allowDoubleBooking', e.target.value === 'true')}>
              <option value="false">No</option>
              <option value="true">Yes — staff may squeeze someone in</option>
            </select>
            <div className="small muted" style={{ marginTop: 4 }}>
              Even when enabled, only staff can overlap a booking. The voice agent never can.
            </div>
          </Field>
        </div>

        <div className="modal-actions">
          <button
            className="primary"
            disabled={save.isPending}
            onClick={() => {
              const { currency: _currency, ...patch } = form;
              save.mutate(patch);
            }}
          >
            {save.isPending ? 'Saving…' : 'Save policy'}
          </button>
        </div>
      </div>
    </>
  );
}
