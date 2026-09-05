/**
 * Voice agent service.
 *
 * Serves the browser voice client and one WebSocket per call. The transport
 * layer is deliberately thin: it normalises whatever arrives — text frames from
 * browser speech recognition, or audio frames from a phone — into the same
 * events, so the conversation logic never learns which transport it is on.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import cors from '@fastify/cors';
import { config } from './config.js';
import { logger } from './logger.js';
import { CallRunner } from './agent/callRunner.js';
import { createTtsAdapter } from './tts/index.js';
import { createSttAdapter } from './stt/index.js';
import { registerTwilioRoutes } from './transport/twilio.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Typed as Fastify's own logger interface: passing the concrete pino instance
// narrows FastifyInstance's logger generic, which then no longer matches the
// plain `FastifyInstance` that plugin modules accept.
const app = Fastify({ loggerInstance: logger as FastifyBaseLogger });
const tts = createTtsAdapter();
const stt = createSttAdapter();

await app.register(cors, { origin: true });
await app.register(websocket, { options: { maxPayload: 1_048_576 } });
await app.register(staticFiles, { root: publicDir, prefix: '/' });

app.get('/health', async () => ({
  status: 'ok',
  llm: config.llmProvider,
  stt: stt.name,
  tts: tts.name,
  crm: config.CRM_API_URL,
}));

/**
 * Live calls, keyed by call id.
 *
 * In production this is the thing that makes an agent worker stateful and
 * therefore sticky — see SCALING.md for how calls are routed to the worker
 * holding their session.
 */
const activeCalls = new Map<string, CallRunner>();

app.post('/v1/calls', async (request, reply) => {
  const body = (request.body ?? {}) as { callerPhone?: string | null };

  try {
    const runner = await CallRunner.start({
      callerPhone: body.callerPhone ?? null,
      transport: 'browser',
    });
    activeCalls.set(runner.session.callId, runner);

    reply.status(201);
    return {
      callId: runner.session.callId,
      salon: {
        name: runner.session.context.salon.name,
        timezone: runner.session.context.salon.timezone,
        phone: runner.session.context.salon.phone,
      },
      greeting: runner.greeting(),
      providers: { llm: config.llmProvider, stt: stt.name, tts: tts.name },
    };
  } catch (err) {
    logger.error({ err }, 'could not start a call');
    reply.status(503);
    return {
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message:
          'Could not reach the CRM API. Start it with `pnpm dev:api` and check CRM_API_KEY.',
      },
    };
  }
});

app.get('/v1/calls/:callId/stream', { websocket: true }, (socket, request) => {
  const { callId } = request.params as { callId: string };
  const runner = activeCalls.get(callId);

  if (!runner) {
    socket.send(JSON.stringify({ type: 'error', message: 'Unknown call. Start a new one.' }));
    socket.close();
    return;
  }

  const log = logger.child({ callId });
  const send = (payload: Record<string, unknown>) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
  };

  /**
   * Barge-in.
   *
   * When the caller starts speaking over the agent, the in-flight turn is
   * abandoned: `generation` is bumped, and any reply from the superseded turn
   * is discarded rather than spoken on top of them. The browser client stops
   * its own playback the moment it hears interim speech, so the two halves meet
   * in the middle.
   */
  let generation = 0;
  let busy = false;

  // Server-side recognition, when a provider is configured. In browser mode
  // this is null and text frames arrive already transcribed.
  const sttStream = stt.open((transcript) => {
    if (!transcript.isFinal) {
      generation += 1;
      send({ type: 'barge_in' });
      return;
    }
    void handleUtterance(transcript.text);
  });

  async function handleUtterance(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    const turnGeneration = (generation += 1);
    busy = true;
    send({ type: 'thinking' });

    try {
      const result = await runner!.handleUserTurn(trimmed);

      // The caller interrupted while we were working — drop this reply.
      if (turnGeneration !== generation) {
        log.debug('discarded a superseded turn');
        return;
      }

      const audio = await tts.synthesize(result.utterance);
      send({
        type: 'agent_text',
        text: result.utterance,
        state: result.state,
        toolsUsed: result.toolsUsed,
        guardTripped: result.guardTripped,
        ...(audio ? { audio: audio.base64, mimeType: audio.mimeType } : {}),
      });

      // Record the call as it happens, after the caller has been answered so
      // this never adds latency to a turn.
      runner!.persistProgress();

      if (result.ended) {
        await finish('completed');
      }
    } catch (err) {
      log.error({ err }, 'turn failed');
      send({
        type: 'agent_text',
        text: "I'm sorry — something went wrong at our end. Let me take your number and have someone call you back.",
        state: runner!.session.state,
        toolsUsed: [],
        guardTripped: false,
      });
    } finally {
      busy = false;
    }
  }

  async function finish(status: 'completed' | 'failed'): Promise<void> {
    sttStream?.close();
    activeCalls.delete(callId);
    // The summary is written here, for every call — including one that failed.
    await runner!.end(status);
    send({ type: 'ended', summaryUrl: `/v1/call-summaries/${callId}` });
  }

  socket.on('message', (raw: Buffer) => {
    let frame: { type?: string; text?: string; audio?: string };
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (frame.type) {
      case 'user_text':
        if (frame.text) void handleUtterance(frame.text);
        break;

      case 'barge_in':
        // Invalidate whatever turn is in flight.
        generation += 1;
        break;

      case 'audio':
        if (frame.audio && sttStream) sttStream.write(Buffer.from(frame.audio, 'base64'));
        break;

      case 'end':
        void finish('completed');
        break;

      default:
        break;
    }
  });

  socket.on('close', () => {
    // A caller who hangs up mid-sentence still gets a summary written.
    if (activeCalls.has(callId)) {
      void finish(busy ? 'failed' : 'completed');
    }
  });

  send({
    type: 'ready',
    callId,
    state: runner.session.state,
    providers: { llm: config.llmProvider, stt: stt.name, tts: tts.name },
  });
});

registerTwilioRoutes(app, activeCalls);

try {
  await app.listen({ port: config.AGENT_PORT, host: config.AGENT_HOST });
  logger.info(
    {
      client: `http://${config.AGENT_HOST}:${config.AGENT_PORT}/`,
      llm: config.llmProvider,
      stt: stt.name,
      tts: tts.name,
    },
    'voice agent listening',
  );
} catch (err) {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    logger.info({ signal, activeCalls: activeCalls.size }, 'shutting down');
    // Never lose a call record to a deploy.
    await Promise.allSettled([...activeCalls.values()].map((runner) => runner.end('failed')));
    await app.close();
    process.exit(0);
  });
}
