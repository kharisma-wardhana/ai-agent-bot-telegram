import { describe, expect, it } from "vitest";
import { normalizeRows, RepositoryError, SupabaseRpc } from "../src/db/repository";

function fakeFetch(status: number, body: string, seen: Request[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("SupabaseRpc", () => {
  it("POSTs named args to /rest/v1/rpc/<fn> with the service key headers", async () => {
    const seen: Request[] = [];
    const rpc = new SupabaseRpc("https://x.supabase.co", "svc-key", fakeFetch(200, '[{"id":"a"}]', seen));
    const rows = await rpc.call("open_session", { p_learner: 1 });
    expect(rows).toEqual([{ id: "a" }]);
    const req = seen[0]!;
    expect(req.url).toBe("https://x.supabase.co/rest/v1/rpc/open_session");
    expect(req.method).toBe("POST");
    expect(req.headers.get("apikey")).toBe("svc-key");
    expect(req.headers.get("authorization")).toBe("Bearer svc-key");
    expect(await req.json()).toEqual({ p_learner: 1 });
  });

  it("throws RepositoryError with status, never leaking the key", async () => {
    const rpc = new SupabaseRpc("https://x.supabase.co", "svc-key", fakeFetch(400, '{"message":"bad arg"}'));
    const err = await rpc.call("open_session", {}).catch((e) => e);
    expect(err).toBeInstanceOf(RepositoryError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("bad arg");
    expect(err.message).not.toContain("svc-key");
  });

  it("returns [] for an empty body", async () => {
    const rpc = new SupabaseRpc("https://x", "k", fakeFetch(200, ""));
    expect(await rpc.call("mark_privacy_notice_shown", {})).toEqual([]);
  });
});

describe("normalizeRows", () => {
  it("wraps scalars and setof-scalars as rows keyed by the function name", () => {
    expect(normalizeRows("delete_learner_data", 3)).toEqual([{ delete_learner_data: 3 }]);
    expect(normalizeRows("expire_sessions", ["a", "b"])).toEqual([{ expire_sessions: "a" }, { expire_sessions: "b" }]);
    expect(normalizeRows("f", { x: 1 })).toEqual([{ x: 1 }]);
    expect(normalizeRows("f", null)).toEqual([]);
  });
});
