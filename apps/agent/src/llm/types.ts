import type { ToolDefinition } from '../tools/definitions.js';

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmTurn {
  /** What to say to the caller. Empty when the model only wants tools. */
  text: string;
  toolCalls: LlmToolCall[];
  /**
   * False when the adapter could not work out what the caller meant.
   *
   * Lets the orchestrator escalate on *repeated misunderstanding* rather than
   * on "nothing changed" — a caller asking three questions in a row is a normal
   * conversation, whereas being misunderstood three times is not.
   */
  understood?: boolean;
}

/** One entry of the conversation as the adapter sees it. */
export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; text: string; toolCalls: LlmToolCall[] }
  | { role: 'tool_results'; results: Array<{ id: string; content: unknown; isError: boolean }> };

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: ToolDefinition[];
}

export interface LlmAdapter {
  readonly name: string;
  complete(request: LlmRequest): Promise<LlmTurn>;
}
