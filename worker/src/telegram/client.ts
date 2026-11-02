import type { InlineKeyboard, TgMessage } from "./types";

export class TelegramError extends Error {
  constructor(readonly method: string, readonly code: number, readonly description: string) {
    super(`telegram ${method} failed (${code}): ${description}`); // never includes the token-bearing URL
  }

  /** 403 when the user never started the bot (or blocked it). */
  get cannotDm(): boolean {
    return this.code === 403;
  }

  get notModified(): boolean {
    return this.code === 400 && /message is not modified/i.test(this.description);
  }
}

export interface SendOptions {
  threadId?: number;
  replyTo?: number;
  replyMarkup?: InlineKeyboard;
  linkPreview?: boolean;
}

/** Thin Bot API client. All text is sent as plain text (no parse_mode) so learner/LLM text can't break formatting. */
export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
    } catch (e) {
      throw new TelegramError(method, 0, `network error: ${(e as Error).message}`);
    }
    let body: { ok: boolean; result?: T; error_code?: number; description?: string };
    try {
      body = await res.json();
    } catch {
      throw new TelegramError(method, res.status, "non-JSON response");
    }
    if (!body.ok) throw new TelegramError(method, body.error_code ?? res.status, body.description ?? "unknown error");
    return body.result as T;
  }

  sendMessage(chatId: number, text: string, o: SendOptions = {}): Promise<TgMessage> {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text,
      message_thread_id: o.threadId,
      reply_parameters: o.replyTo ? { message_id: o.replyTo, allow_sending_without_reply: true } : undefined,
      reply_markup: o.replyMarkup,
      link_preview_options: { is_disabled: !o.linkPreview },
    });
  }

  async editMessageText(chatId: number, messageId: number, text: string, replyMarkup?: InlineKeyboard): Promise<void> {
    try {
      await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: replyMarkup, link_preview_options: { is_disabled: true } });
    } catch (e) {
      if (e instanceof TelegramError && e.notModified) return;
      throw e;
    }
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: id, text });
  }

  /** Downloads a file the bot received. Returns bytes; nothing is persisted. */
  async downloadFile(fileId: string, maxBytes = 20 * 1024 * 1024): Promise<{ bytes: ArrayBuffer; path: string }> {
    const f = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
    if (!f.file_path) throw new TelegramError("getFile", 0, "no file_path");
    if (f.file_size && f.file_size > maxBytes) throw new TelegramError("getFile", 413, "file too large");
    const res = await this.fetchFn(`https://api.telegram.org/file/bot${this.token}/${f.file_path}`);
    if (!res.ok) throw new TelegramError("downloadFile", res.status, "download failed");
    return { bytes: await res.arrayBuffer(), path: f.file_path };
  }
}
