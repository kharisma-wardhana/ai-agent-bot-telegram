import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDepsOverride } from "../src/deps";
import { LEARNER_FALLBACK_DM } from "../src/pipeline/ask-pipeline";
import { FALLBACK_TOPIC_TEXT } from "../src/rag/grounding";
import { STAGES } from "../src/telegram/progress";
import { GROUP_ID, dm, groupAsk, learner } from "./fakes/fake-telegram";
import { makeHarness, MENTORS, type Harness } from "./fakes/harness";

let h: Harness;
const ani = learner(501, "Ani");

beforeEach(async () => {
  h = makeHarness();
  await h.seed("Mastering the Art of Prompting", "Prompt yang baik harus jelas dan spesifik. Gunakan contoh few-shot prompting agar model paham pola.");
});
afterEach(() => setDepsOverride(null));

describe("webhook auth (AC 19)", () => {
  it("rejects a missing or wrong secret-token header with 401 and does nothing", async () => {
    expect((await h.send(groupAsk("#askAI apa itu prompt?"), "wrong")).status).toBe(401);
    expect((await h.send(groupAsk("#askAI apa itu prompt?"), "")).status).toBe(401);
    expect(h.tg.calls).toHaveLength(0);
  });
});

describe("#askAI → DM answer (AC 1, 2, 3)", () => {
  it("ignores group messages without #askAI: no DM, no topic reply, no session", async () => {
    const res = await h.send(groupAsk("prompt yang baik itu gimana ya", { from: ani }));
    expect(res.status).toBe(200);
    await h.drain(ani.id);
    expect(h.tg.calls).toHaveLength(0);
    expect(h.repo.sessions).toHaveLength(0);
  });

  it("answers by DM with progress stages, feedback buttons and sources; nothing in the topic", async () => {
    expect((await h.send(groupAsk("#askAI bagaimana prompt yang baik dan spesifik?", { from: ani }))).status).toBe(200);
    await h.drain(ani.id);

    expect(h.tg.textsIn(GROUP_ID)).toEqual([]);
    const dmTexts = h.tg.textsIn(ani.id);
    expect(dmTexts[0]).toBe(STAGES.received);
    const joined = dmTexts.join("\n---\n");
    expect(joined.indexOf(STAGES.searching)).toBeGreaterThan(-1);
    expect(joined.indexOf(STAGES.composing)).toBeGreaterThan(joined.indexOf(STAGES.searching));
    const final = dmTexts.at(-1)!;
    expect(final).toContain("prompt yang baik");
    expect(final).toContain("📚 Sumber: Mastering the Art of Prompting");
    expect(final.length).toBeLessThanOrEqual(1000);
    const lastEdit = h.tg.sent("editMessageText").at(-1)!;
    expect(lastEdit.params.reply_markup).toBeTruthy();

    const assistant = h.repo.turns.filter((t) => t.role === "assistant");
    expect(assistant[0]).toMatchObject({ answerSource: "lesson_docs", backend: "kaggle", sources: ["Mastering the Art of Prompting"] });
  });

  it("never streams a NOT_FOUND reply to the learner", async () => {
    h.kaggle.script = () => "NOT_FOUND";
    await h.send(groupAsk("#askAI prompt yang baik itu apa?", { from: ani }));
    await h.drain(ani.id);
    expect(h.tg.textsIn(ani.id).some((t) => t.includes("NOT_FOUND"))).toBe(false);
  });
});

describe("mentor fallback (AC 9)", () => {
  it("posts the exact text in the topic as a reply, DMs every mentor, records the follow-up", async () => {
    const upd = groupAsk("#askAI resep rendang padang yang enak gimana?", { from: ani, thread: 55 });
    await h.send(upd);
    await h.drain(ani.id);

    const topic = h.tg.sent("sendMessage").filter((c) => c.params.chat_id === GROUP_ID);
    expect(topic).toHaveLength(1);
    expect(topic[0]!.params.text).toBe(FALLBACK_TOPIC_TEXT);
    expect(topic[0]!.params.message_thread_id).toBe(55);
    expect((topic[0]!.params.reply_parameters as { message_id: number }).message_id).toBe(upd.message!.message_id);

    for (const m of MENTORS) {
      const t = h.tg.textsIn(m).join("\n");
      expect(t).toContain("resep rendang padang");
      expect(t).toContain(`https://t.me/c/1234567890/${upd.message!.message_id}?thread=55`);
    }
    expect(h.repo.followups).toHaveLength(1);
    expect(h.repo.followups[0]!.mentorIds).toEqual(MENTORS);
    expect(h.tg.textsIn(ani.id).at(-1)).toBe(LEARNER_FALLBACK_DM);
    expect(h.repo.turns.find((t) => t.role === "assistant")!.answerSource).toBe("fallback");
  });

  it("also falls back when retrieval matches but the model says NOT_FOUND", async () => {
    h.kaggle.script = () => "NOT_FOUND";
    await h.send(groupAsk("#askAI prompt few-shot itu apa?", { from: ani }));
    await h.drain(ani.id);
    expect(h.tg.textsIn(GROUP_ID)).toEqual([FALLBACK_TOPIC_TEXT]);
  });
});

describe("learner who never started the bot (AC 12)", () => {
  it("gets a deep link in the topic, then the held answer right after /start", async () => {
    h.tg.notStarted.add(ani.id);
    await h.send(groupAsk("#askAI bagaimana prompt yang baik dan spesifik?", { from: ani }));
    await h.drain(ani.id);

    const notice = h.tg.textsIn(GROUP_ID);
    expect(notice).toHaveLength(1);
    const link = /https:\/\/t\.me\/skilly_test_bot\?start=(q_[0-9a-f-]+)/.exec(notice[0]!);
    expect(link).not.toBeNull();
    expect(h.repo.pending).toHaveLength(1);

    h.tg.notStarted.delete(ani.id);
    const t0 = Date.now();
    await h.send(dm(`/start ${link![1]}`, { from: ani }));
    await h.drain(ani.id);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const delivered = h.tg.textsIn(ani.id).at(-1)!;
    expect(delivered).toContain("📚 Sumber: Mastering the Art of Prompting");
    expect(h.repo.learners.get(ani.id)!.hasStarted).toBe(true);
  });
});

describe("persona identity (AC 21)", () => {
  it("answers 'kamu siapa?' as Kak Skilly without a mentor fallback", async () => {
    await h.send(groupAsk("#askAI kamu siapa?", { from: ani }));
    await h.drain(ani.id);
    expect(h.tg.textsIn(ani.id).at(-1)).toContain("Kak Skilly");
    expect(h.tg.textsIn(GROUP_ID)).toEqual([]);
    expect(h.repo.followups).toHaveLength(0);
  });
});
