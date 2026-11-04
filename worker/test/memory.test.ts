import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRIVACY_NOTICE } from "../src/answer/persona";
import { setDepsOverride } from "../src/deps";
import { runScheduled } from "../src/index";
import { EXTRACTION_MARKER, parseExtraction, WEIGHT_EXPIRED, WEIGHT_FEEDBACK } from "../src/memory/graph-extractor";
import { HAPUSDATA_DONE } from "../src/pipeline/ask-pipeline";
import { lastUser } from "./fakes/fake-llm";
import { callback, dm, groupAsk, learner } from "./fakes/fake-telegram";
import { groundedScript, makeHarness, type Harness } from "./fakes/harness";

let h: Harness;
let n = 900;
let ani: ReturnType<typeof learner>;
const EXTRACTED = JSON.stringify({
  nodes: [{ kind: "concept", label: "few-shot prompting" }, { kind: "difficulty", label: "contoh prompt" }, { kind: "preference", label: "suka contoh kode" }],
  edges: [{ from: { kind: "difficulty", label: "contoh prompt" }, relation: "bingung tentang", to: { kind: "concept", label: "few-shot prompting" } }],
});

beforeEach(async () => {
  h = makeHarness();
  ani = learner(n++, "Ani");
  await h.seed("Mastering the Art of Prompting", "Prompt yang baik harus jelas dan spesifik. Few-shot prompting memberi contoh agar model paham pola.");
  h.kaggle.script = (req) => (String(req.messages[0]?.content).includes(EXTRACTION_MARKER) ? `Berikut JSON:\n${EXTRACTED}` : groundedScript(req));
});
afterEach(() => setDepsOverride(null));

async function askAndClose(close: "feedback" | "expire") {
  await h.send(groupAsk("#askAI apa itu few-shot prompting?", { from: ani }));
  await h.drain(ani.id);
  const s = h.repo.sessions.find((x) => x.learnerId === ani.id)!;
  if (close === "feedback") {
    await h.send(callback("fb:up", ani));
    await h.drain(ani.id);
  } else {
    s.lastActivityAt = new Date(Date.now() - 25 * 3600_000);
  }
  return s;
}

describe("long-term graph memory (AC 16)", () => {
  it("one cron run turns a feedback-closed session into weighted nodes and edges", async () => {
    const s = await askAndClose("feedback");
    await runScheduled(h.deps.env);
    const nodes = h.repo.memoryNodes.filter((m) => m.learnerId === ani.id);
    expect(nodes.map((m) => [m.kind, m.label, m.weight])).toEqual([
      ["concept", "few-shot prompting", WEIGHT_FEEDBACK], ["difficulty", "contoh prompt", WEIGHT_FEEDBACK], ["preference", "suka contoh kode", WEIGHT_FEEDBACK],
    ]);
    expect(nodes.every((m) => m.embedding?.length === 1024)).toBe(true);
    expect(h.repo.memoryEdges.filter((e) => e.learnerId === ani.id).map((e) => e.relation)).toEqual(["bingung_tentang"]);
    expect(s.memory).toBe("done");
  });

  it("an expired session (no feedback) is expired by the cron and saved at lower weight", async () => {
    const s = await askAndClose("expire");
    await runScheduled(h.deps.env);
    expect(s.status).toBe("expired");
    expect(h.repo.memoryNodes.filter((m) => m.learnerId === ani.id).every((m) => m.weight === WEIGHT_EXPIRED)).toBe(true);
  });

  it("recalled memory reaches a later answer's prompt as <memori>, never as documents", async () => {
    await askAndClose("feedback");
    await runScheduled(h.deps.env);
    await h.send(groupAsk("#askAI contoh few-shot prompting yang baik?", { from: ani }));
    await h.drain(ani.id);
    const u = lastUser(h.kaggle.requests.at(-1)!);
    expect(u).toContain("<memori>");
    expect(u).toMatch(/pernah bertanya tentang "few-shot prompting"/);
    expect(u.indexOf("<memori>")).toBeGreaterThan(u.indexOf("</dokumen>"));
  });

  it("leaves the session pending (retried next run) when the model is down", async () => {
    const s = await askAndClose("feedback");
    h.kaggle.fail = true;
    h.workersAi.fail = true;
    await runScheduled(h.deps.env);
    expect(s.memory).toBe("pending");
    h.kaggle.fail = false;
    h.workersAi.fail = false;
    await runScheduled(h.deps.env);
    expect(s.memory).toBe("done");
  });
});

describe("parseExtraction", () => {
  it("drops invalid kinds, dangling edges and malformed JSON", () => {
    expect(parseExtraction("bukan json")).toEqual({ nodes: [], edges: [] });
    const p = parseExtraction(JSON.stringify({
      nodes: [{ kind: "concept", label: "RAG" }, { kind: "secret", label: "x" }, { kind: "concept", label: "rag" }],
      edges: [{ from: { kind: "concept", label: "rag" }, relation: "x", to: { kind: "concept", label: "tidak ada" } }],
    }));
    expect(p).toEqual({ nodes: [{ kind: "concept", label: "rag" }], edges: [] });
  });
});

describe("/hapusdata (AC 17) and privacy notice", () => {
  it("deletes only the caller's sessions, turns, feedback and memory", async () => {
    const budi = learner(n++, "Budi");
    await askAndClose("feedback");
    await h.send(groupAsk("#askAI apa itu few-shot prompting?", { from: budi }));
    await h.drain(budi.id);
    await runScheduled(h.deps.env);
    expect(h.repo.memoryNodes.some((m) => m.learnerId === ani.id)).toBe(true);

    await h.send(dm("/hapusdata", { from: ani }));
    await h.drain(ani.id);
    expect(h.tg.lastAnswer(ani.id)).toBe(HAPUSDATA_DONE);
    expect(h.repo.sessions.some((s) => s.learnerId === ani.id)).toBe(false);
    expect(h.repo.memoryNodes.some((m) => m.learnerId === ani.id)).toBe(false);
    expect(h.repo.memoryEdges.some((m) => m.learnerId === ani.id)).toBe(false);
    expect(h.repo.feedback).toHaveLength(0);
    expect(h.repo.learners.has(ani.id)).toBe(false);
    expect(h.repo.sessions.some((s) => s.learnerId === budi.id)).toBe(true);
  });

  it("sends the privacy notice once, with the learner's first DM", async () => {
    await h.send(groupAsk("#askAI apa itu few-shot prompting?", { from: ani }));
    await h.drain(ani.id);
    await h.send(dm("contoh few-shot prompting lagi dong", { from: ani }));
    await h.drain(ani.id);
    expect(h.tg.textsIn(ani.id).filter((t) => t === PRIVACY_NOTICE)).toHaveLength(1);
    expect(PRIVACY_NOTICE).toContain("/hapusdata");
  });
});
