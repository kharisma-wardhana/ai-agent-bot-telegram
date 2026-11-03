import type { PGlite } from "@electric-sql/pglite";
import { PGlite as PGliteCtor } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, migrationFiles, migrationSql } from "./helpers";

// Regression for docs/mentor-followup-dashboard/spec.md (AC 5, 8, 10, 11, 22), at the SQL level.

let db: PGlite;
const DAY = 24 * 3600;

async function learnerSession(id: number, name = "Learner") {
  await db.query(`insert into learners (telegram_id, display_name, has_started) values ($1, $2, true) on conflict do nothing`, [id, name]);
  const r = await db.query<{ id: string }>(
    `insert into sessions (learner_id, origin_chat_id, origin_thread_id, origin_message_id) values ($1, -1001234567890, 7, 42) returning id`, [id]);
  return r.rows[0]!.id;
}

async function newFollowup(session: string, q = "Apa itu RAG?") {
  const r = await db.query<{ id: number }>(`select * from add_followup_v2($1, $2, $3, $4)`, [session, q, JSON.stringify([111]), null]);
  return Number(r.rows[0]!.id);
}

const list = async (tab: string, ttl = DAY) =>
  (await db.query<Record<string, unknown>>(`select * from dashboard_list_followups($1, $2)`, [tab, ttl])).rows;

beforeEach(async () => {
  db = await freshDb();
});

describe("0004 applies on top of 0001–0003 (AC 22)", () => {
  it("is a new, last migration file and keeps add_followup from 0003", async () => {
    expect(migrationFiles().at(-1)).toBe("0004_mentor_dashboard.sql");
    const r = await db.query<{ proname: string }>(`select proname from pg_proc where proname in ('add_followup', 'add_followup_v2') order by 1`);
    expect(r.rows.map((x) => x.proname)).toEqual(["add_followup", "add_followup_v2"]);
  });
});

describe("only follow-ups created after the migration are listed (AC 8)", () => {
  it("hides pre-existing rows and shows new ones", async () => {
    const old = await PGliteCtor.create({ extensions: { vector } });
    db = old;
    for (const f of migrationFiles().filter((f) => !f.startsWith("0004"))) await db.exec(migrationSql(f));
    const s = await learnerSession(501);
    await db.query(`select * from add_followup($1, 'pertanyaan lama', '[]'::jsonb)`, [s]);
    await db.exec(migrationSql("0004_mentor_dashboard.sql"));
    await db.query(`select * from add_followup($1, 'pertanyaan baru lewat fungsi lama', '[]'::jsonb)`, [s]);
    await newFollowup(s, "pertanyaan baru");

    const qs = (await list("active")).map((r) => r.question);
    expect(qs).toEqual(expect.arrayContaining(["pertanyaan baru", "pertanyaan baru lewat fungsi lama"]));
    expect(qs).not.toContain("pertanyaan lama");
  });
});

describe("list never carries learner identity (AC 9, data side)", () => {
  it("returns no column holding the learner's name or Telegram ID", async () => {
    const s = await learnerSession(987654321, "Zulaikha Unik");
    await newFollowup(s);
    const [row] = await list("active");
    const flat = JSON.stringify(row);
    expect(flat).not.toContain("987654321");
    expect(flat).not.toContain("Zulaikha");
    expect(row!.thread_id).toBe(7);
  });
});

describe("claiming (AC 10, 11)", () => {
  it("lets exactly one of two concurrent claims win", async () => {
    const id = await newFollowup(await learnerSession(501));
    const [a, b] = await Promise.all([
      db.query<{ claimed: boolean; claimed_by_name: string }>(`select * from dashboard_claim_followup($1, 'a@x.id', 'Ana', $2)`, [id, DAY]),
      db.query<{ claimed: boolean; claimed_by_name: string }>(`select * from dashboard_claim_followup($1, 'b@x.id', 'Budi', $2)`, [id, DAY]),
    ]);
    const results = [a.rows[0]!, b.rows[0]!];
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    const loser = results.find((r) => !r.claimed)!;
    expect(loser.claimed_by_name).toBe(results.find((r) => r.claimed)!.claimed_by_name);
    expect((await list("active"))[0]!.status).toBe("claimed");
  });

  it("treats a claim older than the TTL as open and lets someone else claim it", async () => {
    const id = await newFollowup(await learnerSession(501));
    await db.query(`select * from dashboard_claim_followup($1, 'a@x.id', 'Ana', $2)`, [id, DAY]);
    await db.query(`update mentor_followups set claimed_at = now() - interval '25 hours' where id = $1`, [id]);
    const row = (await list("active"))[0]!;
    expect(row.status).toBe("open");
    expect(row.claimed_by_name).toBeNull();
    const r = await db.query<{ claimed: boolean }>(`select * from dashboard_claim_followup($1, 'b@x.id', 'Budi', $2)`, [id, DAY]);
    expect(r.rows[0]!.claimed).toBe(true);
  });

  it("only the live claimer can release or close; a lapsed claimer cannot close", async () => {
    const id = await newFollowup(await learnerSession(501));
    await db.query(`select * from dashboard_claim_followup($1, 'a@x.id', 'Ana', $2)`, [id, DAY]);
    expect((await db.query<{ released: boolean }>(`select * from dashboard_release_followup($1, 'b@x.id')`, [id])).rows[0]!.released).toBe(false);
    expect((await db.query(`select * from dashboard_close_followup($1, 'b@x.id', 'Budi', 'jawab', $2)`, [id, DAY])).rows).toHaveLength(0);

    await db.query(`update mentor_followups set claimed_at = now() - interval '25 hours' where id = $1`, [id]);
    expect((await db.query(`select * from dashboard_close_followup($1, 'a@x.id', 'Ana', 'jawab', $2)`, [id, DAY])).rows).toHaveLength(0);
  });

  it("closes once and returns what delivery needs; a second close returns nothing", async () => {
    const id = await newFollowup(await learnerSession(501, "Ani"));
    await db.query(`select * from dashboard_claim_followup($1, 'a@x.id', 'Ana', $2)`, [id, DAY]);
    const first = await db.query<Record<string, unknown>>(`select * from dashboard_close_followup($1, 'a@x.id', 'Ana', 'RAG itu…', $2)`, [id, DAY]);
    expect(first.rows[0]).toMatchObject({ learner_id: 501, learner_name: "Ani", learner_started: true, origin_thread_id: 7, origin_message_id: 42 });
    const second = await db.query(`select * from dashboard_close_followup($1, 'a@x.id', 'Ana', 'RAG itu…', $2)`, [id, DAY]);
    expect(second.rows).toHaveLength(0);
    expect((await list("closed"))[0]).toMatchObject({ status: "closed", reply_text: "RAG itu…", replied_by_name: "Ana" });
    expect(await list("active")).toHaveLength(0);
  });
});

describe("login links and sessions store only hashes (AC 4, 5)", () => {
  it("rate-limits issuing per email and consumes a link once", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await db.query<{ issued: boolean }>(`select * from dashboard_issue_login_token('a@x.id', $1, 600, 3, 900)`, [`h${i}`]);
      expect(r.rows[0]!.issued).toBe(true);
    }
    const fourth = await db.query<{ issued: boolean }>(`select * from dashboard_issue_login_token('a@x.id', 'h3', 600, 3, 900)`);
    expect(fourth.rows[0]!.issued).toBe(false);

    expect((await db.query(`select * from dashboard_consume_login_token('h0')`)).rows).toEqual([{ email: "a@x.id" }]);
    expect((await db.query(`select * from dashboard_consume_login_token('h0')`)).rows).toEqual([]);
  });

  it("refuses an expired link", async () => {
    await db.query(`select * from dashboard_issue_login_token('a@x.id', 'old', 600, 3, 900)`);
    await db.query(`update dashboard_login_tokens set expires_at = now() - interval '1 second' where token_hash = 'old'`);
    expect((await db.query(`select * from dashboard_consume_login_token('old')`)).rows).toEqual([]);
  });

  it("removing a user revokes their sessions and pending links", async () => {
    const u = await db.query<{ id: number }>(`select * from dashboard_add_user('Mentor@X.id', 'Mentor', 333, 'owner@x.id')`);
    const id = Number(u.rows[0]!.id);
    expect((await db.query(`select * from dashboard_add_user('mentor@x.id', 'Dup', 334, 'owner@x.id')`)).rows).toEqual([]);
    await db.query(`select * from dashboard_create_session('s1', 'c1', 'mentor@x.id', 604800)`);
    await db.query(`select * from dashboard_issue_login_token('mentor@x.id', 't1', 600, 3, 900)`);
    expect((await db.query(`select * from dashboard_get_session('s1')`)).rows).toHaveLength(1);

    expect((await db.query(`select * from dashboard_remove_user($1)`, [id])).rows).toEqual([{ email: "mentor@x.id" }]);
    expect((await db.query(`select * from dashboard_get_session('s1')`)).rows).toEqual([]);
    expect((await db.query(`select * from dashboard_consume_login_token('t1')`)).rows).toEqual([]);
    expect((await db.query(`select * from dashboard_list_users()`)).rows).toEqual([]);
  });
});

describe("knowledge link is set once, only on closed questions (AC 16, 17)", () => {
  it("refuses an open question and links a closed one exactly once", async () => {
    const src = (await db.query<{ id: string }>(
      `insert into knowledge_sources (title, source_type, origin, content_hash) values ('F', 'text', 'add_knowledge', 'k1') returning id`)).rows[0]!.id;
    const id = await newFollowup(await learnerSession(501));
    expect((await db.query<{ linked: boolean }>(`select * from dashboard_set_knowledge($1, $2)`, [id, src])).rows[0]!.linked).toBe(false);
    await db.query(`select * from dashboard_claim_followup($1, 'a@x.id', 'Ana', $2)`, [id, DAY]);
    await db.query(`select * from dashboard_close_followup($1, 'a@x.id', 'Ana', 'jawab', $2)`, [id, DAY]);
    expect((await db.query<{ linked: boolean }>(`select * from dashboard_set_knowledge($1, $2)`, [id, src])).rows[0]!.linked).toBe(true);
    expect((await db.query<{ linked: boolean }>(`select * from dashboard_set_knowledge($1, $2)`, [id, src])).rows[0]!.linked).toBe(false);
  });
});
