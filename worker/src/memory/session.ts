import type { Deps } from "../deps";
import type { BotEvent } from "../telegram/parse-update";

export const FEEDBACK_THANKS = "Terima kasih atas feedback-nya! 🙏 Sesi ini aku tutup. Kalau ada pertanyaan lain, tanya lagi dengan #askAI di grup atau langsung di sini ya.";
export const NO_OPEN_SESSION = "Terima kasih! 😊";

/** Button, reaction or reply-text feedback closes the learner's open session (AC 16). */
export async function handleFeedback(d: Deps, learnerId: number, kind: "button" | "reaction" | "text", value: string, callbackId?: string): Promise<boolean> {
  const open = await d.repo.getOpenSession(learnerId);
  const closed = open ? await d.repo.closeSessionWithFeedback(open.id, kind, value) : false;
  if (callbackId) await d.tg.answerCallbackQuery(callbackId, closed ? "Terima kasih! 🙏" : NO_OPEN_SESSION).catch(() => undefined);
  if (closed) await d.tg.sendMessage(learnerId, FEEDBACK_THANKS);
  return closed;
}

export function feedbackFromEvent(e: Extract<BotEvent, { kind: "feedback" }>): { kind: "button" | "reaction"; value: string; callbackId?: string } {
  return e.via === "button" ? { kind: "button", value: e.value, callbackId: e.callbackId } : { kind: "reaction", value: e.value };
}

/** A DM that replies to one of the bot's messages while a session is open is text feedback. */
export async function isTextFeedback(d: Deps, e: Extract<BotEvent, { kind: "dm_text" }>): Promise<boolean> {
  if (e.replyToMessageId === null || e.media) return false;
  return (await d.repo.getOpenSession(e.from.id)) !== null;
}

/** When the learner's open session should expire (last activity + TTL), or null if none is open. */
export async function sessionDeadline(d: Deps, learnerId: number): Promise<number | null> {
  const open = await d.repo.getOpenSession(learnerId);
  return open ? open.lastActivityAt.getTime() + d.cfg.sessionTtlHours * 3600_000 : null;
}
