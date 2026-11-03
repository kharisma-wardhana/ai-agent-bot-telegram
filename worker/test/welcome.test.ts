import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDepsOverride } from "../src/deps";
import { chatMember, GROUP_ID, learner } from "./fakes/fake-telegram";
import { makeHarness, MENTORS, OWNER, type Harness } from "./fakes/harness";

// docs/cohort-welcome-message/spec.md at the real entry points: POST /telegram/webhook and runScheduled().

let h: Harness;
const ani = learner(501, "Ani");
const budi = learner(502, "Budi");
const MENTOR3 = 333;

beforeEach(async () => {
  h = makeHarness();
  await h.repo.addDashboardUser({ email: "m3@skilly.id", displayName: "Tiga", telegramId: MENTOR3, addedByEmail: OWNER.email });
});
afterEach(() => setDepsOverride(null));

describe("joins are queued, not posted (AC 1, 2)", () => {
  it("queues a non-bot join in the cohort group and sends nothing during the webhook request", async () => {
    const res = await h.send(chatMember(ani, "left", "member"));
    expect(res.status).toBe(200);
    expect(h.repo.pendingWelcomes.map((p) => [p.telegramId, p.displayName])).toEqual([[ani.id, "Ani"]]);
    expect(h.tg.calls).toHaveLength(0);
  });

  it("ignores bots and other chats", async () => {
    await h.send(chatMember({ ...learner(900, "Bot"), is_bot: true }, "left", "member"));
    await h.send(chatMember(ani, "left", "member", { chatId: -1009999 }));
    await h.send(chatMember(ani, "member", "left", { chatId: -1009999 }));
    expect(h.repo.pendingWelcomes).toHaveLength(0);
    expect(h.tg.calls).toHaveLength(0);
  });

  it("still requires the webhook secret", async () => {
    expect((await h.send(chatMember(ani, "left", "member"), "wrong")).status).toBe(401);
    expect(h.repo.pendingWelcomes).toHaveLength(0);
  });
});

describe("leave notices (AC 5, 6)", () => {
  it("DMs every dashboard user exactly once, nothing to the group or to MENTOR_IDS-only users", async () => {
    await h.send(chatMember(ani, "member", "left"));
    const sends = h.tg.sent("sendMessage");
    const to = sends.map((c) => Number(c.params.chat_id)).sort();
    expect(to).toEqual([OWNER.telegramId, MENTOR3].sort());
    expect(to).not.toContain(GROUP_ID);
    const mentorOnly = MENTORS.filter((m) => m !== OWNER.telegramId);
    for (const m of mentorOnly) expect(to).not.toContain(m);
    expect(String(sends[0]!.params.text)).toBe("👋 Ani (@ani) keluar dari grup cohort.");
  });

  it("says 'dikeluarkan' when the member was removed", async () => {
    await h.send(chatMember(ani, "member", "kicked"));
    expect(h.tg.textsIn(OWNER.telegramId)).toEqual(["👋 Ani (@ani) dikeluarkan dari grup cohort."]);
  });

  it("drops a pending welcome when the newcomer leaves before it is posted", async () => {
    await h.send(chatMember(ani, "left", "member"));
    await h.send(chatMember(budi, "left", "member"));
    await h.send(chatMember(ani, "member", "left"));
    expect(h.repo.pendingWelcomes.map((p) => p.telegramId)).toEqual([budi.id]);
    expect(h.tg.textsIn(OWNER.telegramId)).toHaveLength(1);
  });

  it("a removed dashboard user no longer gets leave notices", async () => {
    await h.repo.removeDashboardUser(h.repo.dashboardUsers[0]!.id);
    await h.send(chatMember(ani, "member", "left"));
    expect(h.tg.textsIn(MENTOR3)).toHaveLength(0);
  });
});

describe("switches (AC 7)", () => {
  it("welcomes off: a join is not queued; leave notices off: a leave sends nothing", async () => {
    await h.repo.saveWelcomeSettings({ template: "Hai {nama}", topicId: null, welcomeEnabled: false, leaveEnabled: false, updatedBy: OWNER.email });
    await h.send(chatMember(ani, "left", "member"));
    await h.send(chatMember(budi, "member", "left"));
    expect(h.repo.pendingWelcomes).toHaveLength(0);
    expect(h.tg.calls).toHaveLength(0);
  });
});
