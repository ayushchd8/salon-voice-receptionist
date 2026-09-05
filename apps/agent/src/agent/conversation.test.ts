/**
 * End-to-end conversation tests.
 *
 * Each of these corresponds to a line in the brief's Definition of Done. They
 * drive the real orchestrator, the real tool layer and the real guards, over
 * real HTTP to a CRM that can be told to fail in specific ways.
 *
 * The model is the scripted policy rather than a live LLM. That is deliberate:
 * what these assert are properties of the *harness* — that confirmation gates
 * the write, that ambiguity forces a question, that a retry cannot duplicate a
 * booking, that a failed write is never reported as success. Those hold
 * regardless of which model is plugged in, and testing them against a real LLM
 * would make the suite slow, costly and non-deterministic while proving less.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { CrmClient } from '../crm/client.js';
import { CallRunner } from './callRunner.js';
import { ScriptedAdapter, type ScriptStep } from '../llm/scripted.js';
import { toolsForState } from '../tools/definitions.js';
import { FakeCrm } from '../test-support/fakeCrm.js';
import type { LlmTurn } from '../llm/types.js';

const crmServer = new FakeCrm();
let crm: CrmClient;

let counter = 0;
const call = (name: string, input: Record<string, unknown> = {}) => ({
  id: `t${(counter += 1)}`,
  name,
  input,
});
const say = (text: string): LlmTurn => ({ text, toolCalls: [] });
const use = (name: string, input: Record<string, unknown> = {}): LlmTurn => ({
  text: '',
  toolCalls: [call(name, input)],
});

async function startCall(steps: ScriptStep[] = []) {
  return CallRunner.start({
    callerPhone: '+447700900001',
    transport: 'test',
    crm,
    llm: new ScriptedAdapter(steps),
  });
}

beforeAll(async () => {
  await crmServer.start();
  crm = new CrmClient(crmServer.url, 'sk_agent_test_key');
});
afterAll(async () => {
  await crmServer.stop();
});
beforeEach(async () => {
  // Let any request from the previous test finish before wiping the fixtures,
  // so a late arrival cannot corrupt this one.
  await crmServer.quiesce();
  crmServer.reset();
});

describe('booking a new appointment', () => {
  it('walks availability → proposal → confirmation → booking', async () => {
    const runner = await startCall([
      { when: /book/i, once: true, then: use('check_availability', { serviceId: 'svc-cut', timeExpression: 'next tuesday afternoon' }) },
    ]);

    // The caller is recognised from their number before they say anything.
    expect(runner.session.customer?.firstName).toBe('Eleanor');

    // 1. They ask; the agent checks the real diary and offers times back.
    const offered = await runner.handleUserTurn("I'd like to book a cut and blow dry next Tuesday afternoon");
    expect(offered.toolsUsed).toContain('check_availability');
    expect(offered.utterance).toMatch(/I've got|Which suits/i);

    // 2. Nothing has been written — offering is not booking.
    expect(crmServer.appointments.size).toBe(0);
    expect(runner.session.pendingConfirmation).toBeNull();

    // 3. They pick a time; the agent stages it and reads the details back.
    const { ToolExecutor } = await import('../tools/executor.js');
    const executor = new ToolExecutor(crm, runner.session);
    const availability = await crm.getAvailability(
      { serviceId: 'svc-cut', timeExpression: 'next tuesday afternoon' },
      { callId: runner.session.callId },
    );
    const chosen = availability.slots[0]!;
    const staged = await executor.execute('propose_booking', {
      serviceId: 'svc-cut', start: chosen.start, staffId: chosen.staffId,
    });

    expect(staged.content.staged).toBe(true);
    expect(String(staged.content.restatement)).toContain('Cut & Blow Dry');
    expect(String(staged.content.restatement)).toMatch(/Shall I book that\?$/);
    expect(crmServer.appointments.size).toBe(0);

    // 4. They say yes, and only now is anything written.
    const committed = await executor.execute('commit_pending_action', { callerConfirmed: true });
    expect(committed.content.success).toBe(true);
    expect(crmServer.appointments.size).toBe(1);
    expect(runner.session.lastWriteOutcome!.result).toBe('success');

    await runner.end();
  });

  it('books only after the caller confirms, and not before', async () => {
    const runner = await startCall();
    const availability = await crm.getAvailability(
      { serviceId: 'svc-cut', timeExpression: 'next tuesday afternoon' },
      { callId: runner.session.callId },
    );
    const slot = availability.slots[0]!;

    // Stage the booking.
    const executor = new (await import('../tools/executor.js')).ToolExecutor(crm, runner.session);
    const staged = await executor.execute('propose_booking', {
      serviceId: 'svc-cut', start: slot.start, staffId: slot.staffId,
    });

    expect(staged.content.staged).toBe(true);
    expect(runner.session.state).toBe('CONFIRMING');
    // The critical assertion: proposing writes nothing.
    expect(crmServer.appointments.size).toBe(0);

    // Now commit.
    const committed = await executor.execute('commit_pending_action', { callerConfirmed: true });
    expect(committed.content.success).toBe(true);
    expect(crmServer.appointments.size).toBe(1);
    expect(runner.session.state).toBe('RESULT_SUCCESS');

    await runner.end();
  });

  it('refuses to commit without an explicit confirmation', async () => {
    const runner = await startCall();
    const { ToolExecutor } = await import('../tools/executor.js');
    const executor = new ToolExecutor(crm, runner.session);

    const availability = await crm.getAvailability({ serviceId: 'svc-cut', timeExpression: 'next tuesday' }, {});
    await executor.execute('propose_booking', {
      serviceId: 'svc-cut', start: availability.slots[0]!.start, staffId: availability.slots[0]!.staffId,
    });

    const refused = await executor.execute('commit_pending_action', { callerConfirmed: false });
    expect(refused.isError).toBe(true);
    expect(refused.content.error).toBe('NOT_CONFIRMED');
    expect(crmServer.appointments.size).toBe(0);

    await runner.end();
  });
});

describe('the write tool does not exist before confirmation', () => {
  it('withholds commit_pending_action until something is staged', () => {
    // This is the structural guarantee: the model cannot book without
    // confirming because at that point there is no function to call.
    for (const state of ['GREETING', 'ROUTING', 'COLLECTING', 'AVAILABILITY', 'LOOKUP'] as const) {
      const names = toolsForState(state, false).map((t) => t.name);
      expect(names).not.toContain('commit_pending_action');
      expect(names).toContain('propose_booking');
    }

    // Even in CONFIRMING, it appears only once a proposal actually exists.
    expect(toolsForState('CONFIRMING', false).map((t) => t.name)).not.toContain('commit_pending_action');
    expect(toolsForState('CONFIRMING', true).map((t) => t.name)).toContain('commit_pending_action');
  });
});

describe('an unavailable time is met with concrete alternatives', () => {
  it('offers nearby times rather than a dead end', async () => {
    crmServer.faults.forceSlotUnavailable = true;

    const runner = await startCall([
      { when: /.*/, once: true, then: use('check_availability', { serviceId: 'svc-cut', timeExpression: 'next tuesday afternoon' }) },
    ]);

    const result = await runner.handleUserTurn('Can I get a cut next Tuesday afternoon?');
    const lastTool = runner.session.toolCalls.at(-1)!;
    expect(lastTool.name).toBe('check_availability');

    // The caller is told no and given options in the same breath.
    expect(result.utterance).toMatch(/full|nothing free/i);
    expect(result.utterance).toMatch(/could do|would any/i);

    await runner.end();
  });

  it('offers alternatives when the slot is lost between offering and booking', async () => {
    const runner = await startCall();
    const { ToolExecutor } = await import('../tools/executor.js');
    const executor = new ToolExecutor(crm, runner.session);

    const availability = await crm.getAvailability({ serviceId: 'svc-cut', timeExpression: 'next tuesday' }, {});
    const slot = availability.slots[0]!;
    await executor.execute('propose_booking', { serviceId: 'svc-cut', start: slot.start, staffId: slot.staffId });

    // Somebody else takes it while the caller is deciding.
    crmServer.faults.forceSlotUnavailable = true;

    const result = await executor.execute('commit_pending_action', { callerConfirmed: true });
    expect(result.isError).toBe(true);
    expect(result.content.error).toBe('SLOT_UNAVAILABLE');
    expect(Array.isArray(result.content.alternatives)).toBe(true);
    expect((result.content.alternatives as unknown[]).length).toBeGreaterThan(0);

    await runner.end();
  });
});

describe('ambiguous cancellation triggers disambiguation, never a guess', () => {
  it('asks which appointment when the caller has two', async () => {
    crmServer.addAppointment(3, 10);
    crmServer.addAppointment(6, 15);

    const runner = await startCall([
      { when: /cancel/i, once: true, then: use('find_appointments') },
    ]);

    const result = await runner.handleUserTurn('I need to cancel my appointment');

    // The lookup must report ambiguity...
    expect(runner.session.candidates).toHaveLength(2);
    expect(runner.session.state).toBe('DISAMBIGUATION');
    // ...the agent must ask...
    expect(result.utterance).toMatch(/which one/i);
    // ...and crucially, nothing may have been cancelled.
    expect([...crmServer.appointments.values()].every((a) => a.status === 'booked')).toBe(true);
    expect(runner.session.pendingConfirmation).toBeNull();

    await runner.end();
  });

  it('hard-refuses a cancellation proposal with no appointment named', async () => {
    crmServer.addAppointment(3, 10);
    crmServer.addAppointment(6, 15);

    const runner = await startCall();
    const { ToolExecutor } = await import('../tools/executor.js');
    const executor = new ToolExecutor(crm, runner.session);
    await executor.execute('find_appointments', {});

    // Refused at the tool layer, not left to the model's judgement.
    const refused = await executor.execute('propose_cancellation', {});
    expect(refused.isError).toBe(true);
    expect(refused.content.error).toBe('APPOINTMENT_ID_REQUIRED');

    // And an id the agent did not look up is refused too.
    const foreign = await executor.execute('propose_cancellation', { appointmentId: 'apt-somebody-else' });
    expect(foreign.isError).toBe(true);
    expect(foreign.content.error).toBe('UNKNOWN_APPOINTMENT');

    await runner.end();
  });

  it('proceeds once the caller picks one', async () => {
    const first = crmServer.addAppointment(3, 10);
    crmServer.addAppointment(6, 15);

    const runner = await startCall();
    const { ToolExecutor } = await import('../tools/executor.js');
    const executor = new ToolExecutor(crm, runner.session);

    await executor.execute('find_appointments', {});
    const staged = await executor.execute('propose_cancellation', { appointmentId: first.id });
    expect(staged.content.staged).toBe(true);
    expect(String(staged.content.restatement)).toContain('Cut & Blow Dry');

    await executor.execute('commit_pending_action', { callerConfirmed: true });
    expect(crmServer.appointments.get(first.id)!.status).toBe('cancelled');
    // The other one is untouched.
    expect([...crmServer.appointments.values()].filter((a) => a.status === 'booked')).toHaveLength(1);

    await runner.end();
  });
});

describe('resolving an ambiguous appointment', () => {
  /**
   * Regression: the agent asked "which one did you mean?", the caller answered
   * "the first one", and the answer was not handled — so it fell through to a
   * generic greeting and asked again, forever. Reported from a live session.
   */
  it('acts on the caller\'s choice instead of asking again', async () => {
    crmServer.addAppointment(3, 10);   // Cut & Blow Dry
    crmServer.addAppointment(6, 15, 'svc-colour');

    const runner = await startCall();

    const asked = await runner.handleUserTurn('I need to cancel my appointment');
    expect(asked.utterance).toMatch(/which one/i);
    expect(runner.session.candidates).toHaveLength(2);

    // The turn that used to loop.
    const answered = await runner.handleUserTurn('the first one');

    expect(answered.toolsUsed).toContain('propose_cancellation');
    expect(answered.utterance).toMatch(/cancelling your/i);
    expect(answered.utterance).toMatch(/shall i go ahead/i);
    expect(answered.state).toBe('CONFIRMING');
    // ...and it must be the one they actually picked.
    expect(runner.session.pendingConfirmation!.appointmentId).toBe(
      [...crmServer.appointments.values()][0]!.id,
    );

    await runner.end();
  });

  it('completes the cancellation once confirmed', async () => {
    const first = crmServer.addAppointment(3, 10);
    crmServer.addAppointment(6, 15, 'svc-colour');

    const runner = await startCall();
    await runner.handleUserTurn('I need to cancel my appointment');
    await runner.handleUserTurn('the first one');
    const done = await runner.handleUserTurn('yes please');

    expect(done.toolsUsed).toContain('commit_pending_action');
    expect(crmServer.appointments.get(first.id)!.status).toBe('cancelled');
    // The other one is untouched.
    expect([...crmServer.appointments.values()].filter((a) => a.status === 'booked')).toHaveLength(1);
    // And it must not be described as a booking.
    expect(done.utterance).toMatch(/cancelled/i);
    expect(done.utterance).not.toMatch(/booked in/i);

    await runner.end();
  });

  it('resolves a choice made by service name rather than position', async () => {
    crmServer.addAppointment(3, 10);                 // Cut & Blow Dry
    const colour = crmServer.addAppointment(6, 15, 'svc-colour'); // Full Head Colour

    const runner = await startCall();
    await runner.handleUserTurn('I need to cancel my appointment');
    const answered = await runner.handleUserTurn('the colour one');

    expect(answered.toolsUsed).toContain('propose_cancellation');
    expect(runner.session.pendingConfirmation!.appointmentId).toBe(colour.id);

    await runner.end();
  });

  it('asks again rather than guessing when the answer is unclear', async () => {
    crmServer.addAppointment(3, 10);
    crmServer.addAppointment(6, 15, 'svc-colour');

    const runner = await startCall();
    await runner.handleUserTurn('I need to cancel my appointment');
    const unclear = await runner.handleUserTurn('erm, the usual one I think');

    // Guessing here cancels the wrong appointment.
    expect(unclear.toolsUsed).not.toContain('propose_cancellation');
    expect(unclear.utterance).toMatch(/was that/i);
    expect(runner.session.pendingConfirmation).toBeNull();

    await runner.end();
  });

  it('remembers the choice across turns while a reschedule is arranged', async () => {
    crmServer.addAppointment(3, 10);
    const colour = crmServer.addAppointment(6, 15, 'svc-colour');

    const runner = await startCall();
    await runner.handleUserTurn('I want to move my appointment');
    const chosen = await runner.handleUserTurn('the colour one');

    expect(chosen.toolsUsed).toContain('select_appointment');
    // The chosen id is on the session, so a summarised history cannot lose it.
    expect(runner.session.slots.appointmentId).toBe(colour.id);
    // ...and the ambiguity is gone, so it will not be re-asked.
    expect(runner.session.candidates).toHaveLength(1);
    expect(chosen.utterance).toMatch(/when would you like to move it to/i);

    await runner.end();
  });

  it('puts the appointment ids in the prompt, not only in the tool history', async () => {
    // The state block is restated every turn; conversation history is the part
    // that gets truncated. The id must live in the durable half.
    const a = crmServer.addAppointment(3, 10);
    const b = crmServer.addAppointment(6, 15, 'svc-colour');

    const runner = await startCall();
    await runner.handleUserTurn('I need to cancel my appointment');

    const { buildSystemPrompt } = await import('./prompt.js');
    const prompt = buildSystemPrompt(runner.session);
    expect(prompt).toContain(a.id);
    expect(prompt).toContain(b.id);
    expect(prompt).toMatch(/MUST ask which one/i);

    await runner.end();
  });

  it('refuses an appointment id that was never looked up for this caller', async () => {
    // Two appointments, so the lookup leaves the choice genuinely open rather
    // than pre-selecting the only one on file.
    crmServer.addAppointment(3, 10);
    crmServer.addAppointment(6, 15, 'svc-colour');

    const runner = await startCall();
    const { ToolExecutor } = await import('../tools/executor.js');
    const executor = new ToolExecutor(crm, runner.session);
    await executor.execute('find_appointments', {});
    expect(runner.session.slots.appointmentId).toBeUndefined();

    const refused = await executor.execute('select_appointment', { appointmentId: 'apt-someone-else' });
    expect(refused.isError).toBe(true);
    expect(refused.content.error).toBe('UNKNOWN_APPOINTMENT');
    // The stray id must not be adopted — acting on it would touch a stranger's booking.
    expect(runner.session.slots.appointmentId).toBeUndefined();
    expect(runner.session.candidates).toHaveLength(2);

    await runner.end();
  });
});

describe('a staged action is discarded unless the caller agrees to it', () => {
  /**
   * Regression, reported from a live session: the caller staged a cancellation,
   * then said "actually no, I want to move it instead". The staging survived,
   * and a later "yes" — to an entirely different question — cancelled the
   * appointment they had just said they wanted to keep.
   */
  it('throws away a cancellation the caller backed out of', async () => {
    const first = crmServer.addAppointment(3, 10);
    const second = crmServer.addAppointment(6, 15, 'svc-colour');

    const runner = await startCall();
    await runner.handleUserTurn('I need to cancel my appointment');
    await runner.handleUserTurn('the first one');
    expect(runner.session.pendingConfirmation).not.toBeNull();

    // The caller changes their mind.
    await runner.handleUserTurn('actually no, I want to move it instead');
    expect(runner.session.pendingConfirmation).toBeNull();
    expect(runner.session.state).not.toBe('CONFIRMING');

    // A later yes must not resurrect it.
    await runner.handleUserTurn('yes');

    expect(crmServer.appointments.get(first.id)!.status).toBe('booked');
    expect(crmServer.appointments.get(second.id)!.status).toBe('booked');
    await runner.end();
  });

  it('discards the staging on a yes that carries a correction', async () => {
    const appointment = crmServer.addAppointment(3, 10);
    crmServer.addAppointment(6, 15, 'svc-colour');

    const runner = await startCall();
    await runner.handleUserTurn('I need to cancel my appointment');
    await runner.handleUserTurn('the first one');

    // Contains "yes", but changes the plan. Committing here is the bug.
    await runner.handleUserTurn('yes but actually can we do the other one');
    expect(runner.session.pendingConfirmation).toBeNull();
    expect(crmServer.appointments.get(appointment.id)!.status).toBe('booked');

    await runner.end();
  });

  it('records the discard in the call trail', async () => {
    crmServer.addAppointment(3, 10);
    crmServer.addAppointment(6, 15, 'svc-colour');

    const runner = await startCall();
    await runner.handleUserTurn('I need to cancel my appointment');
    await runner.handleUserTurn('the first one');
    await runner.handleUserTurn('no, leave it');

    // A supervisor reviewing the call should see that the caller backed out.
    expect(runner.session.events.some(
      (e) => e.type === 'confirmation_received' && e.detail.affirmative === false && e.detail.discarded === true,
    )).toBe(true);
    await runner.end();
  });

  it('still commits on a clean yes', async () => {
    const appointment = crmServer.addAppointment(3, 10);
    crmServer.addAppointment(6, 15, 'svc-colour');

    const runner = await startCall();
    await runner.handleUserTurn('I need to cancel my appointment');
    await runner.handleUserTurn('the first one');
    await runner.handleUserTurn('yes please');

    expect(crmServer.appointments.get(appointment.id)!.status).toBe('cancelled');
    await runner.end();
  });
});

describe('state cached about the diary is invalidated when the diary changes', () => {
  /**
   * Regression, reported from a live session: the caller cancelled one
   * appointment and then asked to move "my appointment". The cancelled one was
   * still in the session's candidates, so the agent proposed rescheduling it —
   * and every commit failed, because it no longer existed.
   */
  it('does not propose an appointment it has just cancelled', async () => {
    const cut = crmServer.addAppointment(3, 10);
    const colour = crmServer.addAppointment(6, 15, 'svc-colour');

    const runner = await startCall();
    await runner.handleUserTurn('cancel my appointment');
    await runner.handleUserTurn('the first one');
    await runner.handleUserTurn('yes please');

    expect(crmServer.appointments.get(cut.id)!.status).toBe('cancelled');
    // Everything cached about the diary is dropped, because the diary moved.
    expect(runner.session.candidates).toHaveLength(0);
    expect(runner.session.slots.appointmentId).toBeUndefined();

    // The follow-up must target the appointment that still exists.
    await runner.handleUserTurn('actually I want to move my appointment instead');
    await runner.handleUserTurn('next tuesday morning');
    await runner.handleUserTurn('the first one');
    const moved = await runner.handleUserTurn('yes');

    expect(moved.state).toBe('RESULT_SUCCESS');
    expect(runner.session.lastWriteOutcome!.result).toBe('success');
    // The colour appointment was the one moved; the cancelled cut was not touched.
    expect(crmServer.appointments.get(colour.id)!.status).toBe('rescheduled');
    expect(crmServer.appointments.get(cut.id)!.status).toBe('cancelled');

    await runner.end();
  });

  it('points at the new appointment after a reschedule', async () => {
    crmServer.addAppointment(3, 10);
    const runner = await startCall();

    await runner.handleUserTurn('I want to move my appointment');
    await runner.handleUserTurn('next tuesday morning');
    await runner.handleUserTurn('the first one');
    await runner.handleUserTurn('yes');

    const created = [...crmServer.appointments.values()].find((a) => a.status === 'booked')!;
    expect(runner.session.lastWriteOutcome!.appointmentId).toBe(created.id);
    expect(runner.session.candidates).toHaveLength(0);
    expect(runner.session.slots.appointmentId).toBeUndefined();

    await runner.end();
  });
});

describe('a completed write clears everything cached about the diary', () => {
  /**
   * Regression: after cancelling a Cut & Blow Dry, the session still held that
   * service. The next request — to move a *Root Touch-Up* — searched
   * availability for the cancelled service, was offered a stylist who does not
   * perform root touch-ups, and failed on commit every time.
   */
  it('does not search availability with a cancelled appointment\'s service', async () => {
    const cut = crmServer.addAppointment(3, 10);                  // Cut & Blow Dry
    const colour = crmServer.addAppointment(6, 15, 'svc-colour'); // Full Head Colour

    const runner = await startCall();
    await runner.handleUserTurn('cancel my appointment');
    await runner.handleUserTurn('the first one');
    await runner.handleUserTurn('yes please');

    expect(crmServer.appointments.get(cut.id)!.status).toBe('cancelled');
    // Nothing about the cancelled appointment may survive.
    expect(runner.session.slots.serviceId).toBeUndefined();
    expect(runner.session.slots.serviceName).toBeUndefined();
    expect(runner.session.slots.staffId).toBeUndefined();

    // The follow-up must use the remaining appointment's own service.
    await runner.handleUserTurn('actually I want to move my other appointment');
    expect(runner.session.slots.serviceName).toBe('Full Head Colour');

    await runner.handleUserTurn('next tuesday morning');
    await runner.handleUserTurn('the first one');
    const moved = await runner.handleUserTurn('yes');

    expect(moved.state).toBe('RESULT_SUCCESS');
    expect(crmServer.appointments.get(colour.id)!.status).toBe('rescheduled');
    await runner.end();
  });

  it('leaves no residue from a completed request', async () => {
    crmServer.addAppointment(3, 10);
    const runner = await startCall();

    await runner.handleUserTurn('I want to move my appointment');
    await runner.handleUserTurn('next tuesday morning');
    await runner.handleUserTurn('the first one');
    await runner.handleUserTurn('yes');

    // The move happened...
    const created = [...crmServer.appointments.values()].find((a) => a.status === 'booked')!;
    expect(runner.session.lastWriteOutcome!.appointmentId).toBe(created.id);
    // ...and the request is finished, so nothing about it colours the next one.
    expect(runner.session.slots.appointmentId).toBeUndefined();
    expect(runner.session.slots.serviceName).toBeUndefined();
    expect(runner.session.activeIntent).toBeNull();
    await runner.end();
  });
});

describe('a staged action is kept only while retrying it could work', () => {
  it('keeps the staging — and the key — through a transient failure', async () => {
    crmServer.addAppointment(3, 10);
    const runner = await startCall();
    const { ToolExecutor } = await import('../tools/executor.js');
    const executor = new ToolExecutor(crm, runner.session);

    await executor.execute('find_appointments', {});
    await executor.execute('propose_cancellation', {
      appointmentId: [...crmServer.appointments.values()][0]!.id,
    });
    const key = runner.session.pendingConfirmation!.idempotencyKey;

    // Exhaust the client's own retries so the failure surfaces.
    crmServer.faults.failTimes.set('/cancel', {
      count: 99, status: 503, code: 'SERVICE_UNAVAILABLE', message: 'down',
    });
    await executor.execute('commit_pending_action', { callerConfirmed: true });

    // Still staged, same key — a later retry must not become a second request.
    expect(runner.session.pendingConfirmation).not.toBeNull();
    expect(runner.session.pendingConfirmation!.idempotencyKey).toBe(key);

    await runner.end();
  });

  it('discards the staging on a definitive refusal', async () => {
    // Retrying a cancellation of something already cancelled fails forever.
    // Keeping it staged is what produced the "shall I go ahead?" loop.
    crmServer.addAppointment(3, 10);
    const runner = await startCall();
    const { ToolExecutor } = await import('../tools/executor.js');
    const executor = new ToolExecutor(crm, runner.session);

    await executor.execute('find_appointments', {});
    await executor.execute('propose_cancellation', {
      appointmentId: [...crmServer.appointments.values()][0]!.id,
    });

    crmServer.faults.failTimes.set('/cancel', {
      count: 99, status: 422, code: 'APPOINTMENT_NOT_MODIFIABLE', message: 'already cancelled',
    });
    await executor.execute('commit_pending_action', { callerConfirmed: true });

    expect(runner.session.pendingConfirmation).toBeNull();
    // ...and the stale view of the diary is dropped, forcing a fresh lookup.
    expect(runner.session.candidates).toHaveLength(0);
    expect(runner.session.slots.appointmentId).toBeUndefined();

    await runner.end();
  });

  it('leaves the retry path reachable after a failure', async () => {
    // The commit tool follows the staged action, not the state name. A failed
    // write leaves the state at RESULT_FAILED; gating on CONFIRMING alone made
    // the documented retry impossible.
    const { toolsForState } = await import('../tools/definitions.js');
    expect(toolsForState('RESULT_FAILED', true).map((t) => t.name)).toContain('commit_pending_action');
    expect(toolsForState('RESULT_FAILED', false).map((t) => t.name)).not.toContain('commit_pending_action');
  });
});

describe('a proposal cannot be committed in the turn it was made', () => {
  it('withholds the commit tool until the caller has had a turn to answer', async () => {
    crmServer.addAppointment(3, 10);
    const runner = await startCall();
    const { ToolExecutor } = await import('../tools/executor.js');
    const executor = new ToolExecutor(crm, runner.session);

    await executor.execute('find_appointments', {});
    await executor.execute('propose_cancellation', {
      appointmentId: [...crmServer.appointments.values()][0]!.id,
    });

    // Staged on this turn: the restatement has not been spoken yet, so the
    // caller cannot possibly have agreed to it.
    const pending = runner.session.pendingConfirmation!;
    expect(pending.stagedOnTurn).toBe(runner.session.turnCount);

    const { toolsForState } = await import('../tools/definitions.js');
    const sameTurn = pending.stagedOnTurn < runner.session.turnCount;
    expect(sameTurn).toBe(false);
    expect(toolsForState('CONFIRMING', sameTurn).map((t) => t.name)).not.toContain('commit_pending_action');

    await runner.end();
  });

  it('offers it on the following turn', async () => {
    crmServer.addAppointment(3, 10);
    crmServer.addAppointment(6, 15, 'svc-colour');
    const runner = await startCall();

    await runner.handleUserTurn('cancel my appointment');
    await runner.handleUserTurn('the first one');   // proposal staged on this turn
    const committed = await runner.handleUserTurn('yes please');

    expect(committed.toolsUsed).toContain('commit_pending_action');
    await runner.end();
  });
});

describe('the state gate is enforced, not merely advertised', () => {
  it('refuses a write tool that was not offered this turn', async () => {
    // Guarantee 1 says commit_pending_action is absent before confirmation.
    // That is only a guarantee if calling it anyway is refused.
    const runner = await startCall([
      { when: /.*/, once: true, then: () => ({ text: '', toolCalls: [{ id: 'x1', name: 'commit_pending_action', input: { callerConfirmed: true } }] }) },
    ]);

    const turn = await runner.handleUserTurn('just book something, anything');

    expect(crmServer.appointments.size).toBe(0);
    expect(runner.session.events.some(
      (e) => e.type === 'guard_tripped' && e.detail.guard === 'tool_not_available',
    )).toBe(true);
    expect(turn.state).not.toBe('RESULT_SUCCESS');

    await runner.end();
  });
});

describe('choosing a service from the menu', () => {
  /**
   * Regression: the agent read the service list, the caller said "second one",
   * nothing handled it, and the menu was read out again — indefinitely.
   */
  it('acts on an ordinal choice instead of re-reading the list', async () => {
    const runner = await startCall();

    const listed = await runner.handleUserTurn('what services do you offer?');
    expect(listed.toolsUsed).toContain('list_services');

    const chosen = await runner.handleUserTurn('the second one');
    expect(chosen.toolsUsed).toContain('select_service');
    // Recorded on the session, so the next turn does not forget it.
    expect(runner.session.slots.serviceName).toBe('Full Head Colour');
    expect(chosen.utterance).toMatch(/when were you thinking/i);

    await runner.end();
  });

  it('does not read the menu twice in a row', async () => {
    const runner = await startCall();
    await runner.handleUserTurn('what do you offer?');
    const second = await runner.handleUserTurn('I want to book in');

    expect(second.toolsUsed).not.toContain('list_services');
    expect(second.utterance).toMatch(/which of those/i);

    await runner.end();
  });

  it('carries the chosen service through to a booking', async () => {
    const runner = await startCall();
    await runner.handleUserTurn('what do you offer?');
    await runner.handleUserTurn('the second one');
    await runner.handleUserTurn('next tuesday afternoon');
    await runner.handleUserTurn('the first one');
    const done = await runner.handleUserTurn('yes');

    expect(done.toolsUsed).toContain('commit_pending_action');
    expect(crmServer.appointments.size).toBe(1);
    expect([...crmServer.appointments.values()][0]!.serviceId).toBe('svc-colour');

    await runner.end();
  });
});

describe('naming a service', () => {
  /**
   * Regression: "I would like to book an appointment" silently resolved to
   * "Men's Cut", because service names were matched as substrings and
   * "appoint-men-t" contains "men". The agent then asked when they wanted their
   * men's cut, and every later turn disagreed with itself.
   */
  it('does not invent a service from a sentence that names none', async () => {
    const runner = await startCall();
    const turn = await runner.handleUserTurn('I would like to book an appointment');

    expect(runner.session.slots.serviceName).toBeUndefined();
    // It should ask, or read the menu — not silently pick one.
    expect(turn.toolsUsed).not.toContain('select_service');
    await runner.end();
  });

  it('recognises a service named without any booking word', async () => {
    const runner = await startCall();
    await runner.handleUserTurn('I would like to book an appointment');
    const named = await runner.handleUserTurn('a cut and blow dry');

    expect(named.toolsUsed).toContain('select_service');
    expect(runner.session.slots.serviceName).toBe('Cut & Blow Dry');
    await runner.end();
  });

  it('prefers the most specific service name', async () => {
    // "cut and blow dry" must not resolve to a bare "Blow Dry".
    const runner = await startCall();
    await runner.handleUserTurn('can I have a cut and blow dry next tuesday afternoon');
    expect(runner.session.slots.serviceName).toBe('Cut & Blow Dry');
    await runner.end();
  });

  it('answers a price question about one service with that service', async () => {
    const runner = await startCall();
    const priced = await runner.handleUserTurn('how much is a full head colour?');

    expect(priced.utterance).toMatch(/Full Head Colour/);
    expect(priced.utterance).toMatch(/110\.00/);
    expect(priced.utterance).toMatch(/120 minutes/);
    await runner.end();
  });

  it('carries a service named mid-conversation through to a booking', async () => {
    const runner = await startCall();
    await runner.handleUserTurn('I would like to book something');
    await runner.handleUserTurn('a full head colour');
    await runner.handleUserTurn('next tuesday afternoon');
    await runner.handleUserTurn('the first one');
    const done = await runner.handleUserTurn('yes please');

    expect(done.toolsUsed).toContain('commit_pending_action');
    expect([...crmServer.appointments.values()][0]!.serviceId).toBe('svc-colour');
    await runner.end();
  });
});

describe('carrying on after a booking', () => {
  async function bookSomething(runner: Awaited<ReturnType<typeof startCall>>) {
    await runner.handleUserTurn('I want to book a cut and blow dry');
    await runner.handleUserTurn('next tuesday afternoon');
    await runner.handleUserTurn('the first one');
    return runner.handleUserTurn('yes');
  }

  it('reads out the rest of the menu when asked what else there is', async () => {
    const runner = await startCall();
    await runner.handleUserTurn('what do you offer?');
    const more = await runner.handleUserTurn('what else do you have');

    expect(more.utterance).toMatch(/we also do/i);
    // Not a repeat of what they were already told.
    expect(more.utterance).not.toMatch(/^We do /);
    await runner.end();
  });

  it.each(['no thank you', "no thanks, that's all", "that's everything", "I'm good"])(
    'closes the call politely on %j',
    async (farewell) => {
      const runner = await startCall();
      await bookSomething(runner);
      const closing = await runner.handleUserTurn(farewell);

      expect(closing.toolsUsed).toContain('end_call');
      expect(closing.ended).toBe(true);
      await runner.end();
    },
  );

  it('starts a fresh booking rather than moving the one just made', async () => {
    // Straight after a booking there is legitimately an appointment id in
    // scope. Treating that as "we must be rescheduling" turned a second
    // booking into a move of the first.
    const runner = await startCall();
    await bookSomething(runner);
    expect(crmServer.appointments.size).toBe(1);
    expect(runner.session.activeIntent).toBeNull();

    await runner.handleUserTurn('make another appointment');
    await runner.handleUserTurn('a full head colour');
    // The new service must win over the one just booked.
    expect(runner.session.slots.serviceName).toBe('Full Head Colour');

    await runner.handleUserTurn('next thursday afternoon');
    await runner.handleUserTurn('the first one');
    const second = await runner.handleUserTurn('yes please');

    expect(second.state).toBe('RESULT_SUCCESS');
    // Two separate appointments, not one moved.
    const booked = [...crmServer.appointments.values()].filter((a) => a.status === 'booked');
    expect(booked).toHaveLength(2);
    expect(new Set(booked.map((a) => a.serviceId))).toEqual(new Set(['svc-cut', 'svc-colour']));

    await runner.end();
  });

  it('knows a move is a move, not a new booking', async () => {
    crmServer.addAppointment(3, 10);
    const runner = await startCall();

    await runner.handleUserTurn('I need to move my appointment');
    expect(runner.session.activeIntent).toBe('reschedule');

    await runner.handleUserTurn('next tuesday morning');
    await runner.handleUserTurn('the first one');
    await runner.handleUserTurn('yes');

    const booked = [...crmServer.appointments.values()].filter((a) => a.status === 'booked');
    expect(booked).toHaveLength(1);
    expect([...crmServer.appointments.values()].some((a) => a.status === 'rescheduled')).toBe(true);
    await runner.end();
  });
});

describe('a time the caller names is the time they get', () => {
  /**
   * Regression, reported from a live session: the caller asked for "Wednesday
   * 9:30 a.m." and was offered 9:30, and the agent proposed 10:30.
   *
   * The offered slots carry `start` as a UTC instant. The salon is in London,
   * so under British Summer Time the 10:30 slot's instant is `T09:30` — and the
   * matcher was comparing the caller's spoken *local* time against that raw UTC
   * string. Exactly one hour out, and only during BST, which is precisely the
   * kind of bug that survives a demo in December.
   */
  it('books the time that was asked for, not its UTC twin an hour later', async () => {
    const runner = await startCall();

    await runner.handleUserTurn('I want to book a full head colour');
    const offered = await runner.handleUserTurn('next wednesday morning');
    expect(offered.utterance).toMatch(/I've got/);

    // Take the exact local time the agent read out.
    const spoken = /at (\d{1,2}(?::\d{2})?\s*(?:am|pm))/i.exec(offered.utterance)![1]!;
    const picked = await runner.handleUserTurn(`wednesday ${spoken.replace(/(a|p)m/i, '$1.m.')}`);

    expect(picked.toolsUsed).toContain('propose_booking');
    // The restatement must name the time they asked for.
    expect(picked.utterance).toContain(spoken.replace(/\s+/g, ' '));

    await runner.handleUserTurn('yes please');
    const booked = [...crmServer.appointments.values()].find((a) => a.status === 'booked')!;

    // And the stored appointment must be that local time, not an hour off.
    const localHour = DateTime.fromISO(booked.start, { zone: 'Europe/London' }).toFormat('h:mm a')
      .replace(' AM', 'am').replace(' PM', 'pm').replace(':00', '');
    expect(spoken.replace(/\s+/g, '').toLowerCase()).toContain(localHour.replace(/\s+/g, '').toLowerCase().replace(/^0/, ''));

    await runner.end();
  });

  it('offers only as many times as it reads out', async () => {
    // The engine returns six; reading six down a phone is not helpful, and
    // "the third one" must mean the third one the caller actually heard.
    const runner = await startCall();
    await runner.handleUserTurn('I want to book a full head colour');
    const offered = await runner.handleUserTurn('next wednesday morning');

    const spokenTimes = offered.utterance.match(/\bat \d{1,2}(?::\d{2})?\s*(?:am|pm)/gi) ?? [];
    expect(spokenTimes.length).toBeLessThanOrEqual(3);
    await runner.end();
  });

  it('does not book a time it never offered', async () => {
    const runner = await startCall();
    await runner.handleUserTurn('I want to book a full head colour');
    await runner.handleUserTurn('next wednesday morning');

    // A time outside what was read out must not silently resolve to something
    // nearby — it should go back and look, not guess.
    const odd = await runner.handleUserTurn('how about 4:37 pm');
    expect(odd.toolsUsed).not.toContain('propose_booking');
    await runner.end();
  });

  it('goes and looks for a time it did not read out, rather than giving up', async () => {
    // Only three of the free slots are spoken, so a time that was not among
    // them may still be available. Answering "sorry, didn't catch that" to a
    // perfectly clear "ten o'clock" is the worst of both.
    const runner = await startCall();
    await runner.handleUserTurn('I want to book a blow dry');
    const offered = await runner.handleUserTurn('next friday morning');
    expect(offered.utterance).toMatch(/9 am/);

    const later = await runner.handleUserTurn('10am');
    expect(later.toolsUsed).toContain('check_availability');
    expect(later.utterance).toMatch(/10 am/);
    expect(later.utterance).not.toMatch(/didn't (quite )?catch/i);
    await runner.end();
  });

  it('reads a bare hour in the context of what is already being discussed', async () => {
    // "half past two" is 02:30 or 14:30. Discussing Thursday afternoon, only
    // one of those is a sane thing to search for.
    const runner = await startCall();
    await runner.handleUserTurn('I want to book a full head colour');
    await runner.handleUserTurn('next thursday afternoon');

    const afternoon = await runner.handleUserTurn('half past two');
    expect(afternoon.utterance).toMatch(/2:30 pm/);
    expect(afternoon.utterance).not.toMatch(/2:30 am/);
    await runner.end();
  });

  it.each([
    ['9:30 a.m.', '09:30'],
    ['9:30am', '09:30'],
    ['half past nine', '09:30'],
    ['2pm', '14:00'],
    ['quarter past 10', '10:15'],
  ])('reads %j as %s local', async (spoken, expected) => {
    const { __testing } = await import('../llm/scripted.js');
    expect(__testing.spokenTimeToLocal(spoken)).toContain(expected);
  });
});

describe('saying why a time is unavailable', () => {
  it('says the salon is closed rather than claiming to be full', async () => {
    // "We're full" when the doors are simply shut is wrong information, and a
    // caller will plan around it.
    const runner = await startCall();
    await runner.handleUserTurn('I want to book a blow dry');
    const sunday = await runner.handleUserTurn('sunday morning');

    expect(sunday.utterance).toMatch(/closed that day/i);
    expect(sunday.utterance).not.toMatch(/full/i);
    // ...and it still offers a way forward.
    expect(sunday.utterance).toMatch(/I could do|another day/i);
    await runner.end();
  });
});

describe('answering what was actually asked', () => {
  /**
   * A near-miss answer — the opening hours in response to a question about the
   * cancellation policy — reads as the agent not listening. These pin the
   * phrasings that were landing on the generic fallback or the wrong answer.
   */
  it('answers about a specific day rather than reciting the week', async () => {
    const runner = await startCall();
    const sunday = await runner.handleUserTurn('are you open on Sundays?');
    expect(sunday.utterance).toMatch(/closed on Sundays/i);

    const tuesday = await runner.handleUserTurn('what about Tuesdays?');
    expect(tuesday.utterance).toMatch(/Tuesdays we're open/i);
    await runner.end();
  });

  it('answers a cancellation-policy question with the policy', async () => {
    const runner = await startCall();
    const answer = await runner.handleUserTurn('how much notice do you need to cancel?');

    expect(answer.utterance).toMatch(/24 hours notice/i);
    expect(answer.utterance).toMatch(/fee/i);
    // Not the opening hours.
    expect(answer.utterance).not.toMatch(/09:00/);
    await runner.end();
  });

  it('answers a price or duration question about one service', async () => {
    const runner = await startCall();
    const priced = await runner.handleUserTurn('how long does a keratin treatment take?');
    expect(priced.utterance).toMatch(/Keratin Treatment/);
    expect(priced.utterance).toMatch(/180 minutes/);
    await runner.end();
  });

  it.each([
    'can you fit me in on Friday?',
    'do you have anything next week?',
    'any chance of an appointment on Tuesday?',
  ])('treats %j as wanting to book', async (utterance) => {
    const runner = await startCall();
    const turn = await runner.handleUserTurn(utterance);
    // Either it asks which service or reads the menu — never the "didn't catch that" reply.
    expect(turn.utterance).not.toMatch(/didn't (quite )?catch/i);
    await runner.end();
  });

  it.each(['I need to rearrange my appointment', 'can I swap my appointment', 'I want to shift my booking'])(
    'treats %j as a reschedule',
    async (utterance) => {
      crmServer.addAppointment(3, 10);
      const runner = await startCall();
      const turn = await runner.handleUserTurn(utterance);

      expect(runner.session.activeIntent).toBe('reschedule');
      expect(turn.toolsUsed).toContain('find_appointments');
      await runner.end();
    },
  );

  it('reads out both appointments when simply asked when they are booked', async () => {
    crmServer.addAppointment(3, 10);
    crmServer.addAppointment(6, 15, 'svc-colour');
    const runner = await startCall();

    const asked = await runner.handleUserTurn('when am I booked in?');
    // A question, not a choice to make — it should not interrogate them.
    expect(asked.utterance).not.toMatch(/which one did you mean/i);
    expect(asked.utterance).toMatch(/Cut & Blow Dry/);
    expect(asked.utterance).toMatch(/Full Head Colour/);
    await runner.end();
  });

  it('still asks which one when they want to change something', async () => {
    crmServer.addAppointment(3, 10);
    crmServer.addAppointment(6, 15, 'svc-colour');
    const runner = await startCall();

    const asked = await runner.handleUserTurn('I want to cancel my appointment');
    expect(asked.utterance).toMatch(/which one did you mean/i);
    await runner.end();
  });
});

describe('a conversation that stops progressing is escalated', () => {
  it('offers a human rather than repeating the same turn indefinitely', async () => {
    // A caller the agent genuinely cannot follow.
    const runner = await startCall();

    const turns = [];
    for (const said of ['mmm hmm whatever', 'the thing with the stuff', 'you know, the usual']) {
      turns.push(await runner.handleUserTurn(said));
    }

    // Deliberately conservative: being misunderstood once or twice is a normal
    // phone call. Three times running is not, and a person should take over.
    expect(turns[0]!.utterance).toMatch(/didn't (quite )?catch/i);
    expect(turns.at(-1)!.utterance).toMatch(/call you back|someone from the salon/i);
    expect(runner.session.escalation).not.toBeNull();
    expect(runner.session.events.some(
      (e) => e.type === 'guard_tripped' && e.detail.guard === 'conversation_stalled',
    )).toBe(true);

    await runner.end();
  });

  it('does not escalate a conversation that is making progress', async () => {
    crmServer.addAppointment(3, 10);
    const runner = await startCall();

    // Three questions in a row change nothing about the booking state, but the
    // agent is answering them — that is a conversation, not a stall.
    await runner.handleUserTurn('what time do you open on saturday?');
    await runner.handleUserTurn('how much is a cut and blow dry?');
    const third = await runner.handleUserTurn('when is my appointment?');

    expect(runner.session.escalation).toBeNull();
    expect(third.utterance).not.toMatch(/call you back/i);

    await runner.end();
  });
});

describe('a retried booking must not duplicate', () => {
  it('reuses the same idempotency key when the first attempt times out', async () => {
    const runner = await startCall();
    const { ToolExecutor } = await import('../tools/executor.js');
    const executor = new ToolExecutor(crm, runner.session);

    const availability = await crm.getAvailability({ serviceId: 'svc-cut', timeExpression: 'next tuesday' }, {});
    const slot = availability.slots[0]!;
    await executor.execute('propose_booking', { serviceId: 'svc-cut', start: slot.start, staffId: slot.staffId });
    const stagedKey = runner.session.pendingConfirmation!.idempotencyKey;

    // The first two attempts fail transiently; the client retries automatically.
    crmServer.faults.failTimes.set('/v1/appointments', {
      count: 2, status: 503, code: 'SERVICE_UNAVAILABLE', message: 'Temporarily unavailable.',
    });

    const result = await executor.execute('commit_pending_action', { callerConfirmed: true });
    expect(result.content.success).toBe(true);

    // Exactly one appointment exists...
    expect(crmServer.appointments.size).toBe(1);
    // ...and every attempt carried the key minted when the action was staged.
    const bookingWrites = crmServer.writeLog.filter((w) => w.path === '/v1/appointments');
    expect(bookingWrites.length).toBeGreaterThan(1);
    expect(new Set(bookingWrites.map((w) => w.idempotencyKey))).toEqual(new Set([stagedKey]));

    await runner.end();
  });

  it('replays rather than rebooking when the same request is sent twice', async () => {
    const runner = await startCall();
    const { ToolExecutor } = await import('../tools/executor.js');
    const executor = new ToolExecutor(crm, runner.session);

    const availability = await crm.getAvailability({ serviceId: 'svc-cut', timeExpression: 'next tuesday' }, {});
    const slot = availability.slots[0]!;
    await executor.execute('propose_booking', { serviceId: 'svc-cut', start: slot.start, staffId: slot.staffId });
    const key = runner.session.pendingConfirmation!.idempotencyKey;

    await executor.execute('commit_pending_action', { callerConfirmed: true });
    expect(crmServer.appointments.size).toBe(1);

    // Re-send byte-for-byte what the agent already sent — a network echo, or a
    // retry whose first response was lost. It must replay, not rebook.
    const sent = crmServer.writeLog.find((w) => w.path === '/v1/appointments')!;
    const replay = await crm.bookAppointment(sent.body as Record<string, unknown>, key, {});

    expect(replay.id).toBe([...crmServer.appointments.values()][0]!.id);
    expect(crmServer.appointments.size).toBe(1);

    await runner.end();
  });
});

describe('the agent never claims a success the API did not return', () => {
  it('suppresses a false success claim after a failed write', async () => {
    const runner = await startCall([
      // A model that lies about the outcome — exactly what the guard is for.
      { when: /.*/, then: say("Lovely, you're booked in for Tuesday at two. See you then!") },
    ]);
    const { ToolExecutor } = await import('../tools/executor.js');
    const executor = new ToolExecutor(crm, runner.session);

    const availability = await crm.getAvailability({ serviceId: 'svc-cut', timeExpression: 'next tuesday' }, {});
    const slot = availability.slots[0]!;
    await executor.execute('propose_booking', { serviceId: 'svc-cut', start: slot.start, staffId: slot.staffId });

    crmServer.faults.failTimes.set('/v1/appointments', {
      count: 99, status: 500, code: 'INTERNAL_ERROR', message: 'Database exploded.',
    });
    const write = await executor.execute('commit_pending_action', { callerConfirmed: true });
    expect(write.isError).toBe(true);
    expect(runner.session.lastWriteOutcome!.result).toBe('failed');

    // The model now tries to tell the caller it worked.
    const turn = await runner.handleUserTurn('great, thanks');

    expect(turn.guardTripped).toBe(true);
    expect(turn.utterance).not.toMatch(/you'?re booked/i);
    expect(turn.utterance).toMatch(/sorry|wasn'?t able|couldn'?t/i);
    // The trip is recorded for review, not silently swallowed.
    expect(runner.session.events.some((e) => e.type === 'guard_tripped')).toBe(true);

    await runner.end();
  });

  it('says "I am not sure" rather than "it failed" when a write times out', async () => {
    const runner = await startCall([
      { when: /.*/, then: say("All set — I've booked that in for you.") },
    ]);
    const { ToolExecutor } = await import('../tools/executor.js');
    const executor = new ToolExecutor(crm, runner.session);

    const availability = await crm.getAvailability({ serviceId: 'svc-cut', timeExpression: 'next tuesday' }, {});
    const slot = availability.slots[0]!;
    await executor.execute('propose_booking', { serviceId: 'svc-cut', start: slot.start, staffId: slot.staffId });

    // The server hangs for longer than the client's deadline. The write may or
    // may not have landed — the agent must not assert either way.
    crmServer.faults.delayMs.set('/v1/appointments', 1_500);
    const impatient = new CrmClient(crmServer.url, 'sk_agent_test_key', { timeoutMs: 250, maxRetries: 1 });
    const slowExecutor = new (await import('../tools/executor.js')).ToolExecutor(impatient, runner.session);
    await slowExecutor.execute('commit_pending_action', { callerConfirmed: true });

    expect(runner.session.lastWriteOutcome!.result).toBe('unknown');

    const turn = await runner.handleUserTurn('thanks');
    expect(turn.guardTripped).toBe(true);
    expect(turn.utterance).toMatch(/couldn'?t get confirmation|can'?t tell you for certain/i);

    await runner.end();
  }, 30_000);

  it('lets an honest report of failure through untouched', async () => {
    const honest = "I'm sorry, I wasn't able to book that — shall I try another time?";
    const runner = await startCall([{ when: /.*/, then: say(honest) }]);
    const { ToolExecutor } = await import('../tools/executor.js');
    const executor = new ToolExecutor(crm, runner.session);

    const availability = await crm.getAvailability({ serviceId: 'svc-cut', timeExpression: 'next tuesday' }, {});
    const slot = availability.slots[0]!;
    await executor.execute('propose_booking', { serviceId: 'svc-cut', start: slot.start, staffId: slot.staffId });
    crmServer.faults.failTimes.set('/v1/appointments', {
      count: 99, status: 500, code: 'INTERNAL_ERROR', message: 'nope',
    });
    await executor.execute('commit_pending_action', { callerConfirmed: true });

    const turn = await runner.handleUserTurn('ok');
    expect(turn.guardTripped).toBe(false);
    expect(turn.utterance).toBe(honest);

    await runner.end();
  });

  it('leaves a genuine success alone', async () => {
    const runner = await startCall([
      { when: /.*/, then: say("Lovely — you're booked in. See you Tuesday!") },
    ]);
    const { ToolExecutor } = await import('../tools/executor.js');
    const executor = new ToolExecutor(crm, runner.session);

    const availability = await crm.getAvailability({ serviceId: 'svc-cut', timeExpression: 'next tuesday' }, {});
    const slot = availability.slots[0]!;
    await executor.execute('propose_booking', { serviceId: 'svc-cut', start: slot.start, staffId: slot.staffId });
    await executor.execute('commit_pending_action', { callerConfirmed: true });

    const turn = await runner.handleUserTurn('thanks!');
    expect(turn.guardTripped).toBe(false);
    expect(turn.utterance).toMatch(/booked in/i);

    await runner.end();
  });
});

describe('privacy', () => {
  it('never reads staff notes aloud, even if the model tries', async () => {
    const runner = await startCall([
      { when: /.*/, then: say('I can see here that you are allergic to ammonia-based colour.') },
    ]);
    const turn = await runner.handleUserTurn('what do you have on file for me?');

    expect(turn.guardTripped).toBe(true);
    expect(turn.utterance).not.toMatch(/allergic/i);
    await runner.end();
  });
});

describe('a call is recorded while it is still happening', () => {
  /**
   * Regression, reported live: two appointments were booked and showed up in
   * the diary, but the call itself was nowhere in the CRM. The summary and the
   * transcript were only written when a call *ended*, so a caller who books and
   * leaves the line open is invisible to the salon — and a call that is never
   * cleanly hung up left an empty row and no transcript at all.
   */
  it('writes a summary before the call has ended', async () => {
    const runner = await startCall();

    await runner.handleUserTurn('I want to book a full head colour');
    runner.persistProgress();
    await new Promise((r) => setTimeout(r, 50));

    // Visible to the salon mid-call, not only afterwards.
    expect(crmServer.callSummaries.length).toBeGreaterThan(0);
    expect(crmServer.endedCalls.size).toBe(0);

    await runner.end();
  });

  it('keeps the transcript up to date as the call goes on', async () => {
    const runner = await startCall();

    await runner.handleUserTurn('what do you offer?');
    runner.persistProgress();
    await new Promise((r) => setTimeout(r, 50));
    const afterOne = crmServer.callTranscripts.get(runner.session.callId) ?? [];

    await runner.handleUserTurn('how much is a blow dry?');
    runner.persistProgress();
    await new Promise((r) => setTimeout(r, 50));
    const afterTwo = crmServer.callTranscripts.get(runner.session.callId) ?? [];

    expect(afterOne.length).toBeGreaterThan(0);
    expect(afterTwo.length).toBeGreaterThan(afterOne.length);

    await runner.end();
  });

  it('records a booking on the call even if the caller never hangs up', async () => {
    const runner = await startCall();

    await runner.handleUserTurn('I want to book a full head colour');
    await runner.handleUserTurn('next tuesday afternoon');
    await runner.handleUserTurn('the first one');
    await runner.handleUserTurn('yes please');
    runner.persistProgress();
    await new Promise((r) => setTimeout(r, 50));

    // The appointment exists...
    expect(crmServer.appointments.size).toBe(1);
    // ...and so does the call that made it, before anyone hangs up.
    const latest = crmServer.callSummaries.at(-1)!;
    expect(latest.appointmentAction).toBe('book');
    expect(latest.actionResult).toBe('success');
    expect(latest.appointmentId).toBeTruthy();

    await runner.end();
  });

  it('does not let a bookkeeping failure interrupt the call', async () => {
    const runner = await startCall();
    // The CRM refuses progress writes; the conversation must carry on.
    crmServer.faults.failTimes.set('/v1/call-summaries', {
      count: 99, status: 500, code: 'INTERNAL_ERROR', message: 'nope',
    });

    await runner.handleUserTurn('what do you offer?');
    runner.persistProgress();
    const next = await runner.handleUserTurn('how much is a blow dry?');

    expect(next.utterance).toMatch(/Blow Dry/i);
    await runner.end();
  });
});

describe('every call is recorded', () => {
  it('writes a structured summary for a successful booking', async () => {
    const runner = await startCall();
    const { ToolExecutor } = await import('../tools/executor.js');
    const executor = new ToolExecutor(crm, runner.session);

    const availability = await crm.getAvailability({ serviceId: 'svc-cut', timeExpression: 'next tuesday' }, {});
    const slot = availability.slots[0]!;
    await executor.execute('propose_booking', { serviceId: 'svc-cut', start: slot.start, staffId: slot.staffId });
    await executor.execute('commit_pending_action', { callerConfirmed: true });
    await runner.end();

    const summary = crmServer.callSummaries.at(-1)!;
    expect(summary.appointmentAction).toBe('book');
    expect(summary.actionResult).toBe('success');
    expect(summary.appointmentId).toBeTruthy();
    expect(String(summary.summary)).toMatch(/completed/i);
    expect(Array.isArray(summary.events)).toBe(true);
  });

  it('writes a summary for a failed call too, with the reason', async () => {
    const runner = await startCall();
    const { ToolExecutor } = await import('../tools/executor.js');
    const executor = new ToolExecutor(crm, runner.session);

    const availability = await crm.getAvailability({ serviceId: 'svc-cut', timeExpression: 'next tuesday' }, {});
    const slot = availability.slots[0]!;
    await executor.execute('propose_booking', { serviceId: 'svc-cut', start: slot.start, staffId: slot.staffId });
    crmServer.faults.failTimes.set('/v1/appointments', {
      count: 99, status: 500, code: 'INTERNAL_ERROR', message: 'boom',
    });
    await executor.execute('commit_pending_action', { callerConfirmed: true });
    await runner.end('failed');

    const summary = crmServer.callSummaries.at(-1)!;
    expect(summary.actionResult).toBe('failed');
    // The CRM's CHECK constraint requires this, and a reviewer needs it.
    expect(summary.failureReason).toBeTruthy();
    expect(String(summary.failureReason)).toContain('INTERNAL_ERROR');
  });

  it('records a callback request when the caller is escalated', async () => {
    const runner = await startCall();
    const { ToolExecutor } = await import('../tools/executor.js');
    const executor = new ToolExecutor(crm, runner.session);

    await executor.execute('request_callback', {
      name: 'Tom Reeves', phone: '+447700900004',
      reason: 'Refund for a colour that went wrong', preferredTime: 'after 4pm',
    });
    await runner.end();

    const summary = crmServer.callSummaries.at(-1)!;
    expect(summary.escalated).toBe(true);
    expect(summary.escalationReason).toBeTruthy();
    expect((summary.callbackRequest as { name: string }).name).toBe('Tom Reeves');
  });
});
