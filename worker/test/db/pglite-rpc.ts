import type { PGlite } from "@electric-sql/pglite";
import type { Row, RpcClient } from "../../src/db/repository";

/** Test RpcClient: calls the same SQL functions PostgREST would, using named-argument notation. */
export class PgliteRpc implements RpcClient {
  readonly calls: string[] = [];
  constructor(private readonly db: PGlite) {}

  async call(fn: string, args: Record<string, unknown>): Promise<Row[]> {
    if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new Error(`bad function name ${fn}`);
    this.calls.push(fn);
    const keys = Object.keys(args);
    const params = keys.map((k) => {
      const v = args[k];
      return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
    });
    const named = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
    const res = await this.db.query<Row>(`select * from ${fn}(${named})`, params);
    return res.rows;
  }
}
