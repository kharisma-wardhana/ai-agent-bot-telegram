import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/config";
import { setDepsOverride } from "../src/deps";
import { runScheduled } from "../src/index";
import { AUDIO_FAILED_MSG, IMAGE_DEFERRED_MSG } from "../src/media/image";
import { STAGES } from "../src/telegram/progress";
import { GROUP_ID, groupAsk, learner } from "./fakes/fake-telegram";
import { makeHarness, type Harness } from "./fakes/harness";

let h: Harness;
let n = 800;
let ani: ReturnType<typeof learner>;
const bucketKeys = async () => (await (env as unknown as Env).KNOWLEDGE_BUCKET.list()).objects.map((o) => o.key);

beforeEach(async () => {
  h = makeHarness();
  ani = learner(n++, "Ani");
  await h.seed("Mastering the Art of Prompting", "Prompt yang baik harus jelas dan spesifik. Few-shot prompting memberi contoh agar model paham pola.");
  h.tg.files.set("files/vc1", new Uint8Array([79, 103, 103, 83, 0, 1, 2, 3])); // "OggS…"
  h.tg.files.set("files/ph_big", new Uint8Array([255, 216, 255, 224, 0, 16]));
});
afterEach(() => setDepsOverride(null));

describe("voice questions (AC 10)", () => {
  it("transcribes, shows the transcription stage, answers in text and persists no audio", async () => {
    const r2Before = await bucketKeys();
    await h.send(groupAsk("#askAI", { from: ani, voice: true }));
    await h.drain(ani.id);

    expect(h.transcriber.calls).toBe(1);
    const dmTexts = h.tg.textsIn(ani.id);
    expect(dmTexts.some((t) => t.includes(STAGES.transcribing))).toBe(true);
    expect(h.tg.lastAnswer(ani.id)).toContain("📚 Sumber: Mastering the Art of Prompting");
    const userTurn = h.repo.turns.find((t) => t.role === "user")!;
    expect(userTurn).toMatchObject({ questionKind: "voice", content: "apa itu few-shot prompting" });
    expect(await bucketKeys()).toEqual(r2Before);
    expect(JSON.stringify(h.repo.turns)).not.toContain("OggS");
  });

  it("tells the learner when the audio can't be understood", async () => {
    h.transcriber.text = "";
    await h.send(groupAsk("#askAI", { from: ani, voice: true }));
    await h.drain(ani.id);
    expect(h.tg.lastAnswer(ani.id)).toBe(AUDIO_FAILED_MSG);
    expect(h.repo.followups).toHaveLength(0);
  });
});

describe("photo questions (AC 11)", () => {
  it("with Kaggle online: sends the image to the vision model and answers in text", async () => {
    await h.send(groupAsk("#askAI ini contoh few-shot prompting bukan?", { from: ani, photo: true }));
    await h.drain(ani.id);

    const req = h.kaggle.requests.at(-1)!;
    const user = req.messages.at(-1)!;
    expect(Array.isArray(user.content)).toBe(true);
    const img = (user.content as { type: string; image_url?: { url: string } }[]).find((p) => p.type === "image_url")!;
    expect(img.image_url!.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(h.tg.textsIn(ani.id).some((t) => t.includes(STAGES.reading_image))).toBe(true);
    expect(h.tg.lastAnswer(ani.id)).toContain("prompt yang baik");
    expect(h.repo.turns.find((t) => t.role === "user")!.questionKind).toBe("photo");
    expect(JSON.stringify(h.repo.turns)).not.toContain("base64");
  });

  it("with Kaggle offline: tells the learner it's delayed, then answers once Kaggle is back", async () => {
    h.repo.heartbeatAge = null;
    await h.send(groupAsk("#askAI ini contoh few-shot prompting bukan?", { from: ani, photo: true }));
    await h.drain(ani.id);
    expect(h.tg.lastAnswer(ani.id)).toBe(IMAGE_DEFERRED_MSG);
    expect(h.kaggle.requests).toHaveLength(0);
    expect(h.workersAi.requests).toHaveLength(0); // images are never downgraded to the text model
    expect(h.repo.pending.filter((p) => p.reason === "image_deferred" && !p.delivered)).toHaveLength(1);
    expect(JSON.stringify(h.repo.pending)).not.toContain("base64");

    await runScheduled(h.deps.env); // still offline: nothing happens
    await h.drain(ani.id);
    expect(h.kaggle.requests).toHaveLength(0);

    h.repo.heartbeatAge = 3; // Kaggle back
    await runScheduled(h.deps.env);
    await h.drain(ani.id);
    expect(h.kaggle.requests).toHaveLength(1);
    expect(h.tg.lastAnswer(ani.id)).toContain("prompt yang baik");
    expect(h.tg.textsIn(GROUP_ID)).toEqual([]);
  });
});
