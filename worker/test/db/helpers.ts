import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "db", "migrations");

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
}

export function migrationSql(file: string): string {
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

/** Fresh in-memory Postgres with pgvector and every migration applied, in order. */
export async function freshDb(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { vector } });
  for (const f of migrationFiles()) await db.exec(migrationSql(f));
  return db;
}

/** A 1024-dim vector literal with a single hot dimension (cosine-orthogonal across dims). */
export function unitVec(dim: number, mix?: { dim: number; w: number }): string {
  const v = new Array(1024).fill(0);
  v[dim] = 1;
  if (mix) v[mix.dim] = mix.w;
  return `[${v.join(",")}]`;
}
