import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, migrationFiles } from "./helpers";

// Regression for docs/cohort-welcome-message/spec.md AC 13, at the SQL level.

let db: PGlite;
beforeEach(async () => {
  db = await freshDb();
});

const take = async (n = 50) => (await db.query<{ telegram_id: number; display_name: string }>(`select * from take_pending_welcomes($1)`, [n])).rows;

describe("0005 applies on top of 0001–0004 (AC 13)", () => {
  it("is the newest migration file", () => {
    expect(migrationFiles().at(-1)).toBe("0005_cohort_welcome.sql");
  });
});

describe("waiting list", () => {
  it("returns each waiting newcomer exactly once, even across two takes", async () => {
    await db.query(`select * from queue_welcome(1, 'Ani')`);
    await db.query(`select * from queue_welcome(2, 'Budi')`);
    const [a, b] = await Promise.all([take(), take()]);
    expect([...a, ...b].map((r) => Number(r.telegram_id)).sort()).toEqual([1, 2]);
    expect(await take()).toEqual([]);
  });

  it("is idempotent per user and honours the limit, oldest first", async () => {
    await db.query(`select * from queue_welcome(1, 'Ani')`);
    await db.query(`select * from queue_welcome(1, 'Ani Baru')`);
    await db.query(`select * from queue_welcome(2, 'Budi')`);
    await db.query(`update pending_welcomes set joined_at = now() - interval '1 minute' where telegram_id = 2`);
    const first = await take(1);
    expect(first.map((r) => [Number(r.telegram_id), r.display_name])).toEqual([[2, "Budi"]]);
    expect((await take(5)).map((r) => [Number(r.telegram_id), r.display_name])).toEqual([[1, "Ani Baru"]]);
  });

  it("unqueues a leaver, and purges rows older than 24 h on the next queue", async () => {
    await db.query(`select * from queue_welcome(1, 'Ani')`);
    expect((await db.query<{ removed: boolean }>(`select * from unqueue_welcome(1)`)).rows[0]!.removed).toBe(true);
    expect((await db.query<{ removed: boolean }>(`select * from unqueue_welcome(1)`)).rows[0]!.removed).toBe(false);

    await db.query(`select * from queue_welcome(7, 'Lama')`);
    await db.query(`update pending_welcomes set joined_at = now() - interval '25 hours' where telegram_id = 7`);
    await db.query(`select * from queue_welcome(8, 'Baru')`);
    expect((await take()).map((r) => Number(r.telegram_id))).toEqual([8]);
  });
});

describe("settings", () => {
  it("has no row until saved, then upserts the single row", async () => {
    expect((await db.query(`select * from get_welcome_settings()`)).rows).toEqual([]);
    await db.query(`select * from save_welcome_settings('Halo {nama}!', 12, true, false, 'a@x.id')`);
    await db.query(`select * from save_welcome_settings('Hai {nama}', null, false, true, 'b@x.id')`);
    const rows = (await db.query<Record<string, unknown>>(`select * from get_welcome_settings()`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ template: "Hai {nama}", topic_id: null, welcome_enabled: false, leave_enabled: true, updated_by: "b@x.id" });
  });

  it("rejects a template over 1000 characters or without {nama} at the database too", async () => {
    await expect(db.query(`select * from save_welcome_settings($1, null, true, true, 'a')`, [`{nama}${"x".repeat(1000)}`])).rejects.toThrow();
    await expect(db.query(`select * from save_welcome_settings('Halo semua', null, true, true, 'a')`)).rejects.toThrow();
    expect((await db.query(`select * from get_welcome_settings()`)).rows).toEqual([]);
  });
});
