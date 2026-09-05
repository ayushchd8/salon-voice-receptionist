#!/usr/bin/env node
/**
 * Drives the six example calls in EXAMPLES.md against the running system and
 * prints them as markdown.
 *
 * These are real conversations over the agent's WebSocket against the real CRM
 * API and database — the transcripts in EXAMPLES.md are this script's output,
 * pasted verbatim. Regenerate them whenever the behaviour changes, so the
 * documentation cannot quietly drift away from what the system does.
 *
 *   pnpm dev                        # in one terminal
 *   node scripts/example-calls.mjs  # in another
 *
 * Scenario 5 stops the `db` container to produce a genuine failure, then starts
 * it again and waits for it to come back.
 */
import { execSync } from 'node:child_process';

const AGENT = process.env.AGENT_URL ?? 'http://127.0.0.1:4100';
const API = process.env.CRM_API_URL ?? 'http://127.0.0.1:4000';
const STAFF_KEY = process.env.SEED_STAFF_API_KEY ?? 'sk_staff_dev_0000000000000000000000000000';

const ELEANOR = '+447700900001'; // seeded with two upcoming appointments
const MARCUS = '+447700900002';
const DANNY = '+447700900006';

const lines = [];
const say = (...parts) => lines.push(parts.join(''));

/** One call: connect, exchange turns, print the transcript as a table. */
async function call({ title, note, phone, turns, after }) {
  const started = await fetch(`${AGENT}/v1/calls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callerPhone: phone }),
  });
  if (!started.ok) {
    console.error(`Could not start a call — is \`pnpm dev\` running? (${started.status})`);
    process.exit(1);
  }
  const { callId, greeting } = await started.json();

  const socket = new WebSocket(`${AGENT.replace(/^http/, 'ws')}/v1/calls/${callId}/stream`);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));

  const rows = [['**Agent**', greeting, '']];
  let last = null;

  for (const turn of turns) {
    // A function in the list is an interruption — the database going down.
    if (typeof turn === 'function') {
      rows.push([await turn(), '', '']);
      continue;
    }
    const reply = new Promise((resolve) => {
      const onMessage = (event) => {
        const frame = JSON.parse(event.data);
        if (frame.type === 'agent_text' || frame.type === 'ended') {
          socket.removeEventListener('message', onMessage);
          resolve(frame);
        }
      };
      socket.addEventListener('message', onMessage);
      setTimeout(() => {
        socket.removeEventListener('message', onMessage);
        resolve({ text: '(no reply within 30s)', toolsUsed: [] });
      }, 30_000);
    });
    socket.send(JSON.stringify({ type: 'user_text', text: turn }));
    last = await reply;
    rows.push(['**Caller**', turn, '']);
    rows.push(['**Agent**', last.text, (last.toolsUsed ?? []).join(', ')]);
  }

  socket.send(JSON.stringify({ type: 'end' }));
  await new Promise((resolve) => setTimeout(resolve, 600));
  socket.close();

  say('\n### ', title, '\n');
  if (note) say(note, '\n');
  say('| | | Tools called |');
  say('|---|---|---|');
  for (const [who, what, tools] of rows) {
    const cells = String(what).replace(/\|/g, '\\|');
    say(`| ${who} | ${cells} | ${tools ? '`' + tools.replace(/, /g, '`, `') + '`' : ''} |`);
  }
  if (after) say(await after(last));
}

/** Read a customer's diary back out of the CRM, to show the effect of a call. */
async function diary(label, phone) {
  const response = await fetch(`${API}/v1/appointments?limit=100&order=asc`, {
    headers: { Authorization: `Bearer ${STAFF_KEY}` },
  });
  const { data } = await response.json();
  const theirs = data.filter((a) => a.customer.phone === phone);
  return `\n**${label}**\n\n${theirs.map((a) => `- ${a.status} · ${a.service.name} · ${a.label}`).join('\n')}\n`;
}

await call({
  title: '1 · A successful booking',
  note: 'A new caller books from scratch. Nothing is written until the details are read back and agreed.',
  phone: DANNY,
  turns: ['I would like to book an appointment', 'a cut and blow dry', 'next Tuesday morning', 'the second one', 'yes please'],
});

await call({
  title: '2 · An unavailable requested time',
  note: 'The salon is closed on Sundays. The agent says why, and offers real alternatives rather than a dead end.',
  phone: DANNY,
  turns: ['can I book a blow dry on Sunday morning?', 'Monday at 9 then', 'yes please'],
});

await call({
  title: '3 · Finding and cancelling an appointment',
  note: 'Eleanor has two appointments, so the agent must ask which — it never guesses.',
  phone: ELEANOR,
  turns: ['I need to cancel my appointment', 'the first one', 'yes please'],
  after: () => diary("Eleanor's diary afterwards", ELEANOR),
});

await call({
  title: '4 · Rescheduling an appointment',
  note: 'The old slot is released and the new one taken in a single transaction.',
  phone: ELEANOR,
  turns: ['I want to move my appointment', 'next Thursday afternoon', 'the first one', 'yes'],
  after: () => diary("Eleanor's diary afterwards", ELEANOR),
});

await call({
  title: '5 · An API failure',
  note:
    'The database is stopped between the agent reading the booking back and the caller agreeing ' +
    'to it. The outcome is taken from the HTTP response, so the agent reports what actually ' +
    'happened rather than what it was about to say.',
  phone: DANNY,
  turns: [
    'I want to book a full head colour',
    'next Thursday afternoon',
    'the first one',
    () => {
      console.error('  stopping the database…');
      execSync('docker compose stop db', { stdio: 'ignore' });
      return '*(the database goes down here)*';
    },
    'yes please',
  ],
  after: (last) => {
    console.error('  restarting the database…');
    execSync('docker compose start db', { stdio: 'ignore' });
    execSync('node scripts/wait-for-db.mjs', { stdio: 'ignore' });
    return `\nGuard tripped on that turn: **${last.guardTripped}**  ·  state: **${last.state}**\n`;
  },
});

await call({
  title: '6 · A customer correcting previously provided information',
  note: 'The caller changes the service mid-flow, then changes the time after hearing it read back.',
  phone: MARCUS,
  turns: [
    'I want to book a cut and blow dry',
    'actually make that a full head colour instead',
    'next Wednesday afternoon',
    'the first one',
    'no wait, the second one',
    'yes please',
  ],
});

console.log(lines.join('\n'));
