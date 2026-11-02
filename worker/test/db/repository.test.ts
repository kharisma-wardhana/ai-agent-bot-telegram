import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { RpcRepository } from "../../src/db/repository";
import { freshDb, migrationFiles, migrationSql } from "./helpers";
import { PgliteRpc } from "./pglite-rpc";

const e = (dim: number) => {
  const v = new Array(1024).fill(0);
  v[dim] = 1;
  return v as number[];
};

let db: PGlite;
let repo: RpcRepository;

beforeEach(async () => {
  db = await freshDb();
  repo = new RpcRepository(new PgliteRpc(db));
});

describe("contract: repository ↔ migrations", () => {
  it("every RPC the repository calls is defined in a migration", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "db", "repository.ts"), "utf8");
    const called = [...src.matchAll(/rpc\.call\("([a-z_]+)"/g)].map((m) => m[1]);
    const sql = migrationFiles().map(migrationSql).join("\n");
    const defined = new Set([...sql.matchAll(/create or replace function ([a-z_]+)\(/g)].map((m) => m[1]));
    expect(called.length).toBeGreaterThan(15);
    expect(called.filter((c) => !defined.has(c!))).toEqual([]);
  });
});

describe("knowledge (AC 14, 22)", () => {
  const src = { title: "Prompting", sourceType: "md" as const, origin: "seed" as const, addedBy: null, r2Key: null, contentHash: "h1" };

  it("appends chunks, finds them by vector, and is a no-op on duplicate hash", async () => {
    const first = await repo.insertKnowledge(src, [
      { position: 0, content: "few-shot prompting", embedding: e(0) },
      { position: 1, content: "chain of thought", embedding: e(1) },
    ]);
    expect(first.chunksAdded).toBe(2);
    expect(first.sourceId).toBeTruthy();

    const again = await repo.insertKnowledge(src, [{ position: 0, content: "x", embedding: e(2) }]);
    expect(again).toEqual({ sourceId: null, chunksAdded: 0 });

    const more = await repo.insertKnowledge({ ...src, contentHash: "h2", origin: "add_knowledge", addedBy: 7 }, [
      { position: 0, content: "new", embedding: e(3) },
    ]);
    expect(more.chunksAdded).toBe(1);
    const count = await db.query<{ c: number }>("select count(*)::int c from knowledge_chunks");
    expect(count.rows[0]!.c).toBe(3);

    const hits = await repo.matchChunks(e(1), 5, 0.5);
    expect(hits.map((h) => h.content)).toEqual(["chain of thought"]);
    expect(hits[0]!.title).toBe("Prompting");
  });
});

describe("learners and sessions", () => {
  it("upserts learners, keeping has_started sticky", async () => {
    const a = await repo.upsertLearner({ telegramId: 42, displayName: "Ani", username: "ani", started: false });
    expect(a).toMatchObject({ telegramId: 42, hasStarted: false, isNew: true });
    const b = await repo.upsertLearner({ telegramId: 42, displayName: null, username: null, started: true });
    expect(b).toMatchObject({ hasStarted: true, isNew: false });
    const c = await repo.upsertLearner({ telegramId: 42, displayName: null, username: null, started: false });
    expect(c.hasStarted).toBe(true);
    await repo.markPrivacyNoticeShown(42);
    const d = await repo.upsertLearner({ telegramId: 42, displayName: null, username: null, started: false });
    expect(d.privacyNoticeShown).toBe(true);
  });

  it("opens a session, records turns in order, closes on feedback once", async () => {
    await repo.upsertLearner({ telegramId: 1, displayName: "A", username: null, started: true });
    const sid = await repo.openSession({ learnerId: 1, chatId: -100, threadId: 5, messageId: 77 });
    const open = await repo.getOpenSession(1);
    expect(open).toMatchObject({ id: sid, originChatId: -100, originThreadId: 5, originMessageId: 77 });

    await repo.addTurn({ sessionId: sid, role: "user", content: "apa itu RAG?", questionKind: "text" });
    await repo.addTurn({ sessionId: sid, role: "assistant", content: "RAG adalah…", answerSource: "lesson_docs", sources: ["a.md"], backend: "kaggle", stageTimings: { retrieve: 120 } });
    await repo.addTurn({ sessionId: sid, role: "user", content: "contohnya?" });
    const last2 = await repo.getTurns(sid, 2);
    expect(last2.map((t) => t.content)).toEqual(["RAG adalah…", "contohnya?"]);

    expect(await repo.closeSessionWithFeedback(sid, "reaction", "👍")).toBe(true);
    expect(await repo.closeSessionWithFeedback(sid, "text", "makasih")).toBe(false);
    expect(await repo.getOpenSession(1)).toBeNull();
  });
});

describe("follow-ups, held answers, ingest jobs, heartbeat", () => {
  it("counts recent escalations per learner", async () => {
    await repo.upsertLearner({ telegramId: 1, displayName: "A", username: null, started: true });
    const sid = await repo.openSession({ learnerId: 1, chatId: null, threadId: null, messageId: null });
    await repo.addFollowup(sid, "q1", [11, 22]);
    await repo.addFollowup(sid, "q2", [11]);
    expect(await repo.countRecentEscalations(1, 60)).toBe(2);
    expect(await repo.countRecentEscalations(2, 60)).toBe(0);
    const f = await db.query<{ mentors_notified: number[] }>("select mentors_notified from mentor_followups order by id limit 1");
    expect(f.rows[0]!.mentors_notified.map(Number)).toEqual([11, 22]);
  });

  it("holds answers and hands each out exactly once", async () => {
    await repo.upsertLearner({ telegramId: 1, displayName: "A", username: null, started: false });
    await repo.upsertLearner({ telegramId: 2, displayName: "B", username: null, started: false });
    await repo.holdAnswer(1, null, "not_started", { text: "jawaban" });
    await repo.holdAnswer(2, null, "image_deferred", { fileId: "x" });
    const got = await repo.takePendingAnswers(1, "not_started", 10);
    expect(got).toHaveLength(1);
    expect(got[0]!.payload).toEqual({ text: "jawaban" });
    expect(await repo.takePendingAnswers(1, "not_started", 10)).toHaveLength(0);
    const anyImg = await repo.takePendingAnswers(null, "image_deferred", 10);
    expect(anyImg.map((p) => p.learnerId)).toEqual([2]);
  });

  it("creates ingest jobs and reports heartbeat age", async () => {
    const id = await repo.createIngestJob({ r2Key: "k", fileName: "a.pdf", sourceType: "pdf", requestedBy: 9 });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(await repo.heartbeatAgeSeconds("kaggle")).toBeNull();
    await db.query("select * from record_heartbeat('kaggle', 'qwen3-vl-8b')");
    const age = await repo.heartbeatAgeSeconds("kaggle");
    expect(age).not.toBeNull();
    expect(age!).toBeLessThan(5);
  });
});

describe("memory graph + deletion (AC 16, 17)", () => {
  it("saves nodes/edges from ended sessions, recalls them, and deletes on request", async () => {
    await repo.upsertLearner({ telegramId: 1, displayName: "A", username: null, started: true });
    const sid = await repo.openSession({ learnerId: 1, chatId: null, threadId: null, messageId: null });
    await repo.addTurn({ sessionId: sid, role: "user", content: "embedding itu apa" });
    await repo.closeSessionWithFeedback(sid, "button", "up");

    const pending = await repo.sessionsPendingMemory(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.turns[0]).toEqual({ role: "user", content: "embedding itu apa" });

    const saved = await repo.saveMemory(1, sid, 1.0,
      [{ kind: "concept", label: "embedding", embedding: e(4) }, { kind: "difficulty", label: "vektor", embedding: null }],
      [{ from: { kind: "concept", label: "embedding" }, relation: "kesulitan_dengan", to: { kind: "difficulty", label: "vektor" } }]);
    expect(saved).toEqual({ nodes: 2, edges: 1 });
    expect(await repo.sessionsPendingMemory(10)).toHaveLength(0);

    const recalled = await repo.matchMemory(1, e(4), 3);
    expect(recalled[0]!.label).toBe("embedding");
    const edges = await repo.memoryEdgesFor(1, [recalled[0]!.id]);
    expect(edges).toEqual([{ fromLabel: "embedding", relation: "kesulitan_dengan", toLabel: "vektor", weight: 1 }]);

    // Re-saving the same node accumulates weight instead of duplicating.
    await repo.saveMemory(1, sid, 0.5, [{ kind: "concept", label: "embedding", embedding: null }], []);
    const w = await db.query<{ weight: number }>("select weight from memory_nodes where label = 'embedding'");
    expect(w.rows[0]!.weight).toBeCloseTo(1.5);

    expect(await repo.deleteLearnerData(1)).toBe(1);
    expect(await repo.matchMemory(1, e(4), 3)).toEqual([]);
  });

  it("expires idle sessions via the repository", async () => {
    await repo.upsertLearner({ telegramId: 1, displayName: "A", username: null, started: true });
    const sid = await repo.openSession({ learnerId: 1, chatId: null, threadId: null, messageId: null });
    await db.query("update sessions set last_activity_at = now() - interval '25 hours'");
    expect(await repo.expireSessions(24)).toEqual([sid]);
  });
});
