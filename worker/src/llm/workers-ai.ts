import { sseData, ToolCallAssembler } from "./sse";
import { LlmError, toWireMessages, type AiBinding, type ChatMessage, type ChatRequest, type ChatResult, type Embedder, type LlmBackend, type OnDelta, type ToolCall } from "./types";

export const WORKERS_AI_CHAT_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
export const EMBED_MODEL = "@cf/baai/bge-m3";
export const EMBED_DIM = 1024;

/** Text-only fallback on Cloudflare Workers AI (free daily allowance). */
export class WorkersAiBackend implements LlmBackend {
  readonly name = "workers_ai" as const;
  readonly supportsImages = false;

  constructor(private readonly ai: AiBinding) {}

  async chat(req: ChatRequest, onDelta?: OnDelta): Promise<ChatResult> {
    const messages = toWireMessages(req.messages.map(textOnly));
    const base = { messages, max_tokens: req.maxTokens ?? 600, temperature: req.temperature ?? 0.3 };
    try {
      if (req.tools && req.tools.length) {
        // Tool calls: non-streaming is the reliably supported shape.
        const out = await this.ai.run(WORKERS_AI_CHAT_MODEL, { ...base, tools: req.tools });
        const { content, toolCalls } = parseNonStream(out);
        if (content) await onDelta?.(content);
        return { content, toolCalls, backend: "workers_ai" };
      }
      const out = await this.ai.run(WORKERS_AI_CHAT_MODEL, { ...base, stream: true });
      if (!(out instanceof ReadableStream)) {
        const { content, toolCalls } = parseNonStream(out);
        if (content) await onDelta?.(content);
        return { content, toolCalls, backend: "workers_ai" };
      }
      let content = "";
      const tools = new ToolCallAssembler();
      for await (const data of sseData(out as ReadableStream<Uint8Array>)) {
        let chunk: { response?: string; choices?: { delta?: { content?: string; tool_calls?: [] } }[] };
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        const piece = chunk.choices?.[0]?.delta?.content ?? chunk.response ?? "";
        tools.push(chunk.choices?.[0]?.delta?.tool_calls);
        if (piece) {
          content += piece;
          await onDelta?.(piece);
        }
      }
      return { content, toolCalls: tools.calls(), backend: "workers_ai" };
    } catch (e) {
      if (e instanceof LlmError) throw e;
      throw new LlmError(`workers ai failed: ${(e as Error).message}`, "workers_ai");
    }
  }
}

/** Images can't go to the text model; keep any text parts. */
function textOnly(m: ChatMessage): ChatMessage {
  if (m.role !== "user" || typeof m.content === "string") return m;
  return { role: "user", content: m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n") };
}

/** Accepts both the OpenAI-compatible shape and the classic Workers AI `{ response, tool_calls }` shape. */
export function parseNonStream(out: unknown): { content: string; toolCalls: ToolCall[] } {
  const o = (out ?? {}) as {
    response?: string;
    tool_calls?: { id?: string; name?: string; arguments?: unknown; function?: { name: string; arguments: unknown } }[];
    choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function: { name: string; arguments: unknown } }[] } }[];
  };
  const msg = o.choices?.[0]?.message;
  const content = (msg?.content ?? o.response ?? "") || "";
  const raw = msg?.tool_calls ?? o.tool_calls ?? [];
  const toolCalls = raw.map((t, i) => {
    const name = ("function" in t && t.function ? t.function.name : (t as { name?: string }).name) ?? "";
    const args = "function" in t && t.function ? t.function.arguments : (t as { arguments?: unknown }).arguments;
    return { id: t.id ?? `call_${i}`, name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) };
  });
  return { content, toolCalls };
}

/** bge-m3 embeddings on Workers AI. Always available, so query and document vectors share one model. */
export class WorkersAiEmbedder implements Embedder {
  constructor(private readonly ai: AiBinding) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 50) {
      const batch = texts.slice(i, i + 50);
      const res = (await this.ai.run(EMBED_MODEL, { text: batch })) as { data?: number[][]; response?: number[][] };
      const data = res.data ?? res.response;
      if (!Array.isArray(data) || data.length !== batch.length) throw new LlmError("bge-m3 returned an unexpected shape", "workers_ai");
      for (const v of data) {
        if (v.length !== EMBED_DIM) throw new LlmError(`bge-m3 returned dim ${v.length}, expected ${EMBED_DIM}`, "workers_ai");
        out.push(v);
      }
    }
    return out;
  }
}
