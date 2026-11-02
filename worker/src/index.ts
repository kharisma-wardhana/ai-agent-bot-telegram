import { Hono } from "hono";
import type { Env } from "./config";
import { getDeps } from "./deps";
import type { LearnerSession } from "./pipeline/learner-session";
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

  const ns = c.env.LEARNER_SESSION as DurableObjectNamespace<LearnerSession>;
  await ns.get(ns.idFromName(String(event.from.id))).enqueue(event);
  return c.json({ ok: true });
});

export default app;
