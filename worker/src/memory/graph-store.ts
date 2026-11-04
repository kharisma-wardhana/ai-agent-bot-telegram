import type { Deps } from "../deps";

const KIND_LABEL: Record<string, string> = { concept: "pernah bertanya tentang", difficulty: "pernah kesulitan dengan", preference: "lebih suka" };
export const MEMORY_MIN_SIMILARITY = 0.3;

/**
 * Recalls the learner's memory nodes closest to the question plus one hop of edges, as short notes
 * for the <memori> block. Used to adapt the explanation, never as a source of facts.
 */
export async function recallMemory(d: Deps, learnerId: number, embedding: number[], k = 4): Promise<string[]> {
  try {
    const nodes = (await d.repo.matchMemory(learnerId, embedding, k)).filter((n) => n.similarity >= MEMORY_MIN_SIMILARITY);
    if (nodes.length === 0) return [];
    const notes = nodes.map((n) => `Peserta ${KIND_LABEL[n.kind] ?? n.kind} "${n.label}".`);
    const edges = await d.repo.memoryEdgesFor(learnerId, nodes.map((n) => n.id));
    for (const e of edges.slice(0, 4)) notes.push(`"${e.fromLabel}" ${e.relation.replace(/_/g, " ")} "${e.toLabel}".`);
    return notes;
  } catch (e) {
    console.error("memory recall failed", (e as Error).message);
    return []; // memory is an enhancement; never block the answer on it
  }
}
