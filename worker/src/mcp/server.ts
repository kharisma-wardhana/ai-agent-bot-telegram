/**
 * Minimal MCP server (Streamable HTTP transport, JSON responses, stateless) exposing the bot's three
 * tools to mentors' MCP clients (spec › Behaviour 16). Every request needs a bearer token from MCP_TOKENS.
 */
import { documentsBlock } from "../answer/prompts";
import type { Deps } from "../deps";
import { recallMemory } from "../memory/graph-store";
import { retrieve } from "../rag/retrieve";

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];
export const SERVER_INFO = { name: "kak-skilly-lesson-docs", version: "0.1.0" };

export const MCP_TOOLS = [
  {
    name: "search_lesson_docs",
    description: "Cari potongan materi kelas (lesson-docs) yang paling relevan dengan query.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "recall_memory",
    description: "Lihat memori jangka panjang seorang peserta (khusus mentor) yang terkait dengan query.",
    inputSchema: { type: "object", properties: { learner_id: { type: "integer" }, query: { type: "string" } }, required: ["learner_id", "query"] },
  },
  {
    name: "escalate_to_mentor",
    description: "Kirim pertanyaan ke semua mentor lewat DM Telegram untuk di-follow up.",
    inputSchema: { type: "object", properties: { question: { type: "string" }, reason: { type: "string" } }, required: ["question"] },
  },
];

type JsonRpcId = string | number | null;
interface JsonRpcRequest { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: Record<string, unknown> }

const ok = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });

export function bearerOk(header: string | undefined, tokens: string[], equal: (a: string, b: string) => boolean): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m || tokens.length === 0) return false;
  let match = false;
  for (const t of tokens) match = equal(m[1]!.trim(), t) || match; // no early exit
  return match;
}

async function callTool(d: Deps, name: string, args: Record<string, unknown>) {
  const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string).slice(0, 500) : "");
  switch (name) {
    case "search_lesson_docs": {
      if (!s("query")) return text("query wajib diisi", true);
      const r = await retrieve(s("query"), d.embedder, d.repo, { topK: d.cfg.retrievalTopK, threshold: d.cfg.retrievalThreshold });
      return text(documentsBlock(r.chunks));
    }
    case "recall_memory": {
      const learnerId = Number(args.learner_id);
      if (!Number.isInteger(learnerId) || !s("query")) return text("learner_id (integer) dan query wajib diisi", true);
      const [emb] = await d.embedder.embed([s("query")]);
      const notes = emb ? await recallMemory(d, learnerId, emb) : [];
      return text(notes.length ? notes.join("\n") : "(tidak ada memori yang relevan)");
    }
    case "escalate_to_mentor": {
      if (!s("question")) return text("question wajib diisi", true);
      const msg = `🙋 Follow-up dari MCP\nPertanyaan: ${s("question")}${s("reason") ? `\nAlasan: ${s("reason")}` : ""}`;
      let sent = 0;
      for (const m of d.cfg.mentorIds) {
        try {
          await d.tg.sendMessage(m, msg);
          sent++;
        } catch {
          /* mentor hasn't started the bot */
        }
      }
      return text(`Diteruskan ke ${sent} mentor.`);
    }
    default:
      return null;
  }
}

/** Handles one JSON-RPC message. Returns null for notifications (HTTP 202, no body). */
export async function handleMcp(d: Deps, msg: JsonRpcRequest): Promise<object | null> {
  const id = msg.id ?? null;
  if (msg.id === undefined) return null; // notification, e.g. notifications/initialized
  switch (msg.method) {
    case "initialize": {
      const requested = String(msg.params?.protocolVersion ?? "");
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "Alat untuk mencari materi kelas IBM SkillBuild AI, melihat memori peserta, dan meneruskan pertanyaan ke mentor.",
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: MCP_TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const res = await callTool(d, name, args);
        return res ? ok(id, res) : err(id, -32602, `Unknown tool: ${name}`);
      } catch (e) {
        return ok(id, text(`Tool gagal: ${(e as Error).message}`, true));
      }
    }
    default:
      return err(id, -32601, `Method not found: ${msg.method}`);
  }
}
