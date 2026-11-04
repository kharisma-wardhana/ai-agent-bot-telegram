import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDepsOverride } from "../src/deps";
import { GROUP_ID, groupAsk, learner } from "./fakes/fake-telegram";
import { makeHarness, OWNER, type DashSession, type Harness } from "./fakes/harness";

// docs/mentor-followup-dashboard/spec.md AC 16, 17: "Tambahkan ke pengetahuan".

let h: Harness;
let owner: DashSession;
const ani = learner(501, "Ani");
const QUESTION = "Bagaimana cara kerja vector database pinecone untuk retrieval";
const REPLY = "Vector database pinecone menyimpan embedding dan mencari tetangga terdekat untuk retrieval dokumen.";

async function followup(close: boolean): Promise<number> {
  await h.repo.upsertLearner({ telegramId: ani.id, displayName: "Ani", username: "ani", started: true });
  const s = await h.repo.openSession({ learnerId: ani.id, chatId: GROUP_ID, threadId: 55, messageId: 4242 });
  const id = await h.repo.addFollowupV2(s, QUESTION, [111], null);
  if (close) {
    await h.dash(`/dashboard/followups/${id}/claim`, { form: { csrf: owner.csrf }, session: owner });
    await h.dash(`/dashboard/followups/${id}/reply`, { form: { csrf: owner.csrf, reply: REPLY }, session: owner });
  }
  return id;
}
const add = (id: number) => h.dash(`/dashboard/followups/${id}/knowledge`, { form: { csrf: owner.csrf }, session: owner });

beforeEach(async () => {
  h = makeHarness();
  await h.seed("Mastering the Art of Prompting", "Prompt yang baik harus jelas dan spesifik. Gunakan contoh few-shot prompting.");
  owner = await h.login(OWNER.email, OWNER.telegramId);
});
afterEach(() => setDepsOverride(null));

describe("adding a closed follow-up to the knowledge base (AC 16)", () => {
  it("asks for confirmation first, then appends exactly one add_knowledge source, linked to the follow-up", async () => {
    const id = await followup(true);
    const before = h.repo.chunks.map((c) => ({ ...c }));

    const confirm = await h.dash(`/dashboard/followups/${id}/knowledge`, { session: owner });
    expect(confirm.status).toBe(200);
    const page = await confirm.text();
    expect(page).toContain("Ya, tambahkan");
    expect(page).toContain("Follow-up mentor:");
    expect(h.repo.sources).toHaveLength(1); // the GET adds nothing

    const res = await add(id);
    expect(res.headers.get("Location")).toContain("pesan=pengetahuan-ditambah");
    expect(h.repo.sources).toHaveLength(2);
    const src = h.repo.sources[1]!;
    expect(src).toMatchObject({ origin: "add_knowledge", sourceType: "text", addedBy: OWNER.telegramId });
    expect(src.title.startsWith("Follow-up mentor: ")).toBe(true);
    expect(h.repo.followups[0]!.knowledgeSourceId).toBe(src.id);
    // existing chunks are untouched; only new rows were appended
    expect(h.repo.chunks.slice(0, before.length)).toEqual(before);
    expect(h.repo.chunks.length).toBeGreaterThan(before.length);
    expect(h.repo.chunks.filter((c) => c.sourceId === src.id).map((c) => c.content).join(" ")).toContain(REPLY);
  });

  it("makes the same question answerable from lesson-docs instead of the mentor fallback", async () => {
    const id = await followup(true);
    await add(id);
    h.tg.calls = [];
    await h.send(groupAsk(`#askAI ${QUESTION}?`, { from: ani }));
    await h.drain(ani.id);
    const answer = h.repo.turns.filter((t) => t.role === "assistant").at(-1)!;
    expect(answer.answerSource).toBe("lesson_docs");
    expect(answer.sources).toContain(h.repo.sources[1]!.title);
    expect(h.repo.followups).toHaveLength(1); // no new escalation
  });

  it("a second press adds nothing and says so", async () => {
    const id = await followup(true);
    await add(id);
    const again = await add(id);
    expect(again.headers.get("Location")).toContain("pesan=pengetahuan-sudah-ada");
    expect(h.repo.sources).toHaveLength(2);
    const page = await (await h.dash("/dashboard?tab=selesai", { session: owner })).text();
    expect(page).toContain("Sudah ditambahkan ke pengetahuan");
    expect(page).not.toContain(`/dashboard/followups/${id}/knowledge`);
  });
});

describe("refusals (AC 17)", () => {
  it("rejects a follow-up that isn't closed, for both the confirm page and the POST", async () => {
    const id = await followup(false);
    expect((await h.dash(`/dashboard/followups/${id}/knowledge`, { session: owner })).headers.get("Location")).toContain("pesan=belum-selesai");
    expect((await add(id)).headers.get("Location")).toContain("pesan=belum-selesai");
    await h.dash(`/dashboard/followups/${id}/claim`, { form: { csrf: owner.csrf }, session: owner });
    expect((await add(id)).headers.get("Location")).toContain("pesan=belum-selesai");
    expect(h.repo.sources).toHaveLength(1);
  });

  it("needs a session and a CSRF token", async () => {
    const id = await followup(true);
    expect((await h.dash(`/dashboard/followups/${id}/knowledge`, { form: { csrf: owner.csrf } })).status).toBe(303);
    expect((await h.dash(`/dashboard/followups/${id}/knowledge`, { form: {}, session: owner })).status).toBe(403);
    expect(h.repo.sources).toHaveLength(1);
  });
});
