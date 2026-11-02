import { DurableObject } from "cloudflare:workers";
import type { Env } from "../config";
import { getDeps, type Deps } from "../deps";
import { handleAddKnowledge } from "../knowledge/add-knowledge";
import { feedbackFromEvent, handleFeedback, isTextFeedback, sessionDeadline } from "../memory/session";
import { IMAGE_DEFERRED_MSG, resolveMedia, type DeferredImage } from "../media/image";
import type { BotEvent, Media } from "../telegram/parse-update";
import type { ProgressMessage } from "../telegram/progress";
import type { TgUser } from "../telegram/types";
import { handleHapusData, handleQuestion, handleStart, tryStartProgress, type Origin } from "./ask-pipeline";

/** Internal event: an image question deferred while Kaggle was offline, re-queued by the cron. */
export interface DeferredImageEvent { kind: "deferred_image"; from: TgUser; payload: DeferredImage }
type QueuedEvent = Exclude<BotEvent, { kind: "ignore" }> | DeferredImageEvent;
const BUSY_STALE_MS = 5 * 60_000;

/**
 * One instance per learner (idFromName(telegram user id)). The webhook enqueues and returns at once;
 * the alarm drains the queue in order, so a learner's messages are handled one at a time and survive
 * the webhook returning. The same alarm then waits for the session TTL (24 h after last activity).
 * Errors are logged per event, never rethrown, so an alarm retry can't double-send messages.
 */
export class LearnerSession extends DurableObject<Env> {
  async enqueue(event: QueuedEvent): Promise<void> {
    const queue = (await this.ctx.storage.get<QueuedEvent[]>("queue")) ?? [];
    queue.push(event);
    await this.ctx.storage.put({ queue, learnerId: event.from.id });
    await this.ctx.storage.setAlarm(Date.now());
  }

  override async alarm(): Promise<void> {
    const busySince = (await this.ctx.storage.get<number>("busy")) ?? 0;
    if (busySince && Date.now() - busySince < BUSY_STALE_MS) return; // another alarm run is draining
    await this.ctx.storage.put("busy", Date.now()); // a timestamp, so an evicted run can't wedge the learner
    try {
      const d = getDeps(this.env);
      for (;;) {
        const queue = (await this.ctx.storage.get<QueuedEvent[]>("queue")) ?? [];
        const next = queue.shift();
        if (!next) break;
        await this.ctx.storage.put("queue", queue);
        try {
          await this.handle(d, next);
        } catch (e) {
          console.error(`event ${next.kind} failed`, (e as Error).message);
        }
      }
      await this.scheduleExpiry(d);
    } finally {
      await this.ctx.storage.put("busy", 0);
    }
  }

  /** Expires the session once idle past the TTL; otherwise sets the alarm for that moment (AC 16). */
  private async scheduleExpiry(d: Deps): Promise<void> {
    const learnerId = await this.ctx.storage.get<number>("learnerId");
    if (learnerId === undefined) return;
    try {
      const deadline = await sessionDeadline(d, learnerId);
      if (deadline === null) return;
      if (deadline <= Date.now()) await d.repo.expireSessions(d.cfg.sessionTtlHours);
      else await this.ctx.storage.setAlarm(deadline);
    } catch (e) {
      console.error("session expiry check failed", (e as Error).message);
    }
  }

  /** True when nothing is queued or in flight (used by tests and diagnostics). */
  async idle(): Promise<boolean> {
    const queue = (await this.ctx.storage.get<QueuedEvent[]>("queue")) ?? [];
    return queue.length === 0 && !(await this.ctx.storage.get<number>("busy"));
  }

  /** Text, voice or photo question from the group (origin) or DM (origin null). */
  private async question(d: Deps, from: TgUser, origin: Origin | null, text: string, media: Media | null): Promise<void> {
    const progress: ProgressMessage | null = await tryStartProgress(d, from.id);
    if (!media) return handleQuestion(d, from, origin, { question: text, kind: "text" }, progress);
    const res = await resolveMedia(d, media, text, { from, origin, progress });
    if (res.kind === "ready") return handleQuestion(d, from, origin, res.resolved, progress);
    const msg = res.kind === "deferred" ? IMAGE_DEFERRED_MSG : res.message;
    if (progress) await progress.finish(msg);
    else if (origin) await d.tg.sendMessage(origin.chatId, msg, { threadId: origin.threadId ?? undefined, replyTo: origin.messageId });
  }

  protected async handle(d: Deps, e: QueuedEvent): Promise<void> {
    switch (e.kind) {
      case "ask":
        return this.question(d, e.from, { chatId: e.chatId, threadId: e.threadId, messageId: e.messageId }, e.question, e.media);
      case "dm_text": {
        if (await isTextFeedback(d, e)) {
          await handleFeedback(d, e.from.id, "text", e.text.slice(0, 500));
          return;
        }
        return this.question(d, e.from, null, e.text, e.media);
      }
      case "deferred_image":
        return this.question(d, e.from, e.payload.origin, e.payload.question, { type: "photo", fileId: e.payload.fileId });
      case "feedback": {
        const f = feedbackFromEvent(e);
        await handleFeedback(d, e.from.id, f.kind, f.value, f.callbackId);
        return;
      }
      case "start":
        return handleStart(d, e);
      case "add_knowledge":
        return handleAddKnowledge(d, e);
      case "hapusdata":
        await handleHapusData(d, e);
        await this.ctx.storage.deleteAlarm();
        return;
    }
  }
}
