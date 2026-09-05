import { config } from '../config.js';
import { logger } from '../logger.js';
import { AnthropicAdapter } from './anthropic.js';
import { ScriptedAdapter } from './scripted.js';
import type { LlmAdapter } from './types.js';

export function createLlmAdapter(): LlmAdapter {
  if (config.llmProvider === 'scripted') {
    if (config.llmFellBack) {
      logger.warn(
        'ANTHROPIC_API_KEY is not set — falling back to the scripted policy. The voice pipeline ' +
          'still runs end to end; set the key for real dialogue.',
      );
    }
    return new ScriptedAdapter();
  }
  return new AnthropicAdapter();
}

export { AnthropicAdapter, ScriptedAdapter };
export type { LlmAdapter, LlmRequest, LlmTurn, LlmMessage, LlmToolCall } from './types.js';
