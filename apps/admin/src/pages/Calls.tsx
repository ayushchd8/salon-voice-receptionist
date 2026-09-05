import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CallEvent, CallSummary, TranscriptTurn } from '@salon/contracts';
import { useCallSummaries, useCallSummary } from '../api/hooks';
import { Empty, ErrorNote, Loading, Modal } from '../components/ui';

/**
 * The call review screen.
 *
 * A summary is written for every call, successful or not, so this is the record
 * of what the agent actually did — including the calls it could not resolve.
 * The escalation filter is the queue a salon manager works through.
 */
export function Calls() {
  const [escalatedOnly, setEscalatedOnly] = useState(false);
  const [result, setResult] = useState('');
  const [search, setSearch] = useState('');
  const [openCallId, setOpenCallId] = useState<string | null>(null);

  const calls = useCallSummaries({
    ...(escalatedOnly ? { escalated: true } : {}),
    ...(result ? { actionResult: result } : {}),
    ...(search ? { search } : {}),
  });

  const escalatedCount = (calls.data ?? []).filter((c) => c.escalated).length;

  return (
    <>
      <h1>Call review</h1>
      <p className="page-sub">
        Every call the receptionist handled, with what it understood, what it did, and whether it
        worked. Written as the call happens, so calls still on the line appear here too — along
        with failed and abandoned ones, which are the ones worth reading.
      </p>

      <div className="toolbar">
        <div className="grow">
          <label>Search summaries</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="refund, colour, Tuesday…" />
        </div>
        <div>
          <label>Outcome</label>
          <select value={result} onChange={(e) => setResult(e.target.value)}>
            <option value="">Any</option>
            <option value="success">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="not_attempted">No action</option>
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Needs attention</label>
          <button className={escalatedOnly ? 'primary' : ''} onClick={() => setEscalatedOnly((v) => !v)}>
            Escalated only{escalatedCount > 0 && !escalatedOnly ? ` (${escalatedCount})` : ''}
          </button>
        </div>
      </div>

      <ErrorNote error={calls.error} />

      {calls.isLoading ? (
        <Loading what="calls" />
      ) : (calls.data ?? []).length === 0 ? (
        <Empty>No calls match these filters.</Empty>
      ) : (
        <div className="card card-tight">
          <table>
            <thead>
              <tr><th>When</th><th>Caller</th><th>Intent</th><th>Summary</th><th>Action</th><th /></tr>
            </thead>
            <tbody>
              {calls.data!.map((call) => (
                <tr key={call.id} className="clickable" onClick={() => setOpenCallId(call.callId)}>
                  <td style={{ width: 140 }}>
                    {new Date(call.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    {call.call.status === 'in_progress' ? (
                      // Written as the call happens, so it is visible before it ends.
                      <div className="small"><span className="badge warn">on the line now</span></div>
                    ) : (
                      <div className="small muted">
                        {call.call.durationSeconds !== null ? `${call.call.durationSeconds}s · ` : ''}
                        {call.call.transport}
                      </div>
                    )}
                  </td>
                  <td style={{ width: 160 }}>
                    {call.customerId ? (
                      <Link to={`/customers/${call.customerId}`} onClick={(e) => e.stopPropagation()}>
                        {call.customerName ?? 'Customer'}
                      </Link>
                    ) : (
                      <span className="muted">Unknown caller</span>
                    )}
                    <div className="small muted">{call.callerPhone ?? '—'}</div>
                  </td>
                  <td style={{ width: 150 }}>
                    {call.intents.slice(0, 2).map((i) => (
                      <span key={i} className="badge neutral" style={{ marginRight: 4 }}>{i}</span>
                    ))}
                  </td>
                  <td>
                    {call.summary}
                    {call.escalated && <div className="small" style={{ color: 'var(--danger)' }}>⚠ {call.escalationReason}</div>}
                  </td>
                  <td style={{ width: 150 }}>
                    <ActionBadge call={call} />
                  </td>
                  <td className="right" style={{ width: 60 }}>
                    <button className="link small">Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openCallId && <CallDetail callId={openCallId} onClose={() => setOpenCallId(null)} />}
    </>
  );
}

function ActionBadge({ call }: { call: CallSummary }) {
  if (call.appointmentAction === 'none') return <span className="muted small">no action</span>;
  const tone = call.actionResult === 'success' ? 'success' : call.actionResult === 'failed' ? 'failed' : 'neutral';
  return (
    <>
      <span className={`badge ${tone}`}>{call.appointmentAction}</span>
      {call.failureReason && <div className="small muted">{call.failureReason}</div>}
    </>
  );
}

function CallDetail({ callId, onClose }: { callId: string; onClose: () => void }) {
  const detail = useCallSummary(callId);

  return (
    <Modal title="Call detail" onClose={onClose}>
      {detail.isLoading ? (
        <Loading what="call" />
      ) : detail.isError ? (
        <ErrorNote error={detail.error} />
      ) : (
        <div className="stack">
          <div>
            <label>Summary</label>
            <p style={{ margin: 0 }}>{detail.data!.summary}</p>
          </div>

          <div className="row">
            <div>
              <label>Outcome</label>
              <ActionBadge call={detail.data!} />
            </div>
            <div>
              <label>Intents</label>
              {detail.data!.intents.map((i) => <span key={i} className="badge neutral" style={{ marginRight: 4 }}>{i}</span>)}
            </div>
            <div>
              <label>Services discussed</label>
              {detail.data!.servicesDiscussed.length > 0 ? detail.data!.servicesDiscussed.join(', ') : <span className="muted">—</span>}
            </div>
          </div>

          {detail.data!.escalated && (
            <div className="alert warn">
              <strong>Escalated:</strong> {detail.data!.escalationReason}
              {detail.data!.callbackRequest && (
                <div className="small" style={{ marginTop: 6 }}>
                  Call back <strong>{detail.data!.callbackRequest.name}</strong> on {detail.data!.callbackRequest.phone}
                  {detail.data!.callbackRequest.preferredTime ? ` — ${detail.data!.callbackRequest.preferredTime}` : ''}
                  <div>Reason: {detail.data!.callbackRequest.reason}</div>
                </div>
              )}
            </div>
          )}

          {Array.isArray((detail.data!.call as { transcript?: TranscriptTurn[] }).transcript) && (
            <div>
              <label>Transcript</label>
              <div className="transcript">
                {(detail.data!.call as unknown as { transcript: TranscriptTurn[] }).transcript.map((turn, i) => (
                  <div key={i} className={`turn ${turn.role}`}>
                    <div className="who">{turn.role}</div>
                    <div>{turn.text}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {detail.data!.events.length > 0 && (
            <div>
              <label>What the agent did</label>
              <div className="transcript">
                <ul className="events" style={{ margin: 0, paddingLeft: 18 }}>
                  {(detail.data!.events as CallEvent[]).map((event, i) => (
                    <li key={i}>
                      <strong>{event.type}</strong>
                      {' '}
                      {JSON.stringify(event.detail)}
                      {event.latencyMs !== undefined && <span className="muted"> · {event.latencyMs}ms</span>}
                      {event.outcome && <span className="muted"> · {event.outcome}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <div className="modal-actions"><button onClick={onClose}>Close</button></div>
        </div>
      )}
    </Modal>
  );
}
