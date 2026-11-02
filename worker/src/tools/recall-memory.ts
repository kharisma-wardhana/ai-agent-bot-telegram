import { sanitizeData } from "../answer/prompts";
import { recallMemory } from "../memory/graph-store";
import type { ToolContext } from "./index";

/** recall_memory: the current learner's memory only — the learner id comes from context, never from the model. */
export async function recallMemoryTool(ctx: ToolContext, query: string): Promise<string> {
  if (!query) return "ERROR: query kosong.";
  const [embedding] = await ctx.d.embedder.embed([query]);
  const notes = embedding ? await recallMemory(ctx.d, ctx.learnerId, embedding) : [];
  return notes.length ? `<memori>\n${notes.map(sanitizeData).join("\n")}\n</memori>` : "<memori>\n(tidak ada)\n</memori>";
}
