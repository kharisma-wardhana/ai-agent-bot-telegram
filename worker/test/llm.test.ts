import { describe, expect, it } from "vitest";
import { KAGGLE_SECRET_HEADER, KaggleBackend } from "../src/llm/kaggle";
import { LlmRouter } from "../src/llm/router";
import { sseData } from "../src/llm/sse";
import { LlmError, type AiBinding, type ChatRequest, type ChatResult, type LlmBackend } from "../src/llm/types";
import { parseNonStream, WorkersAiBackend, WorkersAiEmbedder } from "../src/llm/workers-ai";

const enc = new TextEncoder();
function streamOf(lines: string[], splitAt?: number): ReadableStream<Uint8Array> {
  const text = lines.join("\n") + "\n";
  const parts = splitAt ? [text.slice(0, splitAt), text.slice(splitAt)] : [text];
  return new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } });
}
const chunk = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}`;
const req: ChatRequest = { messages: [{ role: "user", content: "halo" }] };

describe("sseData", () => {
  it("yields data payloads across chunk boundaries and stops at [DONE]", async () => {
    const out: string[] = [];
    for await (const d of sseData(streamOf(["data: a", "", ": comment", "data: b", "data: [DONE]", "data: c"], 7))) out.push(d);
    expect(out).toEqual(["a", "b"]);
  });
});

describe("KaggleBackend", () => {
  it("sends the shared secret, streams content deltas and assembles tool calls", async () => {
    const seen: Request[] = [];
    const fetchFn = (async (u: RequestInfo | URL, i?: RequestInit) => {
      seen.push(new Request(u, i));
      return new Response(streamOf([
        chunk({ content: "Ha" }), chunk({ content: "lo" }),
        chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "search_", arguments: '{"q":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { name: "lesson_docs", arguments: '"rag"}' } }] }),
        "data: [DONE]",
      ]));
    }) as typeof fetch;
    const deltas: string[] = [];
    const k = new KaggleBackend("https://k.example", "sekret", fetchFn);
    const r = await k.chat(req, (d) => { deltas.push(d); });
    expect(seen[0]!.headers.get(KAGGLE_SECRET_HEADER)).toBe("sekret");
    expect(seen[0]!.url).toBe("https://k.example/v1/chat/completions");
    const body = await seen[0]!.json() as { stream: boolean; chat_template_kwargs: { enable_thinking: boolean } };
    expect(body.stream).toBe(true);
    expect(body.chat_template_kwargs.enable_thinking).toBe(false);
    expect(deltas).toEqual(["Ha", "lo"]);
    expect(r).toEqual({ content: "Halo", backend: "kaggle", toolCalls: [{ id: "c1", name: "search_lesson_docs", arguments: '{"q":"rag"}' }] });
  });

  it("raises LlmError on HTTP failure or network error", async () => {
    const k500 = new KaggleBackend("https://k", "s", (async () => new Response("x", { status: 502 })) as typeof fetch);
    await expect(k500.chat(req)).rejects.toBeInstanceOf(LlmError);
    const kNet = new KaggleBackend("https://k", "s", (async () => { throw new TypeError("network"); }) as typeof fetch);
    await expect(kNet.chat(req)).rejects.toThrow(/unreachable/);
  });
});

describe("WorkersAiBackend", () => {
  it("streams classic {response} chunks and strips images from user content", async () => {
    let inputs: Record<string, unknown> = {};
    const ai: AiBinding = { run: async (_m, i) => { inputs = i; return streamOf(['data: {"response":"Se"}', 'data: {"response":"lamat"}', "data: [DONE]"]); } };
    const r = await new WorkersAiBackend(ai).chat({ messages: [{ role: "user", content: [{ type: "text", text: "apa ini?" }, { type: "image_url", image_url: { url: "data:x" } }] }] });
    expect(r.content).toBe("Selamat");
    expect(r.backend).toBe("workers_ai");
    expect((inputs.messages as { content: string }[])[0]!.content).toBe("apa ini?");
  });

  it("uses non-streaming for tool calls and parses both response shapes", async () => {
    const ai: AiBinding = { run: async () => ({ response: "", tool_calls: [{ name: "search_lesson_docs", arguments: { query: "rag" } }] }) };
    const r = await new WorkersAiBackend(ai).chat({ ...req, tools: [{ type: "function", function: { name: "search_lesson_docs", description: "", parameters: {} } }] });
    expect(r.toolCalls).toEqual([{ id: "call_0", name: "search_lesson_docs", arguments: '{"query":"rag"}' }]);
    expect(parseNonStream({ choices: [{ message: { content: "ok", tool_calls: [{ id: "x", function: { name: "f", arguments: "{}" } }] } }] }))
      .toEqual({ content: "ok", toolCalls: [{ id: "x", name: "f", arguments: "{}" }] });
  });
});

describe("WorkersAiEmbedder", () => {
  it("returns 1024-dim vectors and rejects wrong shapes", async () => {
    const good: AiBinding = { run: async (_m, i) => ({ data: (i.text as string[]).map(() => new Array(1024).fill(0.1)) }) };
    const v = await new WorkersAiEmbedder(good).embed(["a", "b"]);
    expect(v).toHaveLength(2);
    expect(v[0]).toHaveLength(1024);
    const bad: AiBinding = { run: async () => ({ data: [[1, 2]] }) };
    await expect(new WorkersAiEmbedder(bad).embed(["a"])).rejects.toThrow(/dim 2/);
  });
});

function backend(name: "kaggle" | "workers_ai", images: boolean, behaviour: "ok" | "fail" = "ok"): LlmBackend & { calls: number } {
  return {
    name, supportsImages: images, calls: 0,
    async chat(): Promise<ChatResult> {
      this.calls++;
      if (behaviour === "fail") throw new LlmError("down", name);
      return { content: name, toolCalls: [], backend: name };
    },
  };
}

describe("LlmRouter (AC 18)", () => {
  it("uses Kaggle when heartbeat ≤ max age, Workers AI when stale or missing", async () => {
    for (const [age, expected] of [[30, "kaggle"], [90, "kaggle"], [91, "workers_ai"], [null, "workers_ai"]] as const) {
      const r = new LlmRouter(backend("kaggle", true), backend("workers_ai", false), async () => age, 90);
      expect((await r.chat(req, false)).backend).toBe(expected);
    }
  });

  it("defers image requests when Kaggle is offline", async () => {
    const r = new LlmRouter(backend("kaggle", true), backend("workers_ai", false), async () => 500, 90);
    expect(await r.route(true)).toEqual({ deferred: true, reason: "images_need_kaggle" });
    await expect(r.chat(req, true)).rejects.toBeInstanceOf(LlmError);
  });

  it("retries a failed Kaggle text request on Workers AI and remembers Kaggle is down", async () => {
    const k = backend("kaggle", true, "fail");
    const w = backend("workers_ai", false);
    let retried = false;
    const r = new LlmRouter(k, w, async () => 5, 90);
    expect((await r.chat(req, false, undefined, () => { retried = true; })).backend).toBe("workers_ai");
    expect(retried).toBe(true);
    await r.chat(req, false);
    expect(k.calls).toBe(1);
    expect(w.calls).toBe(2);
  });

  it("treats a heartbeat lookup error as offline and caches the result", async () => {
    let lookups = 0;
    let t = 0;
    const r = new LlmRouter(backend("kaggle", true), backend("workers_ai", false), async () => { lookups++; throw new Error("db"); }, 90, () => t);
    expect(await r.primaryOnline()).toBe(false);
    await r.primaryOnline();
    expect(lookups).toBe(1);
    t = 20_000;
    await r.primaryOnline();
    expect(lookups).toBe(2);
  });
});
