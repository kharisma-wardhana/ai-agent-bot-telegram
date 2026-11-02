import type { Backend } from "../db/repository";

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON string, parsed by the tool layer
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  backend: Backend;
}

/** Called with each streamed text fragment (not cumulative). */
export type OnDelta = (fragment: string) => void | Promise<void>;

export interface LlmBackend {
  readonly name: Backend;
  readonly supportsImages: boolean;
  chat(req: ChatRequest, onDelta?: OnDelta): Promise<ChatResult>;
}

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

/** Minimal shape of the Workers AI binding, so tests can fake it. */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export class LlmError extends Error {
  constructor(message: string, readonly backend: Backend) {
    super(message);
  }
}
