import type { Backend } from "../../src/db/repository";
import type { ChatRequest, ChatResult, Embedder, LlmBackend, OnDelta, ToolCall } from "../../src/llm/types";

/** Deterministic bag-of-words embedder: shared words → high cosine similarity. */
export class FakeEmbedder implements Embedder {
  calls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return texts.map((t) => {
      const v = new Array(1024).fill(0);
      for (const w of t.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
        let h = 0;
        for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        v[h % 1024] += 1;
      }
      return v;
    });
  }
}

export type Script = (req: ChatRequest) => string | { content?: string; toolCalls?: ToolCall[] };

/** Scripted chat backend; streams the reply in a few fragments like a real model. */
export class FakeBackend implements LlmBackend {
  requests: ChatRequest[] = [];
  fail = false;
  constructor(readonly name: Backend, readonly supportsImages: boolean, public script: Script) {}

  async chat(req: ChatRequest, onDelta?: OnDelta): Promise<ChatResult> {
    this.requests.push(req);
    if (this.fail) throw new Error(`${this.name} down`);
    const out = this.script(req);
    const content = typeof out === "string" ? out : (out.content ?? "");
    const toolCalls = typeof out === "string" ? [] : (out.toolCalls ?? []);
    const step = Math.max(1, Math.ceil(content.length / 3));
    for (let i = 0; i < content.length; i += step) await onDelta?.(content.slice(i, i + step));
    return { content, toolCalls, backend: this.name };
  }
}

/** The text of the last user message in a request (documents + question block). */
export function lastUser(req: ChatRequest): string {
  const m = [...req.messages].reverse().find((x) => x.role === "user");
  if (!m) return "";
  return typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n");
}
