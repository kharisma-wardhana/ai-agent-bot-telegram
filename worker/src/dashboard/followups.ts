/**
 * Follow-up actions for the dashboard: list, claim, release, image proxy
 * (docs/mentor-followup-dashboard/spec.md › The follow-up list, Claiming).
 */
import type { ClosedFollowup, DmDelivery, FollowupTab, FollowupView, TopicDelivery } from "../db/repository";
import type { Deps } from "../deps";
import { ingestText } from "../knowledge/add-knowledge";
import { TelegramError, type MessageEntity } from "../telegram/client";
import { CLAIM_TTL_S, type DashUser } from "./auth";

export function listFollowups(d: Deps, tab: FollowupTab): Promise<FollowupView[]> {
  return d.repo.listFollowups(tab, CLAIM_TTL_S);
}

/** Exactly one concurrent claimer wins (AC 10); a lapsed claim can be taken over (AC 11). */
export function claimFollowup(d: Deps, user: DashUser, id: number) {
  return d.repo.claimFollowup(id, user.email, user.displayName, CLAIM_TTL_S);
}

export function releaseFollowup(d: Deps, user: DashUser, id: number): Promise<boolean> {
  return d.repo.releaseFollowup(id, user.email);
}

const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Streams the question's photo from Telegram. The bot token stays server-side; nothing is stored (AC 19).
 * Null when the follow-up has no photo or Telegram can't serve it.
 */
export async function followupImage(d: Deps, id: number): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  const fileId = await d.repo.followupPhoto(id);
  if (!fileId) return null;
  try {
    const { bytes, path } = await d.tg.downloadFile(fileId, MAX_IMAGE_BYTES);
    const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
    return { bytes, type: MIME[ext] ?? "image/jpeg" };
  } catch (e) {
    console.error("follow-up image fetch failed", (e as Error).message);
    return null;
  }
}

// ---------- Replying (spec › Replying, AC 12–15) ----------
export const REPLY_MAX = 900;
export const LEARNER_DM_HEADER = "Kak Skilly di sini 👋 Mentor sudah menjawab pertanyaanmu:";
const LEARNER_MAX = 1000; // spec: learner-facing final answers ≤ 1000 characters

/** The learner's DM: fixed Kak Skilly header, the question (shortened if needed), the mentor's reply verbatim. ≤ 1000 chars. */
export function learnerReplyText(question: string, reply: string): string {
  const build = (q: string) => `${LEARNER_DM_HEADER}\n\nPertanyaan: ${q}\n\nJawaban mentor:\n${reply}`;
  const full = build(question || "(tanpa teks)");
  if (full.length <= LEARNER_MAX) return full;
  const room = LEARNER_MAX - build("").length - 1;
  return room > 0 ? build(`${question.slice(0, room).trimEnd()}…`) : build("").slice(0, LEARNER_MAX);
}

/** The topic post: the learner's name as a text_mention (works without a username), then the reply. */
export function topicReplyText(learnerId: number, learnerName: string | null, reply: string): { text: string; entities: MessageEntity[] } {
  const name = (learnerName ?? "").trim().slice(0, 40) || "Kamu";
  const text = `${name}, mentor sudah menjawab pertanyaanmu 👇\n\n${reply}`;
  return { text, entities: [{ type: "text_mention", offset: 0, length: name.length, user: { id: learnerId, is_bot: false, first_name: name } }] };
}

export type ReplyOutcome =
  | { kind: "empty" | "too-long" | "not-claimer" }
  | { kind: "delivered"; dm: DmDelivery; topic: TopicDelivery };

async function deliverDm(d: Deps, c: ClosedFollowup, text: string): Promise<DmDelivery> {
  const hold = async () => {
    await d.repo.holdAnswer(c.learnerId, c.sessionId, "not_started", { text });
    return "held" as const;
  };
  if (!c.learnerStarted) return hold();
  try {
    await d.tg.sendMessage(c.learnerId, text);
    return "sent";
  } catch (e) {
    if (e instanceof TelegramError && e.cannotDm) return hold();
    console.error("mentor reply DM failed", (e as Error).message);
    return "failed";
  }
}

async function deliverTopic(d: Deps, c: ClosedFollowup, reply: string): Promise<TopicDelivery> {
  if (c.originChatId === null) return "skipped"; // asked by DM: nothing to post in a topic
  const { text, entities } = topicReplyText(c.learnerId, c.learnerName, reply);
  try {
    await d.tg.sendMessage(c.originChatId, text, { threadId: c.originThreadId ?? undefined, replyTo: c.originMessageId ?? undefined, entities });
    return "sent";
  } catch (e) {
    console.error("mentor reply topic post failed", (e as Error).message);
    return "failed";
  }
}

/**
 * Closes the question first (only the live claimer can), then delivers. Closing first means a double
 * submit or a race can't send the same reply twice (AC 14). A delivery failure is recorded, not retried (AC 15).
 */
export async function replyToFollowup(d: Deps, user: DashUser, id: number, rawReply: string): Promise<ReplyOutcome> {
  const reply = rawReply.replace(/\r\n/g, "\n").trim();
  if (!reply) return { kind: "empty" };
  if (reply.length > REPLY_MAX) return { kind: "too-long" };
  const closed = await d.repo.closeFollowup(id, user.email, user.displayName, reply, CLAIM_TTL_S);
  if (!closed) return { kind: "not-claimer" };
  const dm = await deliverDm(d, closed, learnerReplyText(closed.question, reply));
  const topic = await deliverTopic(d, closed, reply);
  await d.repo.setFollowupDelivery(id, dm, topic);
  return { kind: "delivered", dm, topic };
}

// ---------- Add to knowledge (spec › Adding a reply to the knowledge base, AC 16, 17) ----------
export type KnowledgeResult = "added" | "exists" | "not-closed" | "not-found";

export function knowledgeEntry(question: string, reply: string): { title: string; text: string } {
  const words = question.replace(/\s+/g, " ").trim();
  const head = words.length > 50 ? `${words.slice(0, 50).replace(/\s+\S*$/, "")}…` : words;
  return { title: `Follow-up mentor: ${head || "pertanyaan"}`, text: `Pertanyaan: ${question.trim()}\nJawaban mentor: ${reply.trim()}` };
}

/** Appends one knowledge entry for a closed follow-up, once. Person-triggered only; never automatic. */
export async function addFollowupToKnowledge(d: Deps, user: DashUser, id: number): Promise<KnowledgeResult> {
  const info = await d.repo.followupForKnowledge(id);
  if (!info) return "not-found";
  if (info.status !== "closed" || !info.replyText) return "not-closed";
  if (info.knowledgeSourceId) return "exists";
  const { title, text } = knowledgeEntry(info.question, info.replyText);
  const res = await ingestText(d, user.telegramId, text, title, "text", null);
  if (!res?.sourceId) return "exists"; // same content already in the knowledge base (content hash)
  await d.repo.setFollowupKnowledge(id, res.sourceId);
  return "added";
}
