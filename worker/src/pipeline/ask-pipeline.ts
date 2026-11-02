import { composeFinal } from "../answer/length-policy";
import { isIdentityQuestion, PERSONA_INTRO, PRIVACY_NOTICE } from "../answer/persona";
import { buildMessages, compressionMessages } from "../answer/prompts";
import type { Backend, QuestionKind } from "../db/repository";
import type { Deps } from "../deps";
import { recallMemory } from "../memory/graph-store";
import { decide, sourceLine } from "../rag/grounding";
import { retrieve } from "../rag/retrieve";
import { TelegramError } from "../telegram/client";
import type { BotEvent } from "../telegram/parse-update";
import { FEEDBACK_KEYBOARD, ProgressMessage } from "../telegram/progress";
import type { TgUser } from "../telegram/types";
import { runFallback } from "./fallback";

export const LEARNER_FALLBACK_DM = "Maaf, materi untuk pertanyaan ini belum ada di dokumen kelas. Pertanyaanmu sudah aku teruskan ke mentor ya. 🙏";
export const START_NOTICE = (bot: string, payload: string) =>
  `Jawabanmu sudah siap! Supaya aku bisa kirim lewat DM, tekan Start di sini dulu ya: https://t.me/${bot}?start=${payload}`;

export type AnswerOutcome =
  | { kind: "answer"; text: string; sources: string[]; backend: Backend | null }
  | { kind: "fallback"; reason: string };

const NOT_FOUND_GUARD = 12; // buffer this many chars before streaming, so a NOT_FOUND reply is never shown

/** Retrieval → generation → grounding → length policy. Streams into `progress` when given. */
export async function answerQuestion(
  d: Deps,
  a: { learnerId: number; sessionId: string; question: string; imageDataUrl?: string; progress: ProgressMessage | null },
): Promise<AnswerOutcome> {
  if (!a.imageDataUrl && isIdentityQuestion(a.question)) return { kind: "answer", text: PERSONA_INTRO, sources: [], backend: null };

  await a.progress?.stage("searching");
  const history = await d.repo.getTurns(a.sessionId, 6);
  // Follow-ups ("jelaskan lebih sederhana") carry little searchable text: if the question alone finds
  // nothing, search with the session's previous question, which is the topic being followed up.
  const opts = { topK: d.cfg.retrievalTopK, threshold: d.cfg.retrievalThreshold };
  let r = await retrieve(a.question || "gambar", d.embedder, d.repo, opts);
  const prevQuestion = [...history].reverse().find((t) => t.role === "user")?.content;
  if (!r.found && prevQuestion) r = await retrieve(prevQuestion, d.embedder, d.repo, opts);
  if (!r.found && !a.imageDataUrl) return { kind: "fallback", reason: "low_similarity" };

  await a.progress?.stage("composing");
  const memoryNotes = await recallMemory(d, a.learnerId, r.embedding);
  const messages = buildMessages({ question: a.question, chunks: r.chunks, history, memoryNotes, imageDataUrl: a.imageDataUrl, maxChars: d.cfg.maxAnswerChars });

  let buf = "";
  let streaming = false;
  const onDelta = async (fragment: string) => {
    if (!a.progress) return;
    if (streaming) return a.progress.stream(fragment);
    buf += fragment;
    const head = buf.trimStart();
    if (head.length < NOT_FOUND_GUARD || head.toUpperCase().startsWith("NOT_FOUND")) return;
    streaming = true;
    await a.progress.stream(buf);
  };
  const onRetry = () => {
    buf = "";
    streaming = false;
    a.progress?.resetStream();
  };

  const res = await d.router.chat({ messages, maxTokens: 600 }, Boolean(a.imageDataUrl), onDelta, onRetry);
  const decision = decide(r.found || Boolean(a.imageDataUrl), r.chunks, res.content);
  if (decision.kind === "fallback") return { kind: "fallback", reason: decision.reason };

  const compress = async (text: string, target: number) =>
    (await d.router.chat({ messages: compressionMessages(text, target), maxTokens: 400 }, false)).content;
  const text = await composeFinal(res.content, sourceLine(decision.sources), d.cfg.maxAnswerChars, compress);
  return { kind: "answer", text, sources: decision.sources, backend: res.backend };
}

export interface ResolvedQuestion { question: string; imageDataUrl?: string; kind: QuestionKind; photoFileId?: string }
export interface Origin { chatId: number; threadId: number | null; messageId: number }

/**
 * A question from the group (#askAI, origin set) or a DM follow-up (origin null) → DM answer,
 * deep link + held answer when the learner can't be DMed, or mentor fallback.
 */
export async function handleQuestion(d: Deps, from: TgUser, origin: Origin | null, resolved: ResolvedQuestion, progress: ProgressMessage | null): Promise<void> {
  const learner = await d.repo.upsertLearner({ telegramId: from.id, displayName: from.first_name, username: from.username ?? null, started: origin === null });
  const open = await d.repo.getOpenSession(learner.telegramId);
  const sessionId = open?.id ?? (await d.repo.openSession({ learnerId: learner.telegramId, chatId: origin?.chatId ?? null, threadId: origin?.threadId ?? null, messageId: origin?.messageId ?? null }));
  const e = { from, chatId: origin?.chatId ?? null, threadId: origin?.threadId ?? null, messageId: origin?.messageId ?? null };

  let outcome: AnswerOutcome;
  try {
    outcome = await answerQuestion(d, { learnerId: learner.telegramId, sessionId, question: resolved.question, imageDataUrl: resolved.imageDataUrl, progress });
  } catch (err) {
    console.error("answer failed", (err as Error).message);
    outcome = { kind: "fallback", reason: "error" };
  }

  await d.repo.addTurn({ sessionId, role: "user", content: resolved.question || "(gambar/suara)", questionKind: resolved.kind });

  if (outcome.kind === "fallback") {
    await runFallback(d, { chatId: e.chatId, threadId: e.threadId, messageId: e.messageId, from: e.from, question: resolved.question, sessionId, photoFileId: resolved.photoFileId });
    await d.repo.addTurn({ sessionId, role: "assistant", content: LEARNER_FALLBACK_DM, answerSource: "fallback", stageTimings: progress?.timings });
    if (progress) {
      await progress.finish(LEARNER_FALLBACK_DM).catch(() => undefined);
      await sendPrivacyNoticeOnce(d, learner.telegramId, learner.privacyNoticeShown);
    }
    return;
  }

  await d.repo.addTurn({ sessionId, role: "assistant", content: outcome.text, answerSource: outcome.sources.length ? "lesson_docs" : undefined, sources: outcome.sources, backend: outcome.backend ?? undefined, stageTimings: progress?.timings });

  if (progress) {
    await progress.finish(outcome.text, FEEDBACK_KEYBOARD);
    await sendPrivacyNoticeOnce(d, learner.telegramId, learner.privacyNoticeShown);
    return;
  }
  // Learner can't be DMed yet: hold the answer and post a deep link in the topic (AC 12).
  const pendingId = await d.repo.holdAnswer(learner.telegramId, sessionId, "not_started", { text: outcome.text });
  if (e.chatId === null) return;
  await d.tg.sendMessage(e.chatId, START_NOTICE(d.cfg.botUsername, `q_${pendingId}`), { threadId: e.threadId ?? undefined, replyTo: e.messageId ?? undefined });
}

/** Group #askAI entry point. */
export function handleAsk(d: Deps, e: Extract<BotEvent, { kind: "ask" }>, resolved: ResolvedQuestion, progress: ProgressMessage | null): Promise<void> {
  return handleQuestion(d, e.from, { chatId: e.chatId, threadId: e.threadId, messageId: e.messageId }, resolved, progress);
}

/** Opens the progress DM; null when the learner hasn't started the bot (403). */
export async function tryStartProgress(d: Deps, learnerId: number): Promise<ProgressMessage | null> {
  const p = new ProgressMessage(d.tg, learnerId, d.cfg.maxAnswerChars, d.now);
  try {
    await p.start();
    return p;
  } catch (err) {
    if (err instanceof TelegramError && err.cannotDm) return null;
    throw err;
  }
}

/** /start [q_<id>]: marks the learner started and delivers any held answers (AC 12). */
export async function handleStart(d: Deps, e: Extract<BotEvent, { kind: "start" }>): Promise<void> {
  const learner = await d.repo.upsertLearner({ telegramId: e.from.id, displayName: e.from.first_name, username: e.from.username ?? null, started: true });
  const held = await d.repo.takePendingAnswers(e.from.id, "not_started", 5);
  if (held.length === 0) await d.tg.sendMessage(e.from.id, PERSONA_INTRO);
  for (const h of held) await d.tg.sendMessage(e.from.id, String(h.payload.text ?? ""), { replyMarkup: FEEDBACK_KEYBOARD });
  await sendPrivacyNoticeOnce(d, learner.telegramId, learner.privacyNoticeShown);
}

/** The first DM a learner ever gets is followed by the one-time privacy notice (spec › Behaviour 12). */
export async function sendPrivacyNoticeOnce(d: Deps, learnerId: number, alreadyShown: boolean): Promise<void> {
  if (alreadyShown) return;
  try {
    await d.tg.sendMessage(learnerId, PRIVACY_NOTICE);
    await d.repo.markPrivacyNoticeShown(learnerId);
  } catch (e) {
    console.error("privacy notice failed", (e as Error).message);
  }
}

export const HAPUSDATA_DONE = "🗑️ Semua datamu (sesi, riwayat percakapan, feedback, dan memori jangka panjang) sudah dihapus.";

/** /hapusdata: deletes everything stored about the caller, and only the caller (AC 17). */
export async function handleHapusData(d: Deps, e: Extract<BotEvent, { kind: "hapusdata" }>): Promise<void> {
  await d.repo.deleteLearnerData(e.from.id);
  await d.tg.sendMessage(e.from.id, HAPUSDATA_DONE);
}
