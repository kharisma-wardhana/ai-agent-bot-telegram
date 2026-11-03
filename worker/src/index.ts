import { Hono } from "hono";
import type { Env } from "./config";
import { dashboardApp } from "./dashboard/app";
import { getDeps, type Deps } from "./deps";
import { bearerOk, handleMcp } from "./mcp/server";
import type { DeferredImage } from "./media/image";
import { runMemoryJob } from "./memory/graph-extractor";
import type { DeferredImageEvent, LearnerSession } from "./pipeline/learner-session";
import { classify } from "./telegram/parse-update";
import type { TgUpdate } from "./telegram/types";
import { handleMemberJoin, handleMemberLeave, postPendingWelcomes } from "./welcome/welcome";

export { LearnerSession } from "./pipeline/learner-session";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true }));

/** Mentor follow-up dashboard (docs/mentor-followup-dashboard). */
app.route("/dashboard", dashboardApp());

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

  // Joins/leaves (cohort-welcome-message): one DB write or a few DMs, handled here rather than in the learner DO.
  if (event.kind === "member_join" || event.kind === "member_leave") {
    try {
      if (event.kind === "member_join") await handleMemberJoin(d, event.from);
      else await handleMemberLeave(d, event.from, event.kicked);
    } catch (e) {
      console.error(`${event.kind} failed`, (e as Error).message);
    }
    return c.json({ ok: true });
  }

  await learnerStub(c.env, event.from.id).enqueue(event);
  return c.json({ ok: true });
});

/** MCP endpoint for mentors (AC 19, 20). Stateless Streamable HTTP; no server-initiated stream. */
app.post("/mcp", async (c) => {
  const d = getDeps(c.env);
  if (!bearerOk(c.req.header("Authorization"), d.cfg.mcpTokens, safeEqual)) {
    return c.json(err401, 401, { "WWW-Authenticate": 'Bearer realm="mcp"' });
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleMcp(d, m)))).filter(Boolean);
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const res = await handleMcp(d, body as Parameters<typeof handleMcp>[1]);
  return res ? c.json(res) : c.body(null, 202);
});
app.get("/mcp", (c) => c.body(null, 405, { Allow: "POST" }));
const err401 = { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } };

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

/** Cron (every 5 min): expire idle sessions, distil ended ones into memory, deliver deferred images. Each job isolated. */
export async function runScheduled(env: Env): Promise<void> {
  const d = getDeps(env);
  const jobs: [string, () => Promise<unknown>][] = [
    ["welcome batch", () => postPendingWelcomes(d)], // cohort-welcome-message; first, and isolated like the rest
    ["expire sessions", () => d.repo.expireSessions(d.cfg.sessionTtlHours)],
    ["memory job", () => runMemoryJob(d)],
    ["deferred images", () => deliverDeferredImages(d, env)],
  ];
  for (const [name, job] of jobs) {
    try {
      await job();
    } catch (e) {
      console.error(`${name} failed`, (e as Error).message);
    }
  }
}

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
