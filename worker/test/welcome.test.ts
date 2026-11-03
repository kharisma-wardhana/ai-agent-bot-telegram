import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDepsOverride } from "../src/deps";
import { runScheduled } from "../src/index";
import { TelegramClient } from "../src/telegram/client";
import { BATCH_SIZE, DEFAULT_TEMPLATE, renderWelcome } from "../src/welcome/welcome";
import { BOT, chatMember, GROUP_ID, learner } from "./fakes/fake-telegram";
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

// ---------- The cron job (step 5) ----------
const citra = learner(503, "Citra");
const groupSends = () => h.tg.sent("sendMessage").filter((c) => Number(c.params.chat_id) === GROUP_ID);
type Ent = { type: string; offset: number; length: number; user: { id: number } };

describe("posting the waiting newcomers (AC 3, 8)", () => {
  it("sends exactly one plain-text message with the default template and one mention per newcomer, then nothing", async () => {
    for (const p of [ani, budi, citra]) await h.send(chatMember(p, "left", "member"));
    await runScheduled(h.deps.env);

    const sends = groupSends();
    expect(sends).toHaveLength(1);
    const p = sends[0]!.params;
    const text = String(p.text);
    expect(text.startsWith("Halo Ani, Budi, dan Citra! 👋")).toBe(true);
    expect(text).toContain(`Tekan Start di @${BOT}`);
    expect(text).toContain("#askAI");
    expect(p.parse_mode).toBeUndefined();
    expect(p.message_thread_id).toBeUndefined();
    const ents = p.entities as Ent[];
    expect(ents.map((e) => [e.type, text.slice(e.offset, e.offset + e.length), e.user.id])).toEqual([
      ["text_mention", "Ani", ani.id], ["text_mention", "Budi", budi.id], ["text_mention", "Citra", citra.id],
    ]);
    expect(h.repo.pendingWelcomes).toHaveLength(0);

    h.tg.calls = [];
    await runScheduled(h.deps.env);
    expect(groupSends()).toHaveLength(0);
  });

  it("uses the saved template and topic", async () => {
    await h.repo.saveWelcomeSettings({ template: "Selamat datang {nama} 🎉 — DM {bot} ya", topicId: 77, welcomeEnabled: true, leaveEnabled: true, updatedBy: OWNER.email });
    await h.send(chatMember(ani, "left", "member"));
    await runScheduled(h.deps.env);
    const p = groupSends()[0]!.params;
    expect(p.text).toBe(`Selamat datang Ani 🎉 — DM @${BOT} ya`);
    expect(p.message_thread_id).toBe(77);
    expect((p.entities as Ent[])[0]).toMatchObject({ offset: "Selamat datang ".length, length: 3 });
  });

  it("joins two names with 'dan', and computes offsets in UTF-16 units after emoji", () => {
    const r = renderWelcome("🎉🎉 {nama}!", [{ id: 1, name: "Ani" }, { id: 2, name: "Budi" }], "bot");
    expect(r.text).toBe("🎉🎉 Ani dan Budi!");
    expect(r.entities.map((e) => r.text.slice(e.offset, e.offset + e.length))).toEqual(["Ani", "Budi"]);
    expect(DEFAULT_TEMPLATE).toContain("{nama}");
    expect(DEFAULT_TEMPLATE).toContain("{bot}");
  });
});

describe("splitting large batches (AC 4)", () => {
  it("posts 51 newcomers as two messages: 50 + 1", async () => {
    for (let i = 0; i < 51; i++) await h.repo.queueWelcome(10_000 + i, `Peserta ${i}`);
    await runScheduled(h.deps.env);
    const sends = groupSends();
    expect(sends).toHaveLength(2);
    expect((sends[0]!.params.entities as Ent[])).toHaveLength(BATCH_SIZE);
    expect((sends[1]!.params.entities as Ent[])).toHaveLength(1);
  });
});

describe("rejoins and duplicates (AC 5)", () => {
  it("one mention for a duplicate join; a rejoin after a welcome is welcomed again", async () => {
    await h.send(chatMember(ani, "left", "member"));
    await h.send(chatMember(ani, "left", "member"));
    await runScheduled(h.deps.env);
    expect((groupSends()[0]!.params.entities as Ent[])).toHaveLength(1);

    await h.send(chatMember(ani, "member", "left"));
    await h.send(chatMember(ani, "left", "member"));
    h.tg.calls = [];
    await runScheduled(h.deps.env);
    expect(groupSends()).toHaveLength(1);
  });
});

describe("switches and failures (AC 7, 11, 15)", () => {
  it("with welcomes switched off, waiting rows are dropped and nothing is posted", async () => {
    await h.send(chatMember(ani, "left", "member"));
    await h.repo.saveWelcomeSettings({ template: "Hai {nama}", topicId: null, welcomeEnabled: false, leaveEnabled: true, updatedBy: OWNER.email });
    await runScheduled(h.deps.env);
    expect(groupSends()).toHaveLength(0);
    expect(h.repo.pendingWelcomes).toHaveLength(0);
  });

  it("sends an admin template containing markup verbatim, as plain text", async () => {
    const tpl = `<b>Halo</b> {nama} <script>alert(1)</script> *tebal* _miring_`;
    await h.repo.saveWelcomeSettings({ template: tpl, topicId: null, welcomeEnabled: true, leaveEnabled: true, updatedBy: OWNER.email });
    await h.send(chatMember(ani, "left", "member"));
    await runScheduled(h.deps.env);
    const p = groupSends()[0]!.params;
    expect(p.text).toBe(tpl.replace("{nama}", "Ani"));
    expect(p.parse_mode).toBeUndefined();
  });

  it("puts a batch back when Telegram refuses the post", async () => {
    await h.send(chatMember(ani, "left", "member"));
    const failGroup: typeof fetch = async (input, init) => {
      const params = init?.body ? JSON.parse(String(init.body)) : {};
      if (Number(params.chat_id) === GROUP_ID) return Response.json({ ok: false, error_code: 400, description: "Bad Request: message thread not found" });
      return h.tg.fetch(input, init);
    };
    h.deps.tg = new TelegramClient("123:TOKEN", failGroup);
    await runScheduled(h.deps.env);
    expect(h.repo.pendingWelcomes.map((p) => p.telegramId)).toEqual([ani.id]);
  });

  it("a throwing welcome job doesn't stop the other cron jobs", async () => {
    h.repo.takePendingWelcomes = async () => { throw new Error("db down"); };
    let expired = false;
    const orig = h.repo.expireSessions.bind(h.repo);
    h.repo.expireSessions = async (ttl: number) => { expired = true; return orig(ttl); };
    await runScheduled(h.deps.env);
    expect(expired).toBe(true);
  });
});
