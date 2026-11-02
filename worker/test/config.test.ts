import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig, type Env } from "../src/config";

const base: Env = {
  TELEGRAM_BOT_TOKEN: "t",
  TELEGRAM_WEBHOOK_SECRET: "s",
  SUPABASE_SERVICE_KEY: "k",
  KAGGLE_SHARED_SECRET: "ks",
  MCP_TOKENS: "a, b",
  BOT_USERNAME: "@skilly_bot",
  GROUP_CHAT_ID: "-1001234",
  MENTOR_IDS: "11, 22",
  KNOWLEDGE_WHITELIST_IDS: "11",
  SUPABASE_URL: "https://x.supabase.co/",
  KAGGLE_BASE_URL: "https://kaggle.example.com/",
};

describe("parseConfig", () => {
  it("parses a valid env with defaults", () => {
    const c = parseConfig(base);
    expect(c.groupChatId).toBe(-1001234);
    expect(c.mentorIds).toEqual([11, 22]);
    expect(c.knowledgeWhitelistIds).toEqual([11]);
    expect(c.mcpTokens).toEqual(["a", "b"]);
    expect(c.botUsername).toBe("skilly_bot");
    expect(c.supabaseUrl).toBe("https://x.supabase.co");
    expect(c.maxAnswerChars).toBe(1000);
    expect(c.sessionTtlHours).toBe(24);
    expect(c.heartbeatMaxAgeS).toBe(90);
  });

  it("rejects a missing required var", () => {
    expect(() => parseConfig({ ...base, TELEGRAM_BOT_TOKEN: "" })).toThrow(ConfigError);
  });

  it("rejects malformed ID lists", () => {
    expect(() => parseConfig({ ...base, MENTOR_IDS: "11, abc" })).toThrow(/integer/);
    expect(() => parseConfig({ ...base, MENTOR_IDS: " , " })).toThrow(/at least one/);
  });

  it("allows an empty whitelist and rejects out-of-range numbers", () => {
    expect(parseConfig({ ...base, KNOWLEDGE_WHITELIST_IDS: "" }).knowledgeWhitelistIds).toEqual([]);
    expect(() => parseConfig({ ...base, RETRIEVAL_THRESHOLD: "1.5" })).toThrow(ConfigError);
  });
});
