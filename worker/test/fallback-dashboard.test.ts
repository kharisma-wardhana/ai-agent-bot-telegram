import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, parseConfig, parseDashboardOwners, type Env } from "../src/config";
import { setDepsOverride } from "../src/deps";
import { runFallback } from "../src/pipeline/fallback";
import { groupAsk, learner } from "./fakes/fake-telegram";
import { DASH_BASE, makeHarness, MENTORS, type Harness } from "./fakes/harness";

// docs/mentor-followup-dashboard/spec.md AC 18 (fallback recipients + link) and AC 8 (new follow-ups are listed).

let h: Harness;
const ani = learner(501, "Ani");

beforeEach(async () => {
  h = makeHarness();
  await h.seed("Mastering the Art of Prompting", "Prompt yang baik harus jelas dan spesifik.");
});
afterEach(() => setDepsOverride(null));

describe("fallback DMs MENTOR_IDS ∪ dashboard users, once each, with a dashboard link (AC 18)", () => {
  it("adds an active dashboard user, de-duplicates the owner who is also a mentor, and links the follow-up", async () => {
    await h.repo.addDashboardUser({ email: "mentor3@skilly.id", displayName: "Tiga", telegramId: 333, addedByEmail: "owner@skilly.id" });
    await h.send(groupAsk("#askAI resep rendang padang yang enak gimana?", { from: ani, thread: 55 }));
    await h.drain(ani.id);

    const recipients = [...MENTORS, 333];
    for (const m of recipients) {
      const dms = h.tg.sent("sendMessage").filter((c) => c.params.chat_id === m);
      expect(dms).toHaveLength(1);
      expect(String(dms[0]!.params.text)).toContain(`Jawab lewat dashboard: ${DASH_BASE}/dashboard#f-${h.repo.followups[0]!.id}`);
    }
    expect(h.repo.followups[0]!.mentorIds).toEqual(recipients);
  });

  it("stops DMing a removed dashboard user", async () => {
    const id = await h.repo.addDashboardUser({ email: "m3@skilly.id", displayName: "Tiga", telegramId: 333, addedByEmail: "o" });
    await h.repo.removeDashboardUser(id!);
    await h.send(groupAsk("#askAI resep rendang padang yang enak gimana?", { from: ani }));
    await h.drain(ani.id);
    expect(h.tg.sent("sendMessage").filter((c) => c.params.chat_id === 333)).toHaveLength(0);
  });

  it("stores the photo file reference and lists the new follow-up on the dashboard (AC 8)", async () => {
    await h.repo.upsertLearner({ telegramId: ani.id, displayName: "Ani", username: "ani", started: true });
    const sessionId = await h.repo.openSession({ learnerId: ani.id, chatId: -1001234567890, threadId: 9, messageId: 77 });
    await runFallback(h.deps, { chatId: null, threadId: 9, messageId: 77, from: ani, question: "gambar ini apa?", sessionId, photoFileId: "PHOTO-1" });

    expect(await h.repo.followupPhoto(h.repo.followups[0]!.id)).toBe("PHOTO-1");
    const [view] = await h.repo.listFollowups("active", 86400);
    expect(view).toMatchObject({ question: "gambar ini apa?", hasPhoto: true, status: "open", threadId: 9 });
  });

  it("still DMs the mentors when the follow-up record can't be written", async () => {
    h.repo.addFollowupV2 = async () => { throw new Error("db down"); };
    await h.send(groupAsk("#askAI resep rendang padang yang enak gimana?", { from: ani }));
    await h.drain(ani.id);
    for (const m of MENTORS) {
      const t = h.tg.textsIn(m).join("\n");
      expect(t).toContain("resep rendang");
      expect(t).not.toContain("dashboard");
    }
  });
});

describe("dashboard config", () => {
  it("parses owners and the base URL, and rejects malformed values", () => {
    expect(parseDashboardOwners(" A@X.id:111 , b@y.co.id:222 ")).toEqual([
      { email: "a@x.id", telegramId: 111, displayName: "a" },
      { email: "b@y.co.id", telegramId: 222, displayName: "b" },
    ]);
    expect(parseDashboardOwners(undefined)).toEqual([]);
    expect(() => parseDashboardOwners("not-an-email:1")).toThrow(ConfigError);
    expect(() => parseDashboardOwners("a@x.id:abc")).toThrow(ConfigError);

    const env = { ...h.deps.env } as Env;
    expect(parseConfig({ ...env, DASHBOARD_BASE_URL: "https://bot.example.com/" }).dashboardBaseUrl).toBe("https://bot.example.com");
    expect(parseConfig({ ...env, DASHBOARD_BASE_URL: "" }).dashboardBaseUrl).toBeNull();
    expect(() => parseConfig({ ...env, DASHBOARD_BASE_URL: "http://bot.example.com" })).toThrow(ConfigError);
    expect(() => parseConfig({ ...env, DASHBOARD_BASE_URL: "https://bot.example.com/dashboard" })).toThrow(ConfigError);
  });
});
