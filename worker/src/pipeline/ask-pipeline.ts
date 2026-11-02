import { composeFinal } from "../answer/length-policy";
import { isIdentityQuestion, PERSONA_INTRO } from "../answer/persona";
import { buildMessages, compressionMessages } from "../answer/prompts";
import type { Backend, QuestionKind } from "../db/repository";
import type { Deps } from "../deps";
import { decide, sourceLine } from "../rag/grounding";
import { retrieve } from "../rag/retrieve";
import { TelegramError } from "../telegram/client";
import type { BotEvent } from "../telegram/parse-update";
import { FEEDBACK_KEYBOARD, ProgressMessage } from "../telegram/progress";
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
  a: { sessionId: string; question: string; imageDataUrl?: string; progress: ProgressMessage | null },
): Promise<AnswerOutcome> {
  if (!a.imageDataUrl && isIdentityQuestion(a.question)) return { kind: "answer", text: PERSONA_INTRO, sources: [], backend: null };

  await a.progress?.stage("searching");
  const r = await retrieve(a.question || "gambar", d.embedder, d.repo, { topK: d.cfg.retrievalTopK, threshold: d.cfg.retrievalThreshold });
  if (!r.found && !a.imageDataUrl) return { kind: "fallback", reason: "low_similarity" };

  await a.progress?.stage("composing");
  const history = await d.repo.getTurns(a.sessionId, 6);
  const messages = buildMessages({ question: a.question, chunks: r.chunks, history, imageDataUrl: a.imageDataUrl, maxChars: d.cfg.maxAnswerChars });

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

/** Group #askAI → DM answer (or deep link + held answer) or mentor fallback. */
export async function handleAsk(d: Deps, e: Extract<BotEvent, { kind: "ask" }>, resolved: { question: string; imageDataUrl?: string; kind: QuestionKind; photoFileId?: string }, progress: ProgressMessage | null): Promise<void> {
  const learner = await d.repo.upsertLearner({ telegramId: e.from.id, displayName: e.from.first_name, username: e.from.username ?? null, started: false });
  const open = await d.repo.getOpenSession(learner.telegramId);
  const sessionId = open?.id ?? (await d.repo.openSession({ learnerId: learner.telegramId, chatId: e.chatId, threadId: e.threadId, messageId: e.messageId }));

  let outcome: AnswerOutcome;
  try {
    outcome = await answerQuestion(d, { sessionId, question: resolved.question, imageDataUrl: resolved.imageDataUrl, progress });
  } catch (err) {
    console.error("answer failed", (err as Error).message);
    outcome = { kind: "fallback", reason: "error" };
  }

  await d.repo.addTurn({ sessionId, role: "user", content: resolved.question || "(gambar/suara)", questionKind: resolved.kind });

  if (outcome.kind === "fallback") {
    await runFallback(d, { chatId: e.chatId, threadId: e.threadId, messageId: e.messageId, from: e.from, question: resolved.question, sessionId, photoFileId: resolved.photoFileId });
    await d.repo.addTurn({ sessionId, role: "assistant", content: LEARNER_FALLBACK_DM, answerSource: "fallback", stageTimings: progress?.timings });
    if (progress) await progress.finish(LEARNER_FALLBACK_DM).catch(() => undefined);
    return;
  }

  await d.repo.addTurn({ sessionId, role: "assistant", content: outcome.text, answerSource: outcome.sources.length ? "lesson_docs" : undefined, sources: outcome.sources, backend: outcome.backend ?? undefined, stageTimings: progress?.timings });

  if (progress) {
    await progress.finish(outcome.text, FEEDBACK_KEYBOARD);
    return;
  }
  // Learner can't be DMed yet: hold the answer and post a deep link in the topic (AC 12).
  const pendingId = await d.repo.holdAnswer(learner.telegramId, sessionId, "not_started", { text: outcome.text });
  await d.tg.sendMessage(e.chatId, START_NOTICE(d.cfg.botUsername, `q_${pendingId}`), { threadId: e.threadId ?? undefined, replyTo: e.messageId });
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
  await d.repo.upsertLearner({ telegramId: e.from.id, displayName: e.from.first_name, username: e.from.username ?? null, started: true });
  const held = await d.repo.takePendingAnswers(e.from.id, "not_started", 5);
  if (held.length === 0) {
    await d.tg.sendMessage(e.from.id, PERSONA_INTRO);
    return;
  }
  for (const h of held) await d.tg.sendMessage(e.from.id, String(h.payload.text ?? ""), { replyMarkup: FEEDBACK_KEYBOARD });
}
