import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { parseConfig, type Env } from "../../src/config";
import type { LearnerSession } from "../../src/pipeline/learner-session";
import { setDepsOverride, type Deps } from "../../src/deps";
import { LlmRouter } from "../../src/llm/router";
import { TelegramClient } from "../../src/telegram/client";
import type { TgUpdate } from "../../src/telegram/types";
import { FakeBackend, FakeEmbedder, lastUser, type Script } from "./fake-llm";
import { FakeRepository } from "./fake-repository";
import { BOT, FakeTelegram, GROUP_ID } from "./fake-telegram";

export const WEBHOOK_SECRET = "hook-secret";
export const MENTORS = [111, 222];
export const WHITELIST = [111];
/** Bootstrap dashboard owner (config). Shares Telegram ID 111 with a mentor so de-duplication is exercised. */
export const OWNER = { email: "owner@skilly.id", telegramId: 111 };
export const DASH_BASE = "https://bot.test";

/** Default model behaviour: answer from the documents block, or NOT_FOUND if it's empty. */
export const groundedScript: Script = (req) => {
  const u = lastUser(req);
  if (/Ringkas teks berikut/.test(String(req.messages[0]?.content))) return "Ringkasan pendek.";
  if (u.includes("(tidak ada dokumen yang relevan)")) return "NOT_FOUND";
  return "Menurut materi, prompt yang baik itu jelas dan spesifik, ya kamu.";
};

export interface Harness {
  tg: FakeTelegram;
  repo: FakeRepository;
  embedder: FakeEmbedder;
  transcriber: { text: string; calls: number };
  kaggle: FakeBackend;
  workersAi: FakeBackend;
  deps: Deps;
  send(update: TgUpdate, secret?: string): Promise<Response>;
  drain(userId: number): Promise<void>;
  seed(title: string, text: string): Promise<void>;
  /** Request to /dashboard/* through the real Worker entry point. Origin defaults to ours; null omits it. */
  dash(path: string, o?: DashRequest): Promise<Response>;
  /** Drives the real magic-link flow (login form → DM → POST /auth) and returns the session cookies. */
  login(email: string, telegramId: number): Promise<DashSession>;
}

export interface DashRequest { method?: "GET" | "POST"; form?: Record<string, string>; session?: DashSession; origin?: string | null; headers?: Record<string, string> }
export interface DashSession { cookie: string; csrf: string; sid: string }

/** Cookies from a response's Set-Cookie headers, name → value. */
export function setCookies(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const i = pair!.indexOf("=");
    out[pair!.slice(0, i).trim()] = decodeURIComponent(pair!.slice(i + 1).trim());
  }
  return out;
}

/** The login link token from the last login DM sent to a chat. */
export function loginTokenFrom(tg: FakeTelegram, chatId: number): string | null {
  const t = tg.textsIn(chatId).filter((x) => x.includes("/dashboard/auth?t=")).at(-1);
  const m = t ? /\/dashboard\/auth\?t=([A-Za-z0-9_%-]+)/.exec(t) : null;
  return m ? decodeURIComponent(m[1]!) : null;
}

export function makeHarness(opts: { heartbeatAge?: number | null } = {}): Harness {
  const tg = new FakeTelegram();
  const repo = new FakeRepository();
  repo.heartbeatAge = opts.heartbeatAge === undefined ? 5 : opts.heartbeatAge;
  const embedder = new FakeEmbedder();
  const transcriber = { text: "apa itu few-shot prompting", calls: 0, async transcribe() { this.calls++; return this.text; } };
  const kaggle = new FakeBackend("kaggle", true, groundedScript);
  const workersAi = new FakeBackend("workers_ai", false, groundedScript);
  const testEnv = {
    ...(env as unknown as Env),
    TELEGRAM_BOT_TOKEN: "123:TOKEN", TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET, SUPABASE_SERVICE_KEY: "svc", KAGGLE_SHARED_SECRET: "ks",
    MCP_TOKENS: "mcp-token", BOT_USERNAME: BOT, GROUP_CHAT_ID: String(GROUP_ID), MENTOR_IDS: MENTORS.join(","),
    KNOWLEDGE_WHITELIST_IDS: WHITELIST.join(","), SUPABASE_URL: "https://fake.supabase.co", KAGGLE_BASE_URL: "https://kaggle.fake",
    RETRIEVAL_THRESHOLD: "0.3",
    DASHBOARD_OWNERS: `${OWNER.email}:${OWNER.telegramId}`, DASHBOARD_BASE_URL: DASH_BASE,
  } as Env;
  const cfg = parseConfig(testEnv);
  const deps: Deps = {
    cfg, repo, embedder, transcriber, env: testEnv, fetchFn: tg.fetch, now: Date.now,
    tg: new TelegramClient(cfg.telegramBotToken, tg.fetch),
    router: new LlmRouter(kaggle, workersAi, () => repo.heartbeatAgeSeconds("kaggle"), cfg.heartbeatMaxAgeS, Date.now, 0),
  };
  setDepsOverride(() => deps);

  return {
    tg, repo, embedder, transcriber, kaggle, workersAi, deps,
    send: (update, secret = WEBHOOK_SECRET) =>
      (exports as unknown as { default: Fetcher }).default.fetch(new Request("https://bot.test/telegram/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
        body: JSON.stringify(update),
      })),
    drain: async (userId) => {
      // Miniflare may already have fired the alarm on its own; trigger it, then wait until idle.
      const ns = (env as unknown as Env).LEARNER_SESSION as DurableObjectNamespace<LearnerSession>;
      const stub = ns.get(ns.idFromName(String(userId)));
      for (let i = 0; i < 200; i++) {
        await runDurableObjectAlarm(stub);
        if (await stub.idle()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`learner ${userId} session never became idle`);
    },
    dash: (path, o = {}) => {
      const headers: Record<string, string> = { Accept: "text/html", ...(o.headers ?? {}) };
      if (o.origin !== null) headers.Origin = o.origin ?? DASH_BASE;
      if (o.session) headers.Cookie = o.session.cookie;
      let body: string | undefined;
      if (o.form) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(o.form).toString();
      }
      return (exports as unknown as { default: Fetcher }).default.fetch(new Request(`${DASH_BASE}${path}`, {
        method: o.method ?? (o.form ? "POST" : "GET"), headers, body, redirect: "manual",
      }));
    },
    login: async (email, telegramId) => {
      const fetchDash = (path: string, form: Record<string, string>) =>
        (exports as unknown as { default: Fetcher }).default.fetch(new Request(`${DASH_BASE}${path}`, {
          method: "POST", redirect: "manual",
          headers: { Origin: DASH_BASE, "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
          body: new URLSearchParams(form).toString(),
        }));
      await fetchDash("/dashboard/login", { email });
      const t = loginTokenFrom(tg, telegramId);
      if (!t) throw new Error(`no login link sent to ${telegramId}`);
      const res = await fetchDash("/dashboard/auth", { t });
      const c = setCookies(res);
      if (!c.sk_sess || !c.sk_csrf) throw new Error(`login failed (${res.status})`);
      return { cookie: `sk_sess=${c.sk_sess}; sk_csrf=${c.sk_csrf}`, csrf: c.sk_csrf, sid: c.sk_sess };
    },
    seed: async (title, text) => {
      const [v] = await embedder.embed([text]);
      await repo.insertKnowledge({ title, sourceType: "md", origin: "seed", addedBy: null, r2Key: null, contentHash: title }, [{ position: 0, content: text, embedding: v! }]);
    },
  };
}
