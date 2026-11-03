import { parseConfig, type Config, type Env } from "./config";
import { RpcRepository, SupabaseRpc, type Repository } from "./db/repository";
import { KaggleBackend } from "./llm/kaggle";
import { LlmRouter } from "./llm/router";
import type { Embedder } from "./llm/types";
import { WorkersAiBackend, WorkersAiEmbedder } from "./llm/workers-ai";
import { WorkersAiTranscriber, type Transcriber } from "./media/transcribe";
import { TelegramClient } from "./telegram/client";

/** Everything the pipeline needs, built once per request/alarm from env. */
export interface Deps {
  cfg: Config;
  repo: Repository;
  tg: TelegramClient;
  router: LlmRouter;
  embedder: Embedder;
  transcriber: Transcriber;
  env: Env;
  fetchFn: typeof fetch;
  now: () => number;
}

export function buildDeps(env: Env): Deps {
  const cfg = parseConfig(env);
  const repo = new RpcRepository(new SupabaseRpc(cfg.supabaseUrl, cfg.supabaseServiceKey));
  const router = new LlmRouter(
    new KaggleBackend(cfg.kaggleBaseUrl, cfg.kaggleSharedSecret),
    new WorkersAiBackend(env.AI),
    () => repo.heartbeatAgeSeconds("kaggle"),
    cfg.heartbeatMaxAgeS,
  );
  return {
    cfg,
    repo,
    tg: new TelegramClient(cfg.telegramBotToken),
    router,
    embedder: new WorkersAiEmbedder(env.AI),
    transcriber: new WorkersAiTranscriber(env.AI),
    env,
    fetchFn: (...args) => fetch(...args),
    now: Date.now,
  };
}

let override: ((env: Env) => Deps) | null = null;

/** Test seam: integration tests swap in fakes (Telegram, Supabase, models) without touching handlers. */
export function setDepsOverride(f: ((env: Env) => Deps) | null): void {
  override = f;
}

export function getDeps(env: Env): Deps {
  return override ? override(env) : buildDeps(env);
}
