/**
 * Telephony transport — the production path to a real phone number.
 *
 * STATUS: implemented to the interface, unverified. Exercising it needs a
 * Twilio account, a purchased number and a public HTTPS/WSS endpoint, none of
 * which exist in this prototype. It is written and wired rather than sketched
 * so the shape of the integration is reviewable, and it is labelled honestly
 * rather than presented as working. The browser transport is the demo path.
 *
 * The design point worth noting: this handler converts Twilio's µ-law frames
 * into the same normalised events the browser client produces, so
 * `CallRunner` and every guard above it are transport-independent. Adding a
 * phone number does not change a line of conversation logic.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { CallRunner } from '../agent/callRunner.js';
import { createSttAdapter } from '../stt/index.js';

/** µ-law (G.711) to 16-bit PCM. Twilio streams 8 kHz µ-law; recognisers want PCM. */
function mulawToPcm16(mulaw: Buffer): Buffer {
  const pcm = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i += 1) {
    const value = ~mulaw[i]!;
    const sign = value & 0x80;
    const exponent = (value >> 4) & 0x07;
    const mantissa = value & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    pcm.writeInt16LE(sign ? -sample : sample, i * 2);
  }
  return pcm;
}

export function registerTwilioRoutes(app: FastifyInstance, activeCalls: Map<string, CallRunner>): void {
  if (!config.TWILIO_ACCOUNT_SID) {
    app.get('/twilio/status', async () => ({
      configured: false,
      note:
        'Telephony is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and ' +
        'PUBLIC_AGENT_WSS_URL, then point your Twilio number at POST /twilio/voice. ' +
        'The browser client at / is the supported demo transport.',
    }));
    return;
  }

  /**
   * Twilio hits this when a call comes in. The TwiML opens a bidirectional
   * media stream back to us.
   */
  app.post('/twilio/voice', async (request, reply) => {
    const body = (request.body ?? {}) as { From?: string; CallSid?: string };
    logger.info({ callSid: body.CallSid }, 'inbound telephony call');

    const wssUrl = config.PUBLIC_AGENT_WSS_URL ?? `wss://${request.headers.host}`;
    reply.type('text/xml');
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wssUrl}/twilio/stream">
      <Parameter name="from" value="${body.From ?? ''}" />
    </Stream>
  </Connect>
</Response>`;
  });

  app.get('/twilio/stream', { websocket: true }, (socket) => {
    let runner: CallRunner | null = null;
    let streamSid: string | null = null;
    const stt = createSttAdapter();
    let sttStream: ReturnType<typeof stt.open> = null;
    let generation = 0;

    const handleUtterance = async (text: string) => {
      if (!runner) return;
      const turn = (generation += 1);
      const result = await runner.handleUserTurn(text);
      if (turn !== generation) return; // superseded by barge-in

      // A real deployment streams TTS audio back as base64 µ-law media frames;
      // with browser-mode TTS there is no server-side audio to send.
      socket.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'agent_turn' } }));
      logger.info({ callId: runner.session.callId, text: result.utterance }, 'agent turn (telephony)');
    };

    socket.on('message', async (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as {
        event: string;
        start?: { streamSid: string; customParameters?: { from?: string } };
        media?: { payload: string };
      };

      switch (frame.event) {
        case 'start': {
          streamSid = frame.start?.streamSid ?? null;
          runner = await CallRunner.start({
            callerPhone: frame.start?.customParameters?.from ?? null,
            transport: 'twilio',
          });
          activeCalls.set(runner.session.callId, runner);
          // Server-side recognition is mandatory here — a phone line has no
          // browser to run the Web Speech API in.
          sttStream = stt.open((transcript) => {
            if (!transcript.isFinal) {
              generation += 1; // caller spoke over us
              return;
            }
            void handleUtterance(transcript.text);
          });
          break;
        }

        case 'media':
          if (frame.media && sttStream) {
            sttStream.write(mulawToPcm16(Buffer.from(frame.media.payload, 'base64')));
          }
          break;

        case 'stop':
          sttStream?.close();
          if (runner) {
            activeCalls.delete(runner.session.callId);
            await runner.end('completed');
          }
          break;

        default:
          break;
      }
    });

    socket.on('close', async () => {
      sttStream?.close();
      if (runner) {
        activeCalls.delete(runner.session.callId);
        await runner.end('completed');
      }
    });
  });
}
