import type { ChunkMatch } from "../db/repository";

export const NOT_FOUND_MARKER = "NOT_FOUND";

/** Exact topic text required by the spec (Behaviour 7, AC 9). */
export const FALLBACK_TOPIC_TEXT = "Saya tidak punya data terkait pertanyaan tersebut, akan saya follow up ke mentor";

/** The model was told to reply NOT_FOUND when the documents don't contain the answer. */
export function modelSaysNotFound(answer: string): boolean {
  const t = answer.trim();
  return t === "" || t.toUpperCase().includes(NOT_FOUND_MARKER);
}

export type GroundingDecision = { kind: "answer"; sources: string[] } | { kind: "fallback"; reason: "low_similarity" | "model_not_found" };

/** Not found if retrieval found nothing above threshold, or the model reported NOT_FOUND. */
export function decide(retrievalFound: boolean, chunks: ChunkMatch[], answer: string | null): GroundingDecision {
  if (!retrievalFound) return { kind: "fallback", reason: "low_similarity" };
  if (answer === null || modelSaysNotFound(answer)) return { kind: "fallback", reason: "model_not_found" };
  return { kind: "answer", sources: uniqueTitles(chunks) };
}

export function uniqueTitles(chunks: ChunkMatch[]): string[] {
  return [...new Set(chunks.map((c) => c.title))];
}

export function sourceLine(titles: string[]): string {
  return titles.length ? `📚 Sumber: ${titles.join(", ")}` : "";
}
