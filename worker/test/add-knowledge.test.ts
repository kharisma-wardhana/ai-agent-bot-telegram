import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/config";
import { setDepsOverride } from "../src/deps";
import { MSG } from "../src/knowledge/add-knowledge";
import { dm, groupAsk, learner } from "./fakes/fake-telegram";
import { makeHarness, type Harness } from "./fakes/harness";

let h: Harness;
const mentor = learner(111, "Mentor");
const stranger = learner(777, "Budi");
const bucket = () => (env as unknown as Env).KNOWLEDGE_BUCKET;

beforeEach(async () => {
  h = makeHarness();
  await h.seed("Mastering the Art of Prompting", "Prompt yang baik harus jelas dan spesifik.");
});
afterEach(() => setDepsOverride(null));

describe("/add_knowledge authorization (AC 13, 19)", () => {
  it("refuses non-whitelisted users and changes nothing", async () => {
    const before = h.repo.chunks.length;
    await h.send(dm("/add_knowledge Vektor database menyimpan embedding untuk pencarian semantik.", { from: stranger }));
    await h.drain(stranger.id);
    expect(h.tg.textsIn(stranger.id)).toEqual([MSG.refused]);
    expect(h.repo.chunks.length).toBe(before);
    expect(h.repo.sources).toHaveLength(1);
  });
});

describe("/add_knowledge text (AC 13)", () => {
  it("appends text and a later #askAI question is answered from it", async () => {
    await h.send(dm("/add_knowledge Vektor database menyimpan embedding untuk pencarian semantik cepat.", { from: mentor }));
    await h.drain(mentor.id);
    const replies = h.tg.textsIn(mentor.id);
    expect(replies[0]).toBe(MSG.received);
    expect(replies[1]).toMatch(/^✅ Selesai: 1 potongan materi dari "Vektor database menyimpan embedding/);
    expect(h.repo.sources.at(-1)).toMatchObject({ origin: "add_knowledge", addedBy: 111, sourceType: "text" });

    const ani = learner(501, "Ani");
    await h.send(groupAsk("#askAI vektor database menyimpan apa untuk pencarian semantik?", { from: ani }));
    await h.drain(ani.id);
    expect(h.tg.textsIn(ani.id).at(-1)).toContain("📚 Sumber: Vektor database menyimpan embedding");
  });

  it("reports a duplicate instead of adding it twice", async () => {
    const cmd = "/add_knowledge Materi yang sama persis.";
    await h.send(dm(cmd, { from: mentor }));
    await h.drain(mentor.id);
    const n = h.repo.chunks.length;
    await h.send(dm(cmd, { from: mentor }));
    await h.drain(mentor.id);
    expect(h.repo.chunks.length).toBe(n);
    expect(h.tg.textsIn(mentor.id).at(-1)).toBe(MSG.duplicate);
  });

  it("shows usage for an empty command", async () => {
    await h.send(dm("/add_knowledge", { from: mentor }));
    await h.drain(mentor.id);
    expect(h.tg.textsIn(mentor.id)).toEqual([MSG.usage]);
  });
});

describe("/add_knowledge files (AC 14)", () => {
  const enc = new TextEncoder();

  it(".md and .txt are chunked in the Worker with the original kept in R2; existing chunks untouched", async () => {
    const existing = h.repo.chunks.map((c) => c.content);
    h.tg.files.set("files/md1", enc.encode("# Retrieval Augmented Generation\n\nRAG menggabungkan pencarian dokumen dengan LLM."));
    h.tg.files.set("files/txt1", enc.encode("Tokenisasi memecah teks menjadi token."));
    await h.send(dm("/add_knowledge", { from: mentor, document: { file_id: "md1", file_name: "rag.md", mime_type: "text/markdown" } }));
    await h.drain(mentor.id);
    await h.send(dm("/addknowledge", { from: mentor, document: { file_id: "txt1", file_name: "token.txt", mime_type: "text/plain" } }));
    await h.drain(mentor.id);

    const added = h.repo.sources.filter((s) => s.origin === "add_knowledge");
    expect(added.map((s) => [s.title, s.sourceType])).toEqual([["Retrieval Augmented Generation", "md"], ["token", "txt"]]);
    for (const s of added) {
      const obj = await bucket().get(s.r2Key!);
      expect(obj).not.toBeNull();
      expect(obj!.customMetadata?.addedBy).toBe("111");
    }
    expect(h.repo.chunks.slice(0, existing.length).map((c) => c.content)).toEqual(existing);
    expect(h.repo.chunks.length).toBe(existing.length + 2);
  });

  it(".pdf and .html go to R2 and an ingest job (processed by the Kaggle loop)", async () => {
    h.tg.files.set("files/pdf1", enc.encode("%PDF-1.4 fake"));
    h.tg.files.set("files/html1", enc.encode("<html><body>Glosarium</body></html>"));
    await h.send(dm("/add_knowledge", { from: mentor, document: { file_id: "pdf1", file_name: "Modul 3.pdf", mime_type: "application/pdf" } }));
    await h.drain(mentor.id);
    h.repo.heartbeatAge = null; // Kaggle offline for the second file
    await h.send(dm("/add_knowledge", { from: mentor, document: { file_id: "html1", file_name: "glosarium.html", mime_type: "text/html" } }));
    await h.drain(mentor.id);

    expect(h.repo.ingestJobs.map((j) => [j.sourceType, j.fileName, j.requestedBy])).toEqual([["pdf", "Modul 3.pdf", 111], ["html", "glosarium.html", 111]]);
    for (const j of h.repo.ingestJobs) expect(await bucket().get(j.r2Key)).not.toBeNull();
    const texts = h.tg.textsIn(mentor.id);
    expect(texts).toContain(MSG.queued(true));
    expect(texts).toContain(MSG.queued(false));
  });

  it("rejects unsupported file types", async () => {
    await h.send(dm("/add_knowledge", { from: mentor, document: { file_id: "x", file_name: "slide.pptx", mime_type: "application/vnd.ms-powerpoint" } }));
    await h.drain(mentor.id);
    expect(h.tg.textsIn(mentor.id)).toEqual([MSG.unsupported]);
    expect(h.repo.ingestJobs).toHaveLength(0);
  });
});
