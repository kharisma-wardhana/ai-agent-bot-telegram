import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/dashboard/auth";
import { setDepsOverride } from "../src/deps";
import { DASH_BASE, loginTokenFrom, makeHarness, OWNER, setCookies, type Harness } from "./fakes/harness";

// docs/mentor-followup-dashboard/spec.md AC 1–6: authentication and authorization at the HTTP entry point.

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => setDepsOverride(null));

const loginDms = (chatId: number) => h.tg.textsIn(chatId).filter((t) => t.includes("/dashboard/auth?t="));

describe("protected routes need a session (AC 1)", () => {
  it("redirects HTML requests to the login page and returns 401 for the image endpoint", async () => {
    for (const path of ["/dashboard", "/dashboard?tab=selesai", "/dashboard/mentor", "/dashboard/anything"]) {
      const res = await h.dash(path);
      expect(res.status, path).toBe(303);
      expect(res.headers.get("Location"), path).toBe("/dashboard/login");
    }
    expect((await h.dash("/dashboard/followups/1/image", { headers: { Accept: "image/*" } })).status).toBe(401);
    expect((await h.dash("/dashboard/followups/1/image")).status).toBe(401);
    const post = await h.dash("/dashboard/followups/1/claim", { form: { csrf: "x" } });
    expect(post.status).toBe(303);
    expect(h.repo.followups).toHaveLength(0);
  });

  it("serves the login and link pages without a session", async () => {
    expect((await h.dash("/dashboard/login")).status).toBe(200);
    expect((await h.dash("/dashboard/auth?t=abc")).status).toBe(200);
  });

  it("bounces a cross-site navigation once so the SameSite=Strict cookie can be sent", async () => {
    const res = await h.dash("/dashboard", { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('http-equiv="refresh" content="0;url=/dashboard?b=1"');
    const again = await h.dash("/dashboard?b=1", { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(again.status).toBe(303);
  });
});

describe("login link request (AC 2, 3)", () => {
  it("DMs exactly one link to a known email's Telegram ID; unknown emails get the identical response and no DM", async () => {
    const known = await h.dash("/dashboard/login", { form: { email: "  OWNER@skilly.id " } });
    const unknown = await h.dash("/dashboard/login", { form: { email: "stranger@example.com" } });
    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
    expect(loginDms(OWNER.telegramId)).toHaveLength(1);
    expect(loginDms(OWNER.telegramId)[0]).toContain(`${DASH_BASE}/dashboard/auth?t=`);
    expect(h.tg.sent("sendMessage")).toHaveLength(1);
  });

  it("sends no link preview (so Telegram doesn't fetch it)", async () => {
    await h.dash("/dashboard/login", { form: { email: OWNER.email } });
    const call = h.tg.sent("sendMessage")[0]!;
    expect((call.params.link_preview_options as { is_disabled: boolean }).is_disabled).toBe(true);
  });

  it("sends nothing for a 4th request within 15 minutes", async () => {
    for (let i = 0; i < 4; i++) await h.dash("/dashboard/login", { form: { email: OWNER.email } });
    expect(loginDms(OWNER.telegramId)).toHaveLength(3);
  });

  it("refuses a login POST from a foreign or missing Origin", async () => {
    expect((await h.dash("/dashboard/login", { form: { email: OWNER.email }, origin: "https://evil.example" })).status).toBe(403);
    expect((await h.dash("/dashboard/login", { form: { email: OWNER.email }, origin: null })).status).toBe(403);
    expect(loginDms(OWNER.telegramId)).toHaveLength(0);
  });

  it("works for an added (non-bootstrap) user too", async () => {
    await h.repo.addDashboardUser({ email: "m3@skilly.id", displayName: "Tiga", telegramId: 333, addedByEmail: OWNER.email });
    await h.dash("/dashboard/login", { form: { email: "m3@skilly.id" } });
    expect(loginDms(333)).toHaveLength(1);
  });
});

describe("consuming the link (AC 4, 5)", () => {
  async function linkFor(): Promise<string> {
    await h.dash("/dashboard/login", { form: { email: OWNER.email } });
    return loginTokenFrom(h.tg, OWNER.telegramId)!;
  }

  it("a GET of the link doesn't consume it; the POST does, once, and sets hardened cookies", async () => {
    const t = await linkFor();
    expect((await h.dash(`/dashboard/auth?t=${encodeURIComponent(t)}`)).status).toBe(200);
    expect((await h.dash(`/dashboard/auth?t=${encodeURIComponent(t)}`)).status).toBe(200);

    const res = await h.dash("/dashboard/auth", { form: { t } });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/dashboard");
    const lines = res.headers.getSetCookie();
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).toMatch(/HttpOnly/i);
      expect(l).toMatch(/Secure/i);
      expect(l).toMatch(/SameSite=Strict/i);
      expect(l).toMatch(/Path=\/dashboard/);
    }
    const second = await h.dash("/dashboard/auth", { form: { t } });
    expect(second.status).toBe(400);
    expect(second.headers.getSetCookie()).toHaveLength(0);
    expect(h.repo.dashSessions).toHaveLength(1);
  });

  it("refuses an expired link and creates no session", async () => {
    const t = await linkFor();
    h.repo.loginTokens[0]!.expiresAt = new Date(Date.now() - 1000);
    const res = await h.dash("/dashboard/auth", { form: { t } });
    expect(res.status).toBe(400);
    expect(h.repo.dashSessions).toHaveLength(0);
  });

  it("stores only hashes of the link token, the session ID and the CSRF token", async () => {
    const t = await linkFor();
    const c = setCookies(await h.dash("/dashboard/auth", { form: { t } }));
    const stored = JSON.stringify({ tokens: h.repo.loginTokens, sessions: h.repo.dashSessions });
    for (const raw of [t, c.sk_sess!, c.sk_csrf!]) expect(stored).not.toContain(raw);
    expect(h.repo.loginTokens[0]!.tokenHash).toBe(await sha256Hex(t));
    expect(h.repo.dashSessions[0]!.sessionHash).toBe(await sha256Hex(c.sk_sess!));
  });

  it("a signed-in user sees the dashboard; logout revokes the session", async () => {
    const s = await h.login(OWNER.email, OWNER.telegramId);
    const home = await h.dash("/dashboard", { session: s });
    expect(home.status).toBe(200);
    expect(home.headers.get("Cache-Control")).toBe("no-store");
    expect(home.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(home.headers.get("Referrer-Policy")).toBe("same-origin");

    expect((await h.dash("/dashboard/logout", { form: { csrf: s.csrf }, session: s })).status).toBe(303);
    expect((await h.dash("/dashboard", { session: s })).status).toBe(303);
  });
});

describe("CSRF and Origin on state-changing requests (AC 6)", () => {
  it("rejects a POST with a missing or wrong CSRF token, or a foreign Origin, with 403 and no change", async () => {
    const s = await h.login(OWNER.email, OWNER.telegramId);
    expect((await h.dash("/dashboard/logout", { form: {}, session: s })).status).toBe(403);
    expect((await h.dash("/dashboard/logout", { form: { csrf: "wrong" }, session: s })).status).toBe(403);
    expect((await h.dash("/dashboard/logout", { form: { csrf: s.csrf }, session: s, origin: "https://evil.example" })).status).toBe(403);
    expect((await h.dash("/dashboard/logout", { form: { csrf: s.csrf }, session: s, origin: null })).status).toBe(403);
    expect(h.repo.dashSessions[0]!.revokedAt).toBeNull();
    expect((await h.dash("/dashboard", { session: s })).status).toBe(200);
  });

  it("rejects a session cookie paired with another session's CSRF cookie", async () => {
    const a = await h.login(OWNER.email, OWNER.telegramId);
    h.tg.calls = [];
    h.repo.loginTokens = [];
    const b = await h.login(OWNER.email, OWNER.telegramId);
    const mixed = { ...a, cookie: `sk_sess=${a.sid}; sk_csrf=${b.csrf}`, csrf: b.csrf };
    expect((await h.dash("/dashboard", { session: mixed })).status).toBe(303);
  });
});
