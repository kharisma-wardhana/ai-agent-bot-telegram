import type { Deps } from "../deps";
import { FALLBACK_TOPIC_TEXT } from "../rag/grounding";
import { displayName } from "../telegram/parse-update";
import type { TgUser } from "../telegram/types";

export interface FallbackInput {
  chatId: number | null; // group the question came from (null for a DM follow-up)
  threadId: number | null;
  messageId: number | null;
  from: TgUser;
  question: string;
  sessionId: string;
  photoFileId?: string;
}

/** t.me link to a supergroup message: -100XXXXXXXXXX → t.me/c/XXXXXXXXXX/<msg>. */
export function messageLink(chatId: number, messageId: number, threadId: number | null): string | null {
  const s = String(chatId);
  if (!s.startsWith("-100")) return null;
  return `https://t.me/c/${s.slice(4)}/${messageId}${threadId ? `?thread=${threadId}` : ""}`;
}

/** Topic notice with the exact spec text + a DM to every mentor + a follow-up record (AC 9). */
export async function runFallback(d: Deps, f: FallbackInput): Promise<{ mentorsNotified: number[] }> {
  if (f.chatId !== null) {
    try {
      await d.tg.sendMessage(f.chatId, FALLBACK_TOPIC_TEXT, { threadId: f.threadId ?? undefined, replyTo: f.messageId ?? undefined });
    } catch (e) {
      console.error("fallback topic notice failed", (e as Error).message);
    }
  }

  const link = f.chatId !== null && f.messageId !== null ? messageLink(f.chatId, f.messageId, f.threadId) : null;
  const who = `${displayName(f.from)}${f.from.username ? ` (@${f.from.username})` : ""}`;
  const text = [
    "🙋 Pertanyaan perlu follow-up mentor",
    `Dari: ${who}`,
    f.threadId ? `Topik: #${f.threadId}` : "Lewat: DM ke bot",
    `Pertanyaan: ${f.question || "(tanpa teks)"}`,
    link ? `Link: ${link}` : null,
  ].filter(Boolean).join("\n");

  const notified: number[] = [];
  for (const mentor of d.cfg.mentorIds) {
    try {
      await d.tg.sendMessage(mentor, text.slice(0, 4000));
      if (f.photoFileId) await d.tg.call("sendPhoto", { chat_id: mentor, photo: f.photoFileId, caption: "Gambar dari pertanyaan di atas" });
      notified.push(mentor);
    } catch (e) {
      console.error(`mentor ${mentor} DM failed`, (e as Error).message);
    }
  }
  await d.repo.addFollowup(f.sessionId, f.question, notified);
  return { mentorsNotified: notified };
}
