/**
 * Speech-to-text adapters.
 *
 * In `browser` mode recognition runs in the caller's browser (Web Speech API)
 * and arrives here as text frames — no key, no cost, and it exercises the whole
 * turn-taking path including barge-in. `deepgram` streams the raw audio to a
 * server-side recogniser, which is what a Twilio phone call needs, since a
 * phone has no browser to run recognition in.
 */
import { WebSocket } from 'ws';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface Transcript {
  text: string;
  /** Interim results drive barge-in; finals drive turns. */
  isFinal: boolean;
}

export interface SttStream {
  /** Feed raw audio (PCM16 or µ-law, per the adapter's contract). */
  write(chunk: Buffer): void;
  close(): void;
}

export interface SttAdapter {
  readonly name: string;
  /** Null when recognition happens client-side. */
  open(onTranscript: (t: Transcript) => void): SttStream | null;
}

/** Recognition happens in the browser; the server just receives text. */
class BrowserStt implements SttAdapter {
  readonly name = 'browser';
  open(): null {
    return null;
  }
}

class MockStt implements SttAdapter {
  readonly name = 'mock';
  open(): null {
    return null;
  }
}

/**
 * Deepgram streaming recogniser.
 *
 * `interim_results` is on because that is what makes barge-in possible: the
 * first partial word from the caller while the agent is still speaking is the
 * signal to stop talking.
 */
class DeepgramStt implements SttAdapter {
  readonly name = 'deepgram';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  open(onTranscript: (t: Transcript) => void): SttStream {
    const params = new URLSearchParams({
      model: this.model,
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      endpointing: '300',
      smart_format: 'true',
    });

    const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    const pending: Buffer[] = [];
    let open = false;

    socket.on('open', () => {
      open = true;
      for (const chunk of pending) socket.send(chunk);
      pending.length = 0;
    });

    socket.on('message', (raw) => {
      try {
        const payload = JSON.parse(raw.toString()) as {
          channel?: { alternatives?: Array<{ transcript?: string }> };
          is_final?: boolean;
        };
        const text = payload.channel?.alternatives?.[0]?.transcript?.trim();
        if (text) onTranscript({ text, isFinal: Boolean(payload.is_final) });
      } catch {
        // A malformed frame is not worth ending a call over.
      }
    });

    socket.on('error', (err) => logger.error({ err }, 'Deepgram stream error'));

    return {
      write(chunk) {
        if (open) socket.send(chunk);
        // Buffer briefly rather than losing the caller's first words to a
        // handshake that has not finished yet.
        else if (pending.length < 100) pending.push(chunk);
      },
      close() {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'CloseStream' }));
          socket.close();
        }
      },
    };
  }
}

export function createSttAdapter(): SttAdapter {
  if (config.STT_PROVIDER === 'deepgram') {
    if (config.DEEPGRAM_API_KEY) return new DeepgramStt(config.DEEPGRAM_API_KEY, config.DEEPGRAM_MODEL);
    logger.warn('STT_PROVIDER=deepgram but DEEPGRAM_API_KEY is not set — using browser recognition');
    return new BrowserStt();
  }
  if (config.STT_PROVIDER === 'mock') return new MockStt();
  return new BrowserStt();
}
