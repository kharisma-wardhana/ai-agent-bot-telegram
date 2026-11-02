import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDepsOverride } from "../src/deps";
import { makeHarness, MENTORS, type Harness } from "./fakes/harness";

let h: Harness;
const worker = () => (exports as unknown as { default: Fetcher }).default;

function mcp(body: unknown, token: string | null = "mcp-token") {
  return worker().fetch(new Request("https://bot.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));
}
const rpc = (method: string, params?: unknown, id: number = 1) => ({ jsonrpc: "2.0", id, method, params });

beforeEach(async () => {
  h = makeHarness();
  await h.seed("Mastering the Art of Prompting", "Prompt yang baik harus jelas dan spesifik. Few-shot prompting memberi contoh agar model paham pola.");
});
afterEach(() => setDepsOverride(null));

describe("MCP auth (AC 19)", () => {
  it("rejects missing and invalid bearer tokens with 401", async () => {
    for (const token of [null, "wrong", ""]) {
      const res = await mcp(rpc("tools/list"), token);
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
    }
    expect(h.tg.calls).toHaveLength(0);
  });
});

describe("MCP protocol and tools (AC 20)", () => {
  it("initializes, acknowledges notifications with 202, and answers ping", async () => {
    const init = await (await mcp(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }))).json() as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: object } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.serverInfo.name).toBe("kak-skilly-lesson-docs");
    expect(init.result.capabilities).toHaveProperty("tools");
    expect((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect(await (await mcp(rpc("ping"))).json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("lists exactly the three tools", async () => {
    const res = await (await mcp(rpc("tools/list"))).json() as { result: { tools: { name: string; inputSchema: object }[] } };
    expect(res.result.tools.map((t) => t.name)).toEqual(["search_lesson_docs", "recall_memory", "escalate_to_mentor"]);
    expect(res.result.tools.every((t) => "inputSchema" in t)).toBe(true);
  });

  it("search_lesson_docs returns chunks for a known query", async () => {
    const res = await (await mcp(rpc("tools/call", { name: "search_lesson_docs", arguments: { query: "few-shot prompting memberi contoh" } }))).json() as { result: { content: { text: string }[]; isError: boolean } };
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0]!.text).toContain("Few-shot prompting memberi contoh");
    expect(res.result.content[0]!.text).toContain("Mastering the Art of Prompting");
  });

  it("recall_memory needs a learner id; escalate_to_mentor DMs every mentor", async () => {
    const bad = await (await mcp(rpc("tools/call", { name: "recall_memory", arguments: { query: "x" } }))).json() as { result: { isError: boolean } };
    expect(bad.result.isError).toBe(true);
    await mcp(rpc("tools/call", { name: "escalate_to_mentor", arguments: { question: "Kapan kelas live berikutnya?" } }));
    for (const m of MENTORS) expect(h.tg.textsIn(m).join()).toContain("Kapan kelas live berikutnya?");
  });

  it("returns JSON-RPC errors for unknown tools and methods, and handles batches", async () => {
    const unknownTool = await (await mcp(rpc("tools/call", { name: "drop_tables", arguments: {} }))).json() as { error: { code: number } };
    expect(unknownTool.error.code).toBe(-32602);
    const unknownMethod = await (await mcp(rpc("resources/list"))).json() as { error: { code: number } };
    expect(unknownMethod.error.code).toBe(-32601);
    const batch = await (await mcp([rpc("ping", undefined, 1), rpc("tools/list", undefined, 2)])).json() as { id: number }[];
    expect(batch.map((b) => b.id)).toEqual([1, 2]);
    expect((await worker().fetch("https://bot.test/mcp")).status).toBe(405);
  });
});
