/**
 * Text-to-speech adapters.
 *
 * The seam exists so the demo can run with no API keys at all: `browser` mode
 * synthesises nothing server-side and the client speaks the text with the Web
 * Speech API. Swapping in Cartesia or ElevenLabs is a config change, and the
 * rest of the pipeline never learns which one is in use.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface SpeechAudio {
  base64: string;
  mimeType: string;
}

export interface TtsAdapter {
  readonly name: string;
  /** Null means "no server-side audio" — the client should speak the text itself. */
  synthesize(text: string): Promise<SpeechAudio | null>;
}

/** Zero-key default: the caller's browser does the speaking. */
class BrowserTts implements TtsAdapter {
  readonly name = 'browser';
  async synthesize(): Promise<null> {
    return null;
  }
}

class MockTts implements TtsAdapter {
  readonly name = 'mock';
  async synthesize(): Promise<null> {
    return null;
  }
}

/**
 * Cartesia Sonic. Low latency, which is what matters on a phone call.
 * Requires CARTESIA_API_KEY and CARTESIA_VOICE_ID.
 */
class CartesiaTts implements TtsAdapter {
  readonly name = 'cartesia';

  constructor(
    private readonly apiKey: string,
    private readonly voiceId: string,
  ) {}

  async synthesize(text: string): Promise<SpeechAudio | null> {
    try {
      const response = await fetch('https://api.cartesia.ai/tts/bytes', {
        method: 'POST',
        headers: {
          'Cartesia-Version': '2024-06-10',
          'X-API-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model_id: 'sonic-english',
          transcript: text,
          voice: { mode: 'id', id: this.voiceId },
          output_format: { container: 'mp3', encoding: 'mp3', sample_rate: 44100 },
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Cartesia TTS failed — falling back to browser speech');
        return null;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      return { base64: buffer.toString('base64'), mimeType: 'audio/mpeg' };
    } catch (err) {
      // Degrade rather than drop the call: the client can still speak the text.
      logger.warn({ err }, 'Cartesia TTS errored — falling back to browser speech');
      return null;
    }
  }
}

class ElevenLabsTts implements TtsAdapter {
  readonly name = 'elevenlabs';

  constructor(
    private readonly apiKey: string,
    private readonly voiceId: string,
  ) {}

  async synthesize(text: string): Promise<SpeechAudio | null> {
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            model_id: 'eleven_turbo_v2_5',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
          signal: AbortSignal.timeout(12_000),
        },
      );

      if (!response.ok) {
        logger.warn({ status: response.status }, 'ElevenLabs TTS failed — falling back to browser speech');
        return null;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      return { base64: buffer.toString('base64'), mimeType: 'audio/mpeg' };
    } catch (err) {
      logger.warn({ err }, 'ElevenLabs TTS errored — falling back to browser speech');
      return null;
    }
  }
}

export function createTtsAdapter(): TtsAdapter {
  switch (config.TTS_PROVIDER) {
    case 'cartesia':
      if (config.CARTESIA_API_KEY && config.CARTESIA_VOICE_ID) {
        return new CartesiaTts(config.CARTESIA_API_KEY, config.CARTESIA_VOICE_ID);
      }
      logger.warn('TTS_PROVIDER=cartesia but no key/voice configured — using browser speech');
      return new BrowserTts();
    case 'elevenlabs':
      if (config.ELEVENLABS_API_KEY && config.ELEVENLABS_VOICE_ID) {
        return new ElevenLabsTts(config.ELEVENLABS_API_KEY, config.ELEVENLABS_VOICE_ID);
      }
      logger.warn('TTS_PROVIDER=elevenlabs but no key/voice configured — using browser speech');
      return new BrowserTts();
    case 'mock':
      return new MockTts();
    default:
      return new BrowserTts();
  }
}
