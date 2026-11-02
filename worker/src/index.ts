import { Hono } from "hono";
import type { Env } from "./config";
import { getDeps, type Deps } from "./deps";
import type { DeferredImage } from "./media/image";
import type { DeferredImageEvent, LearnerSession } from "./pipeline/learner-session";
import { classify } from "./telegram/parse-update";
import type { TgUpdate } from "./telegram/types";

export { LearnerSession } from "./pipeline/learner-session";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true }));

/** Constant-time string comparison for secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function learnerStub(env: Env, userId: number) {
  const ns = env.LEARNER_SESSION as DurableObjectNamespace<LearnerSession>;
  return ns.get(ns.idFromName(String(userId)));
}

app.post("/telegram/webhook", async (c) => {
  const d = getDeps(c.env);
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!safeEqual(secret, d.cfg.telegramWebhookSecret)) return c.json({ error: "unauthorized" }, 401);

  let update: TgUpdate;
  try {
    update = await c.req.json<TgUpdate>();
  } catch {
    return c.json({ ok: true }); // malformed body: acknowledge so Telegram doesn't retry forever
  }
  const event = classify(update, d.cfg);
  if (event.kind === "ignore") return c.json({ ok: true });

  await learnerStub(c.env, event.from.id).enqueue(event);
  return c.json({ ok: true });
});

/** Re-queues image questions deferred while Kaggle was offline, once it is back (AC 11). */
export async function deliverDeferredImages(d: Deps, env: Env): Promise<number> {
  if (!(await d.router.primaryOnline())) return 0;
  const items = await d.repo.takePendingAnswers(null, "image_deferred", 20);
  for (const item of items) {
    const payload = item.payload as unknown as DeferredImage;
    const event: DeferredImageEvent = { kind: "deferred_image", from: payload.from, payload };
    await learnerStub(env, payload.from.id).enqueue(event);
  }
  return items.length;
}

/** Cron (every 5 min): deferred images. Later steps add expiry and the long-term-memory job. */
export async function runScheduled(env: Env): Promise<void> {
  const d = getDeps(env);
  try {
    await deliverDeferredImages(d, env);
  } catch (e) {
    console.error("deferred image delivery failed", (e as Error).message);
  }
}

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
