import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEARNER_DM_HEADER } from "../src/dashboard/followups";
import { setDepsOverride } from "../src/deps";
import { TelegramClient } from "../src/telegram/client";
import { dm, GROUP_ID, learner } from "./fakes/fake-telegram";
import { makeHarness, OWNER, type DashSession, type Harness } from "./fakes/harness";

// docs/mentor-followup-dashboard/spec.md AC 11 (non-claimer), 12, 13, 14, 15 at the HTTP entry point.

let h: Harness;
let owner: DashSession;
const ani = learner(501, "Ani");

async function claimed(q: string, o: { started?: boolean; viaDm?: boolean } = {}): Promise<number> {
  await h.repo.upsertLearner({ telegramId: ani.id, displayName: "Ani", username: "ani", started: o.started ?? true });
  const s = await h.repo.openSession({ learnerId: ani.id, chatId: o.viaDm ? null : GROUP_ID, threadId: o.viaDm ? null : 55, messageId: o.viaDm ? null : 4242 });
  const id = await h.repo.addFollowupV2(s, q, [111], null);
  await h.dash(`/dashboard/followups/${id}/claim`, { form: { csrf: owner.csrf }, session: owner });
  h.tg.calls = [];
  return id;
}

const reply = (id: number, text: string, s = owner) => h.dash(`/dashboard/followups/${id}/reply`, { form: { csrf: s.csrf, reply: text }, session: s });
const sentTo = (chat: number) => h.tg.sent("sendMessage").filter((c) => Number(c.params.chat_id) === chat);

beforeEach(async () => {
  h = makeHarness();
  owner = await h.login(OWNER.email, OWNER.telegramId);
});
afterEach(() => setDepsOverride(null));

describe("delivering a reply (AC 12)", () => {
  it("DMs the learner (header + question + reply, ≤ 1000 chars), posts in the topic with a mention, and closes", async () => {
    const id = await claimed("Apa bedanya RAG dan fine-tuning?");
    const res = await reply(id, "RAG mengambil dokumen saat menjawab; fine-tuning mengubah bobot model.");
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toContain("tab=selesai&pesan=terkirim");

    const dms = sentTo(ani.id);
    expect(dms).toHaveLength(1);
    const text = String(dms[0]!.params.text);
    expect(text.startsWith(LEARNER_DM_HEADER)).toBe(true);
    expect(text).toContain("Apa bedanya RAG dan fine-tuning?");
    expect(text).toContain("RAG mengambil dokumen saat menjawab; fine-tuning mengubah bobot model.");
    expect(text.length).toBeLessThanOrEqual(1000);

    const posts = sentTo(GROUP_ID);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.params.message_thread_id).toBe(55);
    expect((posts[0]!.params.reply_parameters as { message_id: number; allow_sending_without_reply: boolean })).toEqual({ message_id: 4242, allow_sending_without_reply: true });
    expect(posts[0]!.params.parse_mode).toBeUndefined();
    const entities = posts[0]!.params.entities as { type: string; offset: number; length: number; user: { id: number } }[];
    expect(entities).toEqual([expect.objectContaining({ type: "text_mention", offset: 0, length: 3, user: expect.objectContaining({ id: ani.id }) })]);
    expect(String(posts[0]!.params.text)).toContain("RAG mengambil dokumen");

    const f = h.repo.followups[0]!;
    expect(f).toMatchObject({ status: "closed", repliedByName: "owner", dmStatus: "sent", topicStatus: "sent" });
    const closedPage = await (await h.dash("/dashboard?tab=selesai", { session: owner })).text();
    expect(closedPage).toContain("RAG mengambil dokumen");
    expect(closedPage).toContain("DM ke peserta: terkirim");
  });

  it("keeps the learner DM within 1000 characters even with a long question and a 900-char reply", async () => {
    const id = await claimed("x".repeat(800));
    await reply(id, "y".repeat(900));
    const text = String(sentTo(ani.id)[0]!.params.text);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toContain("y".repeat(900));
  });

  it("skips the topic post for a question asked by DM", async () => {
    const id = await claimed("Ditanya lewat DM", { viaDm: true });
    await reply(id, "Jawabannya begini.");
    expect(sentTo(ani.id)).toHaveLength(1);
    expect(h.repo.followups[0]!.topicStatus).toBe("skipped");
  });
});

describe("learner hasn't started the bot (AC 13)", () => {
  it("holds the reply and delivers it when the learner presses Start", async () => {
    const id = await claimed("Pertanyaan dari peserta baru", { started: false });
    const res = await reply(id, "Ini jawaban mentor.");
    expect(res.headers.get("Location")).toContain("pesan=ditahan");
    expect(sentTo(ani.id)).toHaveLength(0);
    expect(h.repo.pending.filter((p) => p.reason === "not_started" && !p.delivered)).toHaveLength(1);
    expect(h.repo.followups[0]!.dmStatus).toBe("held");

    await h.send(dm("/start", { from: ani }));
    await h.drain(ani.id);
    expect(h.tg.textsIn(ani.id).some((t) => t.startsWith(LEARNER_DM_HEADER) && t.includes("Ini jawaban mentor."))).toBe(true);
  });

  it("also holds when Telegram refuses the DM with 403", async () => {
    const id = await claimed("Pertanyaan", { started: true });
    h.tg.notStarted.add(ani.id);
    await reply(id, "Jawaban.");
    expect(h.repo.followups[0]!.dmStatus).toBe("held");
    expect(h.repo.pending).toHaveLength(1);
  });
});

describe("guards (AC 11, 14)", () => {
  it("rejects a reply over 900 characters and sends nothing", async () => {
    const id = await claimed("Pertanyaan");
    const res = await reply(id, "z".repeat(901));
    expect(res.headers.get("Location")).toContain("pesan=terlalu-panjang");
    expect(h.tg.sent("sendMessage")).toHaveLength(0);
    expect(h.repo.followups[0]!.status).toBe("claimed");
  });

  it("rejects an empty reply", async () => {
    const id = await claimed("Pertanyaan");
    expect((await reply(id, "   \n ")).headers.get("Location")).toContain("pesan=kosong");
    expect(h.tg.sent("sendMessage")).toHaveLength(0);
  });

  it("sends exactly one DM and one topic post when the same reply is submitted twice", async () => {
    const id = await claimed("Pertanyaan");
    const [a, b] = await Promise.all([reply(id, "Jawaban sama."), reply(id, "Jawaban sama.")]);
    expect([a.headers.get("Location"), b.headers.get("Location")].filter((l) => l!.includes("bukan-klaim"))).toHaveLength(1);
    expect(sentTo(ani.id)).toHaveLength(1);
    expect(sentTo(GROUP_ID)).toHaveLength(1);
  });

  it("rejects a reply from someone who isn't the live claimer, and from a claimer whose claim lapsed", async () => {
    await h.repo.addDashboardUser({ email: "m3@skilly.id", displayName: "Tiga", telegramId: 333, addedByEmail: OWNER.email });
    const m3 = await h.login("m3@skilly.id", 333);
    const id = await claimed("Pertanyaan");
    h.tg.calls = [];
    expect((await reply(id, "Bukan punyaku.", m3)).headers.get("Location")).toContain("pesan=bukan-klaim");
    h.repo.followups[0]!.claimedAt = new Date(Date.now() - 25 * 3600_000);
    expect((await reply(id, "Terlambat.")).headers.get("Location")).toContain("pesan=bukan-klaim");
    expect(h.tg.sent("sendMessage")).toHaveLength(0);
  });
});

describe("a failed topic post (AC 15)", () => {
  it("still closes the question and DMs the learner, and the dashboard shows the failure", async () => {
    const id = await claimed("Pertanyaan");
    const failGroup: typeof fetch = async (input, init) => {
      const params = init?.body ? JSON.parse(String(init.body)) : {};
      if (Number(params.chat_id) === GROUP_ID) return Response.json({ ok: false, error_code: 400, description: "Bad Request: message thread not found" });
      return h.tg.fetch(input, init);
    };
    h.deps.tg = new TelegramClient("123:TOKEN", failGroup);
    const res = await reply(id, "Jawaban.");
    expect(res.headers.get("Location")).toContain("pesan=gagal-sebagian");
    expect(h.repo.followups[0]).toMatchObject({ status: "closed", dmStatus: "sent", topicStatus: "failed" });
    expect(sentTo(ani.id)).toHaveLength(1);
    const page = await (await h.dash("/dashboard?tab=selesai&pesan=gagal-sebagian", { session: owner })).text();
    expect(page).toContain("Topik grup: GAGAL");
    expect(page).toContain("ada pengiriman yang gagal");
  });
});
