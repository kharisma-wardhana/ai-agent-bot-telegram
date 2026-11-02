import type { Deps } from "../deps";
import type { Origin, ResolvedQuestion } from "../pipeline/ask-pipeline";
import type { Media } from "../telegram/parse-update";
import type { ProgressMessage } from "../telegram/progress";
import type { TgUser } from "../telegram/types";
import { toBase64 } from "./transcribe";

export const IMAGE_DEFERRED_MSG =
  "🖼️ Server pembaca gambar sedang offline. Pertanyaanmu sudah aku simpan dan akan aku jawab otomatis begitu server online lagi (jawabannya sedikit tertunda ya).";
export const AUDIO_FAILED_MSG = "Maaf, pesan suaranya belum bisa aku dengar dengan jelas. Coba kirim ulang atau ketik pertanyaannya ya. 🙏";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export function mimeFromPath(path: string): string {
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.webp$/i.test(path)) return "image/webp";
  return "image/jpeg";
}

/** Payload stored for an image question deferred while Kaggle is offline. Holds the file_id, never the bytes. */
export interface DeferredImage { from: TgUser; origin: Origin | null; question: string; fileId: string }

export type MediaResolution = { kind: "ready"; resolved: ResolvedQuestion } | { kind: "deferred" } | { kind: "failed"; message: string };

/**
 * Turns voice/photo questions into text (+ image data URL). Bytes live only in memory for the
 * duration of this call (AC 10, 11).
 */
export async function resolveMedia(d: Deps, media: Media, caption: string, ctx: { from: TgUser; origin: Origin | null; progress: ProgressMessage | null }): Promise<MediaResolution> {
  if (media.type === "voice") {
    await ctx.progress?.stage("transcribing");
    try {
      const { bytes } = await d.tg.downloadFile(media.fileId, MAX_AUDIO_BYTES);
      const transcript = await d.transcriber.transcribe(bytes, media.mime);
      if (!transcript) return { kind: "failed", message: AUDIO_FAILED_MSG };
      return { kind: "ready", resolved: { question: [caption, transcript].filter(Boolean).join("\n"), kind: "voice" } };
    } catch (e) {
      console.error("transcription failed", (e as Error).message);
      return { kind: "failed", message: AUDIO_FAILED_MSG };
    }
  }

  await ctx.progress?.stage("reading_image");
  const route = await d.router.route(true);
  if ("deferred" in route) {
    const payload: DeferredImage = { from: ctx.from, origin: ctx.origin, question: caption, fileId: media.fileId };
    await d.repo.upsertLearner({ telegramId: ctx.from.id, displayName: ctx.from.first_name, username: ctx.from.username ?? null, started: false });
    await d.repo.holdAnswer(ctx.from.id, null, "image_deferred", payload as unknown as Record<string, unknown>);
    return { kind: "deferred" };
  }
  const { bytes, path } = await d.tg.downloadFile(media.fileId, MAX_IMAGE_BYTES);
  return {
    kind: "ready",
    resolved: { question: caption || "Jelaskan gambar ini berdasarkan materi kelas.", imageDataUrl: `data:${mimeFromPath(path)};base64,${toBase64(bytes)}`, kind: "photo", photoFileId: media.fileId },
  };
}
