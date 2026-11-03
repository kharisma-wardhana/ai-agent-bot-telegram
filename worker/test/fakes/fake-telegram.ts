import { PRIVACY_NOTICE } from "../../src/answer/persona";
import type { TgMessage, TgUpdate } from "../../src/telegram/types";

export interface SentCall { method: string; params: Record<string, unknown> }

/**
 * A fetch() stand-in for api.telegram.org. Records every Bot API call and answers like Telegram.
 * Users in `notStarted` get 403 on sendMessage to their private chat.
 */
export class FakeTelegram {
  calls: SentCall[] = [];
  notStarted = new Set<number>();
  files = new Map<string, Uint8Array>();
  private nextId = 1000;

  fetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fileMatch = /\/file\/bot[^/]+\/(.+)$/.exec(url);
    if (fileMatch) {
      const bytes = this.files.get(fileMatch[1]!);
      return bytes ? new Response(bytes) : new Response("nope", { status: 404 });
    }
    const method = /\/bot[^/]+\/([A-Za-z]+)$/.exec(url)?.[1] ?? "unknown";
    const params = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    this.calls.push({ method, params });
    if (method === "sendMessage" && this.notStarted.has(Number(params.chat_id))) {
      return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" });
    }
    if (method === "sendMessage") {
      const msg: TgMessage = { message_id: this.nextId++, chat: { id: Number(params.chat_id), type: Number(params.chat_id) < 0 ? "supergroup" : "private" }, text: String(params.text) };
      return Response.json({ ok: true, result: msg });
    }
    if (method === "getFile") {
      const id = String(params.file_id);
      return Response.json({ ok: true, result: { file_id: id, file_path: `files/${id}`, file_size: this.files.get(`files/${id}`)?.byteLength ?? 10 } });
    }
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;

  sent(method?: string): SentCall[] {
    return method ? this.calls.filter((c) => c.method === method) : this.calls;
  }

  /** Every text the given chat saw, in order: sendMessage text and each editMessageText. */
  textsIn(chatId: number): string[] {
    return this.calls
      .filter((c) => (c.method === "sendMessage" || c.method === "editMessageText") && Number(c.params.chat_id) === chatId)
      .map((c) => String(c.params.text));
  }

  /** Last text the chat saw, ignoring the one-time privacy notice. */
  lastAnswer(chatId: number): string | undefined {
    return this.textsIn(chatId).filter((t) => t !== PRIVACY_NOTICE).at(-1);
  }

  /** Final visible text of each message in a chat (last edit wins). */
  finalTextsIn(chatId: number): string[] {
    const byId = new Map<number, string>();
    let synthetic = 1000;
    for (const c of this.calls) {
      if (Number(c.params.chat_id) !== chatId) continue;
      if (c.method === "sendMessage") byId.set(synthetic++, String(c.params.text));
      if (c.method === "editMessageText") byId.set(Number(c.params.message_id), String(c.params.text));
    }
    return [...byId.values()];
  }
}

// ---------- Update fixtures ----------
export const GROUP_ID = -1001234567890;
export const BOT = "skilly_test_bot";
export const learner = (id = 501, name = "Ani") => ({ id, is_bot: false, first_name: name, username: name.toLowerCase() });
let uid = 1;

export function groupAsk(text: string, opts: { from?: ReturnType<typeof learner>; thread?: number; photo?: boolean; voice?: boolean; chatId?: number } = {}): TgUpdate {
  const from = opts.from ?? learner();
  const caption = opts.photo || opts.voice;
  const tagAt = text.toLowerCase().indexOf("#askai");
  const entities = tagAt >= 0 ? [{ type: "hashtag", offset: tagAt, length: 6 }] : [];
  return {
    update_id: uid++,
    message: {
      message_id: 7000 + uid, from, chat: { id: opts.chatId ?? GROUP_ID, type: "supergroup" },
      message_thread_id: opts.thread ?? 42, is_topic_message: true,
      ...(caption ? { caption: text, caption_entities: entities } : { text, entities }),
      ...(opts.photo ? { photo: [{ file_id: "ph_small", width: 320, height: 240 }, { file_id: "ph_big", width: 1280, height: 960 }, { file_id: "ph_huge", width: 2560, height: 1920 }] } : {}),
      ...(opts.voice ? { voice: { file_id: "vc1", duration: 5, mime_type: "audio/ogg" } } : {}),
    },
  };
}

export function dm(text: string, opts: { from?: ReturnType<typeof learner>; replyTo?: number; document?: { file_id: string; file_name: string; mime_type: string } } = {}): TgUpdate {
  const from = opts.from ?? learner();
  return {
    update_id: uid++,
    message: {
      message_id: 9000 + uid, from, chat: { id: from.id, type: "private" },
      ...(opts.document ? { caption: text, document: opts.document } : { text }),
      ...(opts.replyTo ? { reply_to_message: { message_id: opts.replyTo, chat: { id: from.id, type: "private" } } } : {}),
    },
  };
}

export function callback(data: string, from = learner(), messageId = 1000): TgUpdate {
  return { update_id: uid++, callback_query: { id: `cb${uid}`, from, data, message: { message_id: messageId, chat: { id: from.id, type: "private" } } } };
}

/** A chat_member update: `user`'s status goes from `oldStatus` to `newStatus` in `chatId` (default: the cohort group). */
export function chatMember(user: ReturnType<typeof learner>, oldStatus: string, newStatus: string, o: { chatId?: number; isMember?: boolean } = {}): TgUpdate {
  const chat = { id: o.chatId ?? GROUP_ID, type: "supergroup" as const };
  return {
    update_id: uid++,
    chat_member: {
      chat, from: user, date: Math.floor(Date.now() / 1000),
      old_chat_member: { status: oldStatus as never, user },
      new_chat_member: { status: newStatus as never, user, ...(o.isMember === undefined ? {} : { is_member: o.isMember }) },
    },
  };
}

export function reaction(emoji: string, from = learner(), messageId = 1000): TgUpdate {
  return { update_id: uid++, message_reaction: { chat: { id: from.id, type: "private" }, message_id: messageId, user: from, new_reaction: [{ type: "emoji", emoji }] } };
}
