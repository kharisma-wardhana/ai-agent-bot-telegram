import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, unitVec } from "./helpers";

let db: PGlite;

async function addSource(hash: string, title = "Doc") {
  const r = await db.query<{ id: string }>(
    `insert into knowledge_sources (title, source_type, origin, content_hash) values ($1, 'md', 'seed', $2) returning id`,
    [title, hash],
  );
  return r.rows[0]!.id;
}

async function addLearner(id: number) {
  await db.query(`insert into learners (telegram_id, display_name) values ($1, 'L')`, [id]);
}

async function addSession(learner: number, idleHours = 0) {
  const r = await db.query<{ id: string }>(
    `insert into sessions (learner_id, last_activity_at) values ($1, now() - make_interval(hours => $2)) returning id`,
    [learner, idleHours],
  );
  return r.rows[0]!.id;
}

beforeEach(async () => {
  db = await freshDb();
});

describe("migrations", () => {
  it("apply cleanly and create every table", async () => {
    const r = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
    );
    expect(r.rows.map((x) => x.table_name)).toEqual([
      "feedback", "inference_heartbeat", "ingest_jobs", "knowledge_chunks", "knowledge_sources",
      "learners", "memory_edges", "memory_nodes", "mentor_followups", "pending_answers",
      "session_turns", "sessions",
    ]);
  });
});

describe("match_chunks", () => {
  it("orders by similarity and drops results below the threshold", async () => {
    const s = await addSource("h1", "Prompting");
    await db.query(`insert into knowledge_chunks (source_id, position, content, embedding) values
      ($1, 0, 'exact', $2), ($1, 1, 'close', $3), ($1, 2, 'unrelated', $4)`,
      [s, unitVec(0), unitVec(0, { dim: 1, w: 0.5 }), unitVec(5)]);
    const r = await db.query<{ content: string; title: string; similarity: number }>(
      `select * from match_chunks($1, 5, 0.5)`, [unitVec(0)]);
    expect(r.rows.map((x) => x.content)).toEqual(["exact", "close"]);
    expect(r.rows[0]!.title).toBe("Prompting");
    expect(r.rows[0]!.similarity).toBeCloseTo(1, 5);
  });
});

describe("knowledge append-only + idempotent seed (AC 14, 22)", () => {
  it("rejects a duplicate content_hash so re-seeding is a no-op", async () => {
    await addSource("same");
    await expect(addSource("same")).rejects.toThrow();
    const r = await db.query(`insert into knowledge_sources (title, source_type, origin, content_hash)
      values ('x','md','seed','same') on conflict (content_hash) do nothing returning id`);
    expect(r.rows).toHaveLength(0);
  });
});

describe("delete_learner_data (AC 17)", () => {
  it("removes only that learner's rows, across every personal table", async () => {
    await addLearner(1);
    await addLearner(2);
    const s1 = await addSession(1);
    const s2 = await addSession(2);
    for (const s of [s1, s2]) {
      await db.query(`insert into session_turns (session_id, role, content) values ($1, 'user', 'q')`, [s]);
      await db.query(`insert into feedback (session_id, kind, value) values ($1, 'button', 'up')`, [s]);
    }
    const n1 = await db.query<{ id: number }>(
      `insert into memory_nodes (learner_id, kind, label) values (1, 'concept', 'rag') returning id`);
    const n2 = await db.query<{ id: number }>(
      `insert into memory_nodes (learner_id, kind, label) values (1, 'difficulty', 'embedding') returning id`);
    await db.query(`insert into memory_edges (learner_id, from_node, relation, to_node) values (1, $1, 'related', $2)`,
      [n1.rows[0]!.id, n2.rows[0]!.id]);
    await db.query(`insert into memory_nodes (learner_id, kind, label) values (2, 'concept', 'llm')`);

    const del = await db.query<{ delete_learner_data: number }>(`select delete_learner_data(1)`);
    expect(del.rows[0]!.delete_learner_data).toBe(1);

    const count = async (sql: string) => Number((await db.query<{ c: number }>(sql)).rows[0]!.c);
    expect(await count(`select count(*) c from learners where telegram_id = 1`)).toBe(0);
    expect(await count(`select count(*) c from sessions where learner_id = 1`)).toBe(0);
    expect(await count(`select count(*) c from memory_nodes where learner_id = 1`)).toBe(0);
    expect(await count(`select count(*) c from memory_edges where learner_id = 1`)).toBe(0);
    expect(await count(`select count(*) c from session_turns`)).toBe(1);
    expect(await count(`select count(*) c from feedback`)).toBe(1);
    expect(await count(`select count(*) c from memory_nodes where learner_id = 2`)).toBe(1);
  });
});

describe("expire_sessions", () => {
  it("expires only open sessions idle longer than the TTL", async () => {
    await addLearner(1);
    const old = await addSession(1, 25);
    const fresh = await addSession(1, 1);
    const closedOld = await addSession(1, 30);
    await db.query(`update sessions set status = 'closed_feedback' where id = $1`, [closedOld]);
    const r = await db.query<{ expire_sessions: string }>(`select * from expire_sessions(24)`);
    expect(r.rows.map((x) => x.expire_sessions)).toEqual([old]);
    const st = await db.query<{ id: string; status: string }>(`select id, status from sessions`);
    const byId = Object.fromEntries(st.rows.map((x) => [x.id, x.status]));
    expect(byId[fresh]).toBe("open");
    expect(byId[closedOld]).toBe("closed_feedback");
  });
});

describe("claim_ingest_job", () => {
  it("claims the oldest pending job once", async () => {
    await db.query(`insert into ingest_jobs (r2_key, file_name, source_type, requested_by, created_at) values
      ('a', 'a.pdf', 'pdf', 1, now() - interval '1 minute'), ('b', 'b.html', 'html', 1, now())`);
    const first = await db.query<{ r2_key: string; status: string }>(`select * from claim_ingest_job()`);
    expect(first.rows[0]).toMatchObject({ r2_key: "a", status: "processing" });
    const second = await db.query<{ r2_key: string }>(`select * from claim_ingest_job()`);
    expect(second.rows[0]!.r2_key).toBe("b");
    const third = await db.query(`select * from claim_ingest_job()`);
    expect(third.rows).toHaveLength(0);
  });
});

describe("answer_source_ratio", () => {
  it("computes answered / (answered + fallback)", async () => {
    await addLearner(1);
    const s = await addSession(1);
    for (const src of ["lesson_docs", "lesson_docs", "lesson_docs", "fallback"]) {
      await db.query(`insert into session_turns (session_id, role, content, answer_source) values ($1, 'assistant', 'a', $2)`, [s, src]);
    }
    const r = await db.query<{ answered_ratio: string }>(`select answered_ratio from answer_source_ratio`);
    expect(Number(r.rows[0]!.answered_ratio)).toBe(0.75);
  });
});

describe("match_memory_nodes", () => {
  it("returns only the learner's nodes, nearest first", async () => {
    await addLearner(1);
    await addLearner(2);
    await db.query(`insert into memory_nodes (learner_id, kind, label, embedding) values
      (1, 'concept', 'near', $1), (1, 'concept', 'far', $2), (2, 'concept', 'other', $1)`,
      [unitVec(3), unitVec(9)]);
    const r = await db.query<{ label: string }>(`select * from match_memory_nodes(1, $1, 5)`, [unitVec(3)]);
    expect(r.rows.map((x) => x.label)).toEqual(["near", "far"]);
  });
});
