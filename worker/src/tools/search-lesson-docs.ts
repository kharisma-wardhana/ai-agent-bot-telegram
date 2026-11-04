import { documentsBlock } from "../answer/prompts";
import { retrieve } from "../rag/retrieve";
import type { ToolContext } from "./index";

/** search_lesson_docs: same retrieval and threshold as the main pipeline; results are returned as a <dokumen> data block. */
export async function searchLessonDocs(ctx: ToolContext, query: string): Promise<string> {
  if (!query) return "ERROR: query kosong.";
  const r = await retrieve(query, ctx.d.embedder, ctx.d.repo, { topK: ctx.d.cfg.retrievalTopK, threshold: ctx.d.cfg.retrievalThreshold });
  for (const c of r.chunks) if (!ctx.extraSources.includes(c.title)) ctx.extraSources.push(c.title);
  return documentsBlock(r.chunks);
}
