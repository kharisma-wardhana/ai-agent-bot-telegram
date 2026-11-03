import type { TgChatMember, TgEntity, TgMessage, TgUpdate, TgUser } from "./types";

export type Media = { type: "photo"; fileId: string } | { type: "voice"; fileId: string; mime: string };

export type BotEvent =
  | { kind: "ignore"; reason: string }
  | { kind: "ask"; from: TgUser; chatId: number; threadId: number | null; messageId: number; question: string; media: Media | null }
  | { kind: "start"; from: TgUser; payload: string | null }
  | { kind: "add_knowledge"; from: TgUser; text: string | null; document: { fileId: string; fileName: string; mime: string | null } | null }
  | { kind: "hapusdata"; from: TgUser }
  | { kind: "feedback"; from: TgUser; via: "button"; value: "up" | "down"; callbackId: string; messageId: number | null }
  | { kind: "feedback"; from: TgUser; via: "reaction"; value: string; messageId: number }
  | { kind: "dm_text"; from: TgUser; text: string; replyToMessageId: number | null; media: Media | null; messageId: number }
  // cohort-welcome-message: `from` is the member whose status changed (not the admin who changed it)
  | { kind: "member_join"; from: TgUser }
  | { kind: "member_leave"; from: TgUser; kicked: boolean };

/** In the group: creator/admin/member, or restricted but still a member. */
function inGroup(m: TgChatMember): boolean {
  return m.status === "creator" || m.status === "administrator" || m.status === "member" || (m.status === "restricted" && m.is_member !== false);
}

export const ASK_HASHTAG = "#askai";
export const FEEDBACK_EMOJI = new Set(["✅", "👍", "👎", "✔️", "☑️"]);

function hasAskHashtag(text: string, entities: TgEntity[] | undefined): boolean {
  const tagged = (entities ?? []).some((e) => e.type === "hashtag" && text.slice(e.offset, e.offset + e.length).toLowerCase() === ASK_HASHTAG);
  return tagged || /(^|\s)#askai\b/i.test(text);
}

function stripHashtag(text: string): string {
  return text.replace(/(^|\s)#askai\b/gi, " ").replace(/\s+/g, " ").trim();
}

function mediaOf(m: TgMessage): Media | null {
  if (m.photo?.length) {
    // Largest size that's still reasonable for the vision model (≤ ~1280px).
    const sorted = [...m.photo].sort((a, b) => a.width - b.width);
    const pick = [...sorted].reverse().find((p) => Math.max(p.width, p.height) <= 1280) ?? sorted[0]!;
    return { type: "photo", fileId: pick.file_id };
  }
  const v = m.voice ?? m.audio;
  if (v) return { type: "voice", fileId: v.file_id, mime: v.mime_type ?? "audio/ogg" };
  return null;
}

/** Parses "/cmd@bot args" → { cmd, args }, only when the command targets this bot (or no bot is named). */
function command(text: string, botUsername: string): { cmd: string; args: string } | null {
  const m = /^\/([a-z_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  return { cmd: m[1]!.toLowerCase(), args: (m[3] ?? "").trim() };
}

/** Classifies an incoming update. Pure: no I/O. */
export function classify(update: TgUpdate, cfg: { groupChatId: number; botUsername: string }): BotEvent {
  if (update.chat_member) {
    const u = update.chat_member;
    if (u.chat.id !== cfg.groupChatId) return { kind: "ignore", reason: "member change in other chat" };
    const user = u.new_chat_member.user;
    if (user.is_bot) return { kind: "ignore", reason: "bot member change" };
    const was = inGroup(u.old_chat_member);
    const now = inGroup(u.new_chat_member);
    if (!was && now) return { kind: "member_join", from: user };
    if (was && !now) return { kind: "member_leave", from: user, kicked: u.new_chat_member.status === "kicked" };
    return { kind: "ignore", reason: "member status change" };
  }

  if (update.callback_query) {
    const q = update.callback_query;
    if (q.from.is_bot) return { kind: "ignore", reason: "bot" };
    const m = /^fb:(up|down)$/.exec(q.data ?? "");
    if (!m) return { kind: "ignore", reason: "unknown callback" };
    return { kind: "feedback", from: q.from, via: "button", value: m[1] as "up" | "down", callbackId: q.id, messageId: q.message?.message_id ?? null };
  }

  if (update.message_reaction) {
    const r = update.message_reaction;
    if (r.chat.type !== "private" || !r.user || r.user.is_bot) return { kind: "ignore", reason: "reaction outside DM" };
    const emoji = r.new_reaction.find((x): x is { type: "emoji"; emoji: string } => x.type === "emoji" && FEEDBACK_EMOJI.has(x.emoji));
    if (!emoji) return { kind: "ignore", reason: "non-feedback reaction" };
    return { kind: "feedback", from: r.user, via: "reaction", value: emoji.emoji, messageId: r.message_id };
  }

  const m = update.message;
  if (!m || !m.from) return { kind: "ignore", reason: "no message" };
  if (m.from.is_bot) return { kind: "ignore", reason: "bot" };
  const text = m.text ?? m.caption ?? "";
  const entities = m.text ? m.entities : m.caption_entities;

  if (m.chat.type === "supergroup" || m.chat.type === "group") {
    if (m.chat.id !== cfg.groupChatId) return { kind: "ignore", reason: "other group" };
    if (!hasAskHashtag(text, entities)) return { kind: "ignore", reason: "no #askAI" };
    return {
      kind: "ask", from: m.from, chatId: m.chat.id, threadId: m.is_topic_message ? (m.message_thread_id ?? null) : null,
      messageId: m.message_id, question: stripHashtag(text), media: mediaOf(m),
    };
  }

  if (m.chat.type !== "private") return { kind: "ignore", reason: "channel" };

  const c = command(text, cfg.botUsername);
  if (c) {
    if (c.cmd === "start") return { kind: "start", from: m.from, payload: c.args || null };
    if (c.cmd === "add_knowledge" || c.cmd === "addknowledge") {
      const d = m.document;
      return { kind: "add_knowledge", from: m.from, text: c.args || null, document: d ? { fileId: d.file_id, fileName: d.file_name ?? "dokumen", mime: d.mime_type ?? null } : null };
    }
    if (c.cmd === "hapusdata") return { kind: "hapusdata", from: m.from };
    return { kind: "ignore", reason: `unknown command /${c.cmd}` };
  }
  if (/^\/[a-z_]+@/i.test(text.trim())) return { kind: "ignore", reason: "command for another bot" };

  const media = mediaOf(m);
  if (!text.trim() && !media) return { kind: "ignore", reason: "empty DM" };
  return { kind: "dm_text", from: m.from, text: stripHashtag(text), replyToMessageId: m.reply_to_message?.message_id ?? null, media, messageId: m.message_id };
}

export function displayName(u: TgUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(u.id);
}
