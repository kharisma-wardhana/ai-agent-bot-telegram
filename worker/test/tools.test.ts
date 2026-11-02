import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDepsOverride } from "../src/deps";
import { toWireMessages } from "../src/llm/types";
import { MAX_TOOL_ROUNDS } from "../src/pipeline/ask-pipeline";
import { FALLBACK_TOPIC_TEXT } from "../src/rag/grounding";
import { selectSkill } from "../src/skills";
import { ESCALATION_LIMIT_PER_HOUR, runTool, TOOL_DEFS, type ToolContext } from "../src/tools";
import { lastUser } from "./fakes/fake-llm";
import { GROUP_ID, groupAsk, learner } from "./fakes/fake-telegram";
import { groundedScript, makeHarness, MENTORS, type Harness } from "./fakes/harness";

let h: Harness;
let n = 1100;
let ani: ReturnType<typeof learner>;
const ctx = (): ToolContext => ({ d: h.deps, learnerId: ani.id, escalated: false, extraSources: [] });

beforeEach(async () => {
  h = makeHarness();
  ani = learner(n++, "Ani");
  await h.seed("Mastering the Art of Prompting", "Prompt yang baik harus jelas dan spesifik. Few-shot prompting memberi contoh agar model paham pola.");
  await h.seed("How large language models work", "Large language model memprediksi token berikutnya berdasarkan konteks dan parameter hasil pelatihan.");
});
afterEach(() => setDepsOverride(null));

describe("skills (AC 21 support)", () => {
  it("selects a skill pack by intent, defaulting to jelaskan-konsep", () => {
    expect(selectSkill("buatkan soal latihan tentang prompt").name).toBe("latihan-soal");
    expect(selectSkill("tolong ringkas materi LLM").name).toBe("ringkas-materi");
    expect(selectSkill("contoh kode python untuk memanggil API").name).toBe("contoh-kode");
    expect(selectSkill("apa itu token?").name).toBe("jelaskan-konsep");
  });

  it("puts the chosen skill's instructions in the system prompt", async () => {
    await h.send(groupAsk("#askAI soal latihan few-shot prompting memberi contoh", { from: ani }));
    await h.drain(ani.id);
    expect(String(h.kaggle.requests[0]!.messages[0]!.content)).toContain("Kunci: 1-B, 2-A");
  });
});

describe("tool definitions and handlers", () => {
  it("defines exactly the three spec tools", () => {
    expect(TOOL_DEFS.map((t) => t.function.name)).toEqual(["search_lesson_docs", "recall_memory", "escalate_to_mentor"]);
  });

  it("search_lesson_docs returns a data block and records sources; bad input is an error string", async () => {
    const c = ctx();
    const out = await runTool({ id: "1", name: "search_lesson_docs", arguments: '{"query":"large language model token"}' }, c);
    expect(out).toContain("<dokumen>");
    expect(out).toContain("memprediksi token");
    expect(c.extraSources).toEqual(["How large language models work"]);
    expect(await runTool({ id: "2", name: "search_lesson_docs", arguments: "{oops" }, c)).toMatch(/^ERROR/);
    expect(await runTool({ id: "3", name: "rm_rf", arguments: "{}" }, c)).toMatch(/^ERROR/);
  });

  it(`escalate_to_mentor is limited to ${ESCALATION_LIMIT_PER_HOUR} per learner per hour`, async () => {
    await h.repo.upsertLearner({ telegramId: ani.id, displayName: "Ani", username: null, started: true });
    const sid = await h.repo.openSession({ learnerId: ani.id, chatId: null, threadId: null, messageId: null });
    for (let i = 0; i < ESCALATION_LIMIT_PER_HOUR; i++) await h.repo.addFollowup(sid, `q${i}`, MENTORS);
    const c = ctx();
    expect(await runTool({ id: "1", name: "escalate_to_mentor", arguments: '{"reason":"x"}' }, c)).toMatch(/^DITOLAK/);
    expect(c.escalated).toBe(false);
  });

  it("converts assistant tool calls to the OpenAI wire format", () => {
    const wire = toWireMessages([{ role: "assistant", content: "", tool_calls: [{ id: "c1", name: "search_lesson_docs", arguments: "{}" }] }]);
    expect(wire[0]).toEqual({ role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "search_lesson_docs", arguments: "{}" } }] });
  });
});

describe("tool loop in the pipeline", () => {
  it("runs a model-requested search, feeds the result back, and cites the extra source", async () => {
    h.kaggle.script = (req) => {
      const toolMsg = req.messages.find((m) => m.role === "tool");
      if (!toolMsg) return { content: "", toolCalls: [{ id: "t1", name: "search_lesson_docs", arguments: '{"query":"large language model token"}' }] };
      return toolMsg.content.includes("memprediksi token") ? "LLM memprediksi token berikutnya, dan prompt yang jelas membantu, ya kamu." : "NOT_FOUND";
    };
    await h.send(groupAsk("#askAI hubungan prompt yang jelas dengan cara kerja model?", { from: ani }));
    await h.drain(ani.id);
    expect(h.kaggle.requests).toHaveLength(2);
    expect(h.kaggle.requests[0]!.tools?.length).toBe(3);
    const final = h.tg.lastAnswer(ani.id)!;
    expect(final).toContain("memprediksi token");
    expect(final).toContain("How large language models work");
    expect(final.length).toBeLessThanOrEqual(1000);
  });

  it(`stops offering tools after ${MAX_TOOL_ROUNDS} rounds`, async () => {
    h.kaggle.script = (req) => (req.tools ? { content: "", toolCalls: [{ id: `t${req.messages.length}`, name: "recall_memory", arguments: '{"query":"prompt"}' }] } : groundedScript(req));
    await h.send(groupAsk("#askAI prompt yang baik itu seperti apa?", { from: ani }));
    await h.drain(ani.id);
    expect(h.kaggle.requests).toHaveLength(MAX_TOOL_ROUNDS + 1);
    expect(h.kaggle.requests.at(-1)!.tools).toBeUndefined();
    expect(h.tg.lastAnswer(ani.id)).toContain("prompt yang baik");
  });

  it("escalate_to_mentor triggers the mentor fallback", async () => {
    h.kaggle.script = () => ({ content: "", toolCalls: [{ id: "e1", name: "escalate_to_mentor", arguments: '{"reason":"di luar materi"}' }] });
    await h.send(groupAsk("#askAI prompt yang baik harus jelas dan spesifik untuk puisi?", { from: ani }));
    await h.drain(ani.id);
    expect(h.tg.textsIn(GROUP_ID)).toEqual([FALLBACK_TOPIC_TEXT]);
    expect(h.repo.followups).toHaveLength(1);
    expect(lastUser(h.kaggle.requests[0]!)).toContain("<pertanyaan>");
  });
});
