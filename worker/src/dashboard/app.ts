/**
 * /dashboard: the mentor follow-up dashboard (docs/mentor-followup-dashboard/spec.md).
 * Imports no Durable Object code, so the e2e server can run it in Node.
 */
import { Hono } from "hono";
import {
  clearSessionCookies, dashboardOrigin, originOk, requestLoginLink, requireSession, setSessionCookies, startSession,
  withDeps, type DashEnv,
} from "./auth";
import { claimFollowup, followupImage, listFollowups, releaseFollowup, replyToFollowup } from "./followups";
import { addUser, listUsers, removeUser } from "./users";
import { authConfirmPage, authFailedPage, listPage, loginPage, mentorPage } from "./views";

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

  // ---------- Follow-up list (AC 8, 9) ----------
  app.get("/", async (c) => {
    const tab = c.req.query("tab") === "selesai" ? "selesai" : "aktif";
    const items = await listFollowups(c.var.deps, tab === "selesai" ? "closed" : "active");
    const flashId = Number(c.req.query("id"));
    return c.html(listPage({ user: c.var.user, csrf: c.var.csrf, tab, items, flash: c.req.query("pesan"), flashId: Number.isFinite(flashId) ? flashId : undefined }));
  });

  const back = (pesan: string, id: number, tab = "") => `/dashboard?${tab ? `tab=${tab}&` : ""}pesan=${pesan}&id=${id}#f-${id}`;

  // ---------- Claim / release (AC 10, 11) ----------
  app.post("/followups/:id{[0-9]+}/claim", async (c) => {
    const id = Number(c.req.param("id"));
    const r = await claimFollowup(c.var.deps, c.var.user, id);
    return c.redirect(back(r.claimed ? "diklaim" : "sudah-diklaim", id), 303);
  });

  app.post("/followups/:id{[0-9]+}/release", async (c) => {
    const id = Number(c.req.param("id"));
    const ok = await releaseFollowup(c.var.deps, c.var.user, id);
    return c.redirect(back(ok ? "dilepas" : "bukan-klaim", id), 303);
  });

  // ---------- Reply (AC 12–15) ----------
  app.post("/followups/:id{[0-9]+}/reply", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.parseBody();
    const r = await replyToFollowup(c.var.deps, c.var.user, id, typeof body.reply === "string" ? body.reply : "");
    if (r.kind !== "delivered") {
      const why = { empty: "kosong", "too-long": "terlalu-panjang", "not-claimer": "bukan-klaim" } as const;
      return c.redirect(back(why[r.kind], id), 303);
    }
    const pesan = r.dm === "failed" || r.topic === "failed" ? "gagal-sebagian" : r.dm === "held" ? "ditahan" : "terkirim";
    return c.redirect(back(pesan, id, "selesai"), 303);
  });

  // ---------- Mentor management (AC 7, 18) ----------
  app.get("/mentor", async (c) =>
    c.html(mentorPage({ user: c.var.user, csrf: c.var.csrf, users: await listUsers(c.var.deps), flash: c.req.query("pesan") })));

  app.post("/mentor", async (c) => {
    const b = await c.req.parseBody();
    const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
    const r = await addUser(c.var.deps, c.var.user, { name: s("name"), email: s("email"), telegramId: s("telegram_id") });
    const pesan = { added: "ditambah", exists: "sudah-ada", invalid: "tidak-valid" }[r];
    return c.redirect(`/dashboard/mentor?pesan=${pesan}`, 303);
  });

  app.post("/mentor/:key/remove", async (c) => {
    const key = c.req.param("key");
    if (!/^[0-9]+$/.test(key)) return c.text("Pemilik (config) tidak bisa dihapus dari dashboard.", 403);
    const ok = await removeUser(c.var.deps, Number(key));
    return c.redirect(`/dashboard/mentor?pesan=${ok ? "dihapus" : "tidak-ditemukan"}`, 303);
  });

  // ---------- Image proxy (AC 19) ----------
  app.get("/followups/:id{[0-9]+}/image", async (c) => {
    const img = await followupImage(c.var.deps, Number(c.req.param("id")));
    if (!img) return c.text("not found", 404);
    return c.body(img.bytes, 200, { "Content-Type": img.type });
  });

  return app;
}
