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

/**
 * Who gets the follow-up DM: MENTOR_IDS ∪ dashboard owners (config) ∪ active dashboard users, each once
 * (mentor-followup-dashboard AC 18). If the user table can't be read, the configured IDs still get it.
 */
export async function followupRecipients(d: Deps): Promise<number[]> {
  const ids = [...d.cfg.mentorIds, ...d.cfg.dashboardOwners.map((o) => o.telegramId)];
  try {
    ids.push(...(await d.repo.listDashboardUsers()).map((u) => u.telegramId));
  } catch (e) {
    console.error("dashboard users unavailable for follow-up DM", (e as Error).message);
  }
  return [...new Set(ids)];
}

/** Dashboard deep link to one follow-up, or null when DASHBOARD_BASE_URL isn't configured. */
export function dashboardLink(d: Deps, followupId: number): string | null {
  return d.cfg.dashboardBaseUrl ? `${d.cfg.dashboardBaseUrl}/dashboard#f-${followupId}` : null;
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

  // Record first so the DM can link to this follow-up on the dashboard; recipients are filled in after sending.
  // A DB failure must not cost the mentors their DM: carry on without the dashboard link.
  let followupId: number | null = null;
  try {
    followupId = await d.repo.addFollowupV2(f.sessionId, f.question, [], f.photoFileId ?? null);
  } catch (e) {
    console.error("follow-up record failed", (e as Error).message);
  }
  const link = f.chatId !== null && f.messageId !== null ? messageLink(f.chatId, f.messageId, f.threadId) : null;
  const dash = followupId !== null ? dashboardLink(d, followupId) : null;
  const who = `${displayName(f.from)}${f.from.username ? ` (@${f.from.username})` : ""}`;
  const text = [
    "🙋 Pertanyaan perlu follow-up mentor",
    `Dari: ${who}`,
    f.threadId ? `Topik: #${f.threadId}` : "Lewat: DM ke bot",
    `Pertanyaan: ${f.question || "(tanpa teks)"}`,
    link ? `Link: ${link}` : null,
    dash ? `Jawab lewat dashboard: ${dash}` : null,
  ].filter(Boolean).join("\n");

  const notified: number[] = [];
  for (const mentor of await followupRecipients(d)) {
    try {
      await d.tg.sendMessage(mentor, text.slice(0, 4000));
      if (f.photoFileId) await d.tg.call("sendPhoto", { chat_id: mentor, photo: f.photoFileId, caption: "Gambar dari pertanyaan di atas" });
      notified.push(mentor);
    } catch (e) {
      console.error(`mentor ${mentor} DM failed`, (e as Error).message);
    }
  }
  if (followupId !== null) await d.repo.setFollowupNotified(followupId, notified);
  return { mentorsNotified: notified };
}
