import type { ChunkMatch, Repository } from "../db/repository";
import type { Embedder } from "../llm/types";

export interface Retrieval {
  chunks: ChunkMatch[]; // only chunks at or above the threshold
  bestSimilarity: number; // best score before thresholding (0 when nothing matched)
  found: boolean;
  embedding: number[]; // reused for memory recall
}

/** Embeds the question and searches lesson-docs. found = best similarity ≥ threshold (spec › Grounding). */
export async function retrieve(
  question: string,
  embedder: Embedder,
  repo: Repository,
  opts: { topK: number; threshold: number },
): Promise<Retrieval> {
  const [embedding] = await embedder.embed([question]);
  if (!embedding) throw new Error("embedder returned no vector");
  const all = await repo.matchChunks(embedding, opts.topK, 0);
  const bestSimilarity = all[0]?.similarity ?? 0;
  const chunks = all.filter((c) => c.similarity >= opts.threshold);
  return { chunks, bestSimilarity, found: chunks.length > 0, embedding };
}
