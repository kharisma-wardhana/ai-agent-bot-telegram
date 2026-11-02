import { DurableObject } from "cloudflare:workers";
import type { Env } from "../config";
import { getDeps, type Deps } from "../deps";
import { handleAddKnowledge } from "../knowledge/add-knowledge";
import type { BotEvent } from "../telegram/parse-update";
import { handleAsk, handleStart, tryStartProgress } from "./ask-pipeline";

type QueuedEvent = Exclude<BotEvent, { kind: "ignore" }>;
const BUSY_STALE_MS = 5 * 60_000;

/**
 * One instance per learner (idFromName(telegram user id)). The webhook enqueues and returns at once;
 * the alarm drains the queue in order, so a learner's messages are handled one at a time and survive
 * the webhook returning. Errors are logged per event, never rethrown, so an alarm retry can't
 * double-send messages.
 */
export class LearnerSession extends DurableObject<Env> {
  async enqueue(event: QueuedEvent): Promise<void> {
    const queue = (await this.ctx.storage.get<QueuedEvent[]>("queue")) ?? [];
    queue.push(event);
    await this.ctx.storage.put("queue", queue);
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
    } finally {
      await this.ctx.storage.put("busy", 0);
    }
  }

  /** True when nothing is queued or in flight (used by tests and diagnostics). */
  async idle(): Promise<boolean> {
    const queue = (await this.ctx.storage.get<QueuedEvent[]>("queue")) ?? [];
    return queue.length === 0 && !(await this.ctx.storage.get<number>("busy"));
  }

  protected async handle(d: Deps, e: QueuedEvent): Promise<void> {
    switch (e.kind) {
      case "ask": {
        const progress = await tryStartProgress(d, e.from.id);
        await handleAsk(d, e, { question: e.question, kind: "text" }, progress);
        return;
      }
      case "start":
        return handleStart(d, e);
      case "add_knowledge":
        return handleAddKnowledge(d, e);
      default:
        return; // later slices: add_knowledge, feedback, dm_text, hapusdata
    }
  }
}
