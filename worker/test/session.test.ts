import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/config";
import { setDepsOverride } from "../src/deps";
import { FEEDBACK_THANKS } from "../src/memory/session";
import { lastUser } from "./fakes/fake-llm";
import { callback, dm, groupAsk, learner, reaction } from "./fakes/fake-telegram";
import { makeHarness, type Harness } from "./fakes/harness";

let h: Harness;
let n = 600;
let ani: ReturnType<typeof learner>;

beforeEach(async () => {
  h = makeHarness();
  ani = learner(n++, "Ani"); // fresh learner (and Durable Object) per test
  await h.seed("Mastering the Art of Prompting", "Prompt yang baik harus jelas dan spesifik. Few-shot prompting memberi contoh agar model paham pola.");
});
afterEach(() => setDepsOverride(null));

async function askFirst() {
  await h.send(groupAsk("#askAI apa itu few-shot prompting?", { from: ani }));
  await h.drain(ani.id);
  return h.repo.sessions.find((s) => s.learnerId === ani.id)!;
}

describe("session memory (AC 15)", () => {
  it("answers a DM follow-up with the previous turns in the prompt, in the same session", async () => {
    const s = await askFirst();
    h.kaggle.script = (req) => (lastUser(req).includes("lebih sederhana") ? "Versi sederhana: kasih contoh dulu, ya kamu." : "Few-shot prompting memberi contoh.");
    await h.send(dm("jelaskan lebih sederhana, dong prompting nya", { from: ani }));
    await h.drain(ani.id);

    const followReq = h.kaggle.requests.at(-1)!;
    const history = followReq.messages.filter((m) => m.role === "assistant").map((m) => m.content);
    expect(history.join(" ")).toContain("prompt yang baik");
    expect(h.repo.sessions.filter((x) => x.learnerId === ani.id)).toHaveLength(1);
    expect(h.repo.turns.filter((t) => t.sessionId === s.id)).toHaveLength(4);
    expect(h.tg.textsIn(ani.id).at(-1)).toContain("Versi sederhana");
  });
});

describe("feedback closes the session (AC 16)", () => {
  it("via the 👍 button", async () => {
    const s = await askFirst();
    await h.send(callback("fb:up", ani));
    await h.drain(ani.id);
    expect(s.status).toBe("closed_feedback");
    expect(h.repo.feedback.at(-1)).toMatchObject({ sessionId: s.id, kind: "button", value: "up" });
    expect(h.tg.sent("answerCallbackQuery")).toHaveLength(1);
    expect(h.tg.textsIn(ani.id).at(-1)).toBe(FEEDBACK_THANKS);
  });

  it("via a ✅ reaction", async () => {
    const s = await askFirst();
    await h.send(reaction("✅", ani));
    await h.drain(ani.id);
    expect(s.status).toBe("closed_feedback");
    expect(h.repo.feedback.at(-1)).toMatchObject({ kind: "reaction", value: "✅" });
  });

  it("via a text reply to the bot's message — but a plain DM is a follow-up, not feedback", async () => {
    const s = await askFirst();
    await h.send(dm("oke kak, jelas banget makasih", { from: ani, replyTo: 1000 }));
    await h.drain(ani.id);
    expect(s.status).toBe("closed_feedback");
    expect(h.repo.feedback.at(-1)).toMatchObject({ kind: "text", value: "oke kak, jelas banget makasih" });
  });
});

describe("24 h TTL (AC 16)", () => {
  it("expires the session when the alarm fires after 24 h of inactivity, not before", async () => {
    const s = await askFirst();
    const ns = (env as unknown as Env).LEARNER_SESSION;
    const stub = ns.get(ns.idFromName(String(ani.id)));

    await runDurableObjectAlarm(stub); // TTL alarm fires early: still within 24 h
    expect(s.status).toBe("open");

    s.lastActivityAt = new Date(Date.now() - 25 * 3600_000);
    await runDurableObjectAlarm(stub);
    expect(s.status).toBe("expired");
  });
});
