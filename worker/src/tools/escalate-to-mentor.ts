import type { ToolContext } from "./index";

export const ESCALATION_LIMIT_PER_HOUR = 3;

/**
 * escalate_to_mentor: marks the question for the mentor fallback. Rate-limited per learner so a
 * prompt-injected model can't flood mentors (spec › Flagged concerns: prompt injection).
 */
export async function escalateToMentor(ctx: ToolContext, _reason: string): Promise<string> {
  const recent = await ctx.d.repo.countRecentEscalations(ctx.learnerId, 60);
  if (recent >= ESCALATION_LIMIT_PER_HOUR) return "DITOLAK: batas eskalasi ke mentor untuk peserta ini sudah tercapai. Jawab dari dokumen atau balas NOT_FOUND.";
  ctx.escalated = true;
  return "OK: pertanyaan akan diteruskan ke mentor.";
}
