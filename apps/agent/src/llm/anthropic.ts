/**
 * Anthropic adapter.
 *
 * Voice is latency-sensitive, so this runs at low effort by default with
 * adaptive thinking left on. The alternative — disabling thinking — is worse
 * here than it sounds: with thinking off, the model occasionally writes a tool
 * call into its visible text instead of emitting a tool_use block, which on a
 * phone call means reading JSON aloud to a customer while the booking never
 * happens. Low effort keeps latency down without that failure mode.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { LlmAdapter, LlmMessage, LlmRequest, LlmTurn } from './types.js';

export class AnthropicAdapter implements LlmAdapter {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(apiKey: string | undefined = config.ANTHROPIC_API_KEY) {
    this.client = new Anthropic({
      ...(apiKey ? { apiKey } : {}),
      // Milliseconds in the TypeScript SDK. A caller is waiting.
      timeout: config.LLM_TIMEOUT_MS,
      maxRetries: 1,
    });
  }

  async complete(request: LlmRequest): Promise<LlmTurn> {
    const response = await this.client.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: 1024,
      // Keeping the system prompt in one cacheable block: it is stable within a
      // call, and the volatile per-turn facts live at its tail.
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      output_config: { effort: config.LLM_EFFORT },
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
        // Guarantees the tool input validates against the schema exactly, so
        // the executor never receives a half-formed booking.
        strict: true,
      })),
      messages: toAnthropicMessages(request.messages),
    });

    if (response.stop_reason === 'refusal') {
      logger.warn({ stopDetails: response.stop_details }, 'model declined the turn');
      return {
        text: "I'm sorry, I can't help with that one — let me take your details and have a colleague call you back.",
        toolCalls: [],
      };
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim();

    const toolCalls = response.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        name: block.name,
        // Always parse rather than string-match: escaping in tool inputs varies.
        input: (block.input ?? {}) as Record<string, unknown>,
      }));

    return { text, toolCalls };
  }
}

function toAnthropicMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
      continue;
    }

    if (message.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = [];
      if (message.text) content.push({ type: 'text', text: message.text });
      for (const call of message.toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      }
      if (content.length > 0) out.push({ role: 'assistant', content });
      continue;
    }

    // Every tool_result for a turn goes in ONE user message. Splitting them
    // across messages teaches the model to stop making parallel tool calls.
    out.push({
      role: 'user',
      content: message.results.map((result) => ({
        type: 'tool_result' as const,
        tool_use_id: result.id,
        content: JSON.stringify(result.content),
        is_error: result.isError,
      })),
    });
  }

  return out;
}
