/** Runtime configuration parsed from Worker env vars and secrets. */

export interface Env {
  // Secrets (wrangler secret put …)
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  SUPABASE_SERVICE_KEY: string;
  KAGGLE_SHARED_SECRET: string;
  MCP_TOKENS: string;
  // Vars (wrangler.toml [vars])
  BOT_USERNAME: string;
  GROUP_CHAT_ID: string;
  MENTOR_IDS: string;
  KNOWLEDGE_WHITELIST_IDS: string;
  SUPABASE_URL: string;
  KAGGLE_BASE_URL: string;
  RETRIEVAL_THRESHOLD?: string;
  RETRIEVAL_TOP_K?: string;
  HEARTBEAT_MAX_AGE_S?: string;
  MAX_ANSWER_CHARS?: string;
  SESSION_TTL_HOURS?: string;
}

export interface Config {
  telegramBotToken: string;
  telegramWebhookSecret: string;
  botUsername: string;
  groupChatId: number;
  mentorIds: number[];
  knowledgeWhitelistIds: number[];
  supabaseUrl: string;
  supabaseServiceKey: string;
  kaggleBaseUrl: string;
  kaggleSharedSecret: string;
  mcpTokens: string[];
  retrievalThreshold: number;
  retrievalTopK: number;
  heartbeatMaxAgeS: number;
  maxAnswerChars: number;
  sessionTtlHours: number;
}

export class ConfigError extends Error {}

function required(env: Record<string, unknown>, key: string): string {
  const v = env[key];
  if (typeof v !== "string" || v.trim() === "") throw new ConfigError(`Missing required config: ${key}`);
  return v.trim();
}

function int(value: string, key: string): number {
  if (!/^-?\d+$/.test(value.trim())) throw new ConfigError(`Config ${key} must be an integer, got "${value}"`);
  return Number(value.trim());
}

function idList(value: string, key: string, allowEmpty = false): number[] {
  const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowEmpty && parts.length === 0) throw new ConfigError(`Config ${key} must list at least one ID`);
  return parts.map((p) => int(p, key));
}

function num(value: string | undefined, key: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new ConfigError(`Config ${key} must be between ${min} and ${max}, got "${value}"`);
  return n;
}

export function parseConfig(env: Env): Config {
  const e = env as unknown as Record<string, unknown>;
  const mentorIds = idList(required(e, "MENTOR_IDS"), "MENTOR_IDS");
  return {
    telegramBotToken: required(e, "TELEGRAM_BOT_TOKEN"),
    telegramWebhookSecret: required(e, "TELEGRAM_WEBHOOK_SECRET"),
    botUsername: required(e, "BOT_USERNAME").replace(/^@/, ""),
    groupChatId: int(required(e, "GROUP_CHAT_ID"), "GROUP_CHAT_ID"),
    mentorIds,
    knowledgeWhitelistIds: idList(String(e.KNOWLEDGE_WHITELIST_IDS ?? ""), "KNOWLEDGE_WHITELIST_IDS", true),
    supabaseUrl: required(e, "SUPABASE_URL").replace(/\/+$/, ""),
    supabaseServiceKey: required(e, "SUPABASE_SERVICE_KEY"),
    kaggleBaseUrl: required(e, "KAGGLE_BASE_URL").replace(/\/+$/, ""),
    kaggleSharedSecret: required(e, "KAGGLE_SHARED_SECRET"),
    mcpTokens: String(e.MCP_TOKENS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    retrievalThreshold: num(env.RETRIEVAL_THRESHOLD, "RETRIEVAL_THRESHOLD", 0.45, 0, 1),
    retrievalTopK: num(env.RETRIEVAL_TOP_K, "RETRIEVAL_TOP_K", 5, 1, 20),
    heartbeatMaxAgeS: num(env.HEARTBEAT_MAX_AGE_S, "HEARTBEAT_MAX_AGE_S", 90, 10, 3600),
    maxAnswerChars: num(env.MAX_ANSWER_CHARS, "MAX_ANSWER_CHARS", 1000, 100, 4096),
    sessionTtlHours: num(env.SESSION_TTL_HOURS, "SESSION_TTL_HOURS", 24, 1, 168),
  };
}
