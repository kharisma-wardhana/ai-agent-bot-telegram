import type { TelegramClient } from "./client";
import type { InlineKeyboard } from "./types";

export const STAGES = {
  received: "✅ Pertanyaan diterima",
  transcribing: "🎧 Mentranskrip audio",
  reading_image: "🖼️ Membaca gambar",
  searching: "🔎 Sedang mencari dokumen terkait",
  composing: "✍️ Menyusun jawaban",
} as const;
export type Stage = keyof typeof STAGES;

export const FEEDBACK_KEYBOARD: InlineKeyboard = {
  inline_keyboard: [[{ text: "👍 Membantu", callback_data: "fb:up" }, { text: "👎 Kurang", callback_data: "fb:down" }]],
};
export const FEEDBACK_PROMPT = "Apakah jawaban ini membantu? Tekan tombol, beri reaksi ✅/👍/👎, atau balas pesan ini.";

/**
 * One DM message updated in place: stage list, then the streamed answer, then the final answer.
 * Edits are throttled to ~1/s (Telegram rate limits); the streamed preview never shows more than maxChars.
 */
export class ProgressMessage {
  private messageId: number | null = null;
  private stages: string[] = [];
  private partial = "";
  private lastEdit = 0;
  readonly timings: Record<string, number> = {};
  private readonly startedAt: number;

  constructor(
    private readonly tg: TelegramClient,
    private readonly chatId: number,
    private readonly maxChars: number,
    private readonly now: () => number = Date.now,
    private readonly minIntervalMs = 1000,
  ) {
    this.startedAt = now();
  }

  get id(): number | null {
    return this.messageId;
  }

  async start(): Promise<void> {
    this.stages = [STAGES.received];
    this.timings.received = 0;
    const m = await this.tg.sendMessage(this.chatId, this.render());
    this.messageId = m.message_id;
    this.lastEdit = this.now();
  }

  async stage(s: Stage): Promise<void> {
    this.stages.push(STAGES[s]);
    this.timings[s] = this.now() - this.startedAt;
    await this.edit(true);
  }

  /** Appends a streamed fragment; edits at most once per interval. */
  async stream(fragment: string): Promise<void> {
    this.partial += fragment;
    await this.edit(false);
  }

  /** Discards the streamed preview (e.g. answer turned out to be NOT_FOUND or will be retried). */
  resetStream(): void {
    this.partial = "";
  }

  async finish(text: string, keyboard?: InlineKeyboard): Promise<void> {
    this.timings.done = this.now() - this.startedAt;
    if (this.messageId === null) {
      const m = await this.tg.sendMessage(this.chatId, text, { replyMarkup: keyboard });
      this.messageId = m.message_id;
      return;
    }
    await this.tg.editMessageText(this.chatId, this.messageId, text, keyboard);
  }

  render(): string {
    const head = this.stages.join("\n");
    if (!this.partial) return head;
    // The whole message, stage header included, stays within maxChars (AC 5).
    const room = Math.max(0, this.maxChars - head.length - 2);
    const preview = this.partial.length > room ? `${this.partial.slice(0, Math.max(0, room - 1))}…` : this.partial;
    return `${head}\n\n${preview}`;
  }

  private async edit(force: boolean): Promise<void> {
    if (this.messageId === null) return;
    const t = this.now();
    if (!force && t - this.lastEdit < this.minIntervalMs) return;
    this.lastEdit = t;
    try {
      await this.tg.editMessageText(this.chatId, this.messageId, this.render());
    } catch {
      /* a failed progress edit must never fail the answer */
    }
  }
}
