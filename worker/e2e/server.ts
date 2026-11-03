/**
 * Playwright target: the real dashboard sub-app (src/dashboard/app.ts) served in Node, with an in-memory
 * repository and a fake Telegram. No network, no Supabase, no Cloudflare. Test-only routes live under /__test.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { parseConfig, type Env } from "../src/config";
import { dashboardApp } from "../src/dashboard/app";
import { setDepsOverride, type Deps } from "../src/deps";
import { TelegramClient } from "../src/telegram/client";
import { FakeEmbedder } from "../test/fakes/fake-llm";
import { FakeRepository } from "../test/fakes/fake-repository";
import { FakeTelegram } from "../test/fakes/fake-telegram";

export const PORT = Number(process.env.E2E_PORT ?? 8788);
export const ORIGIN = `http://localhost:${PORT}`;
export const OWNER = { email: "owner@skilly.id", telegramId: 111 };
export const GROUP_ID = -1001234567890;

const env = {
  TELEGRAM_BOT_TOKEN: "123:TOKEN", TELEGRAM_WEBHOOK_SECRET: "s", SUPABASE_SERVICE_KEY: "k", KAGGLE_SHARED_SECRET: "ks", MCP_TOKENS: "",
  BOT_USERNAME: "skilly_test_bot", GROUP_CHAT_ID: String(GROUP_ID), MENTOR_IDS: "111,222", KNOWLEDGE_WHITELIST_IDS: "111",
  SUPABASE_URL: "https://fake.supabase.co", KAGGLE_BASE_URL: "https://kaggle.fake", RETRIEVAL_THRESHOLD: "0.3",
  DASHBOARD_OWNERS: `${OWNER.email}:${OWNER.telegramId}`, DASHBOARD_BASE_URL: ORIGIN,
} as unknown as Env;

let repo = new FakeRepository();
let tg = new FakeTelegram();
const embedder = new FakeEmbedder();

function deps(): Deps {
  const cfg = parseConfig(env);
  return {
    cfg, repo, embedder, env, fetchFn: tg.fetch, now: Date.now,
    tg: new TelegramClient(cfg.telegramBotToken, tg.fetch),
    router: { primaryOnline: async () => false } as unknown as Deps["router"],
    transcriber: { transcribe: async () => "" },
  };
}
setDepsOverride(() => deps());

const app = new Hono();
app.route("/dashboard", dashboardApp() as unknown as Hono);

// ---------- Test-only controls (never part of the Worker) ----------
app.post("/__test/reset", (c) => {
  repo = new FakeRepository();
  tg = new FakeTelegram();
  return c.text("ok");
});

/** Last login link DMed to a chat. */
app.get("/__test/login-link", (c) => {
  const chat = Number(c.req.query("chat"));
  const t = tg.textsIn(chat).filter((x) => x.includes("/dashboard/auth?t=")).at(-1) ?? "";
  return c.text(/(https?:\/\/\S+\/dashboard\/auth\?t=\S+)/.exec(t)?.[1] ?? "", t ? 200 : 404);
});

/** A follow-up from a learner in a group topic, as the fallback would create it. */
app.post("/__test/followup", async (c) => {
  const q = c.req.query("q") ?? "Apa bedanya RAG dan fine-tuning?";
  const learnerId = Number(c.req.query("learner") ?? 501);
  const started = c.req.query("started") !== "0";
  await repo.upsertLearner({ telegramId: learnerId, displayName: c.req.query("name") ?? "Ani", username: null, started });
  const sessionId = await repo.openSession({ learnerId, chatId: GROUP_ID, threadId: 55, messageId: 4242 });
  const id = await repo.addFollowupV2(sessionId, q, [111, 222], c.req.query("photo") ?? null);
  if (c.req.query("photo")) tg.files.set(`files/${c.req.query("photo")}`, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  return c.json({ id });
});

/** Every Bot API call so far (method + params), for asserting delivery. */
app.get("/__test/calls", (c) => c.json(tg.calls));

serve({ fetch: app.fetch, port: PORT }, () => console.log(`e2e dashboard server on ${ORIGIN}`));
