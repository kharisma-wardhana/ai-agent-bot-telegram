import type { Deps } from "../deps";
import type { ToolCall, ToolDef } from "../llm/types";
import { escalateToMentor, ESCALATION_LIMIT_PER_HOUR } from "./escalate-to-mentor";
import { recallMemoryTool } from "./recall-memory";
import { searchLessonDocs } from "./search-lesson-docs";

export type ToolName = "search_lesson_docs" | "recall_memory" | "escalate_to_mentor";

export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_lesson_docs",
      description: "Cari potongan materi kelas (lesson-docs) yang relevan. Pakai jika dokumen yang ada belum cukup.",
      parameters: { type: "object", properties: { query: { type: "string", description: "Kata kunci pencarian dalam Bahasa Indonesia" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_memory",
      description: "Ingat hal yang pernah ditanyakan atau membuat peserta ini bingung, untuk menyesuaikan penjelasan.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate_to_mentor",
      description: "Teruskan pertanyaan ke mentor jika materi kelas tidak memuat jawabannya.",
      parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
    },
  },
];

export interface ToolContext {
  d: Deps;
  learnerId: number;
  /** Set by escalate_to_mentor; the pipeline turns it into the mentor fallback. */
  escalated: boolean;
  /** Titles of documents found through search_lesson_docs, for the source line. */
  extraSources: string[];
}

/** Executes one tool call. Unknown tools and bad arguments return an error string to the model, never throw. */
export async function runTool(call: ToolCall, ctx: ToolContext): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return "ERROR: argumen bukan JSON yang valid.";
  }
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string).slice(0, 300) : "");
  switch (call.name as ToolName) {
    case "search_lesson_docs":
      return searchLessonDocs(ctx, str("query"));
    case "recall_memory":
      return recallMemoryTool(ctx, str("query"));
    case "escalate_to_mentor":
      return escalateToMentor(ctx, str("reason"));
    default:
      return `ERROR: tool "${call.name}" tidak tersedia.`;
  }
}

export { ESCALATION_LIMIT_PER_HOUR };
