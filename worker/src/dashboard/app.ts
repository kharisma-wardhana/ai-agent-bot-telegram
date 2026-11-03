/**
 * /dashboard: the mentor follow-up dashboard (docs/mentor-followup-dashboard/spec.md).
 * Imports no Durable Object code, so the e2e server can run it in Node.
 */
import { Hono } from "hono";
import {
  clearSessionCookies, dashboardOrigin, originOk, requestLoginLink, requireSession, setSessionCookies, startSession,
  withDeps, type DashEnv,
} from "./auth";
import { authConfirmPage, authFailedPage, loginPage, page } from "./views";

export function dashboardApp(): Hono<DashEnv> {
  const app = new Hono<DashEnv>();
  app.use("*", withDeps);

  // ---------- Public: login ----------
  app.get("/login", (c) => c.html(loginPage()));

  app.post("/login", async (c) => {
    if (!originOk(c)) return c.text("Permintaan ditolak.", 403);
    const body = await c.req.parseBody();
    const email = typeof body.email === "string" ? body.email.slice(0, 254) : "";
    if (email) await requestLoginLink(c.var.deps, email, dashboardOrigin(c));
    return c.html(loginPage(true)); // identical whether or not the email is known (AC 2)
  });

  // GET never consumes the link: Telegram and in-app browsers may prefetch it (AC 4).
  app.get("/auth", (c) => c.html(authConfirmPage(c.req.query("t") ?? "")));

  app.post("/auth", async (c) => {
    if (!originOk(c)) return c.text("Permintaan ditolak.", 403);
    const body = await c.req.parseBody();
    const s = await startSession(c.var.deps, typeof body.t === "string" ? body.t : "");
    if (!s) return c.html(authFailedPage(), 400);
    setSessionCookies(c, s);
    return c.redirect("/dashboard", 303);
  });

  // ---------- Everything below needs a session ----------
  app.use("*", requireSession);

  app.post("/logout", async (c) => {
    await c.var.deps.repo.revokeDashboardSession(c.var.sessionHash);
    clearSessionCookies(c);
    return c.redirect("/dashboard/login", 303);
  });

  app.get("/", (c) =>
    c.html(page("Pertanyaan aktif", `<h2>Pertanyaan aktif</h2>`, { user: c.var.user, csrf: c.var.csrf, current: "aktif" })));

  return app;
}
