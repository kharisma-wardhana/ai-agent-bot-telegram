/**
 * Dashboard authentication: Telegram magic link → hashed session cookie, CSRF token, Origin check.
 * docs/mentor-followup-dashboard/spec.md › Logging in, AC 1–7.
 */
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "../config";
import { getDeps, type Deps } from "../deps";

export const SESSION_COOKIE = "sk_sess";
export const CSRF_COOKIE = "sk_csrf";
export const LOGIN_TTL_S = 10 * 60;
export const SESSION_TTL_S = 7 * 24 * 3600;
export const LOGIN_MAX = 3;
export const LOGIN_WINDOW_S = 15 * 60;
export const CLAIM_TTL_S = 24 * 3600;
const COOKIE_PATH = "/dashboard";

/** A signed-in dashboard user. Bootstrap users come from config and have no DB id. */
export interface DashUser { email: string; displayName: string; telegramId: number; bootstrap: boolean; id: number | null }

export type DashEnv = { Bindings: Env; Variables: { deps: Deps; user: DashUser; csrf: string; sessionHash: string } };

/** 256-bit random token, base64url. */
export function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const normEmail = (e: string) => e.trim().toLowerCase();

/** Active user for an email: config owners first, then added users. */
export async function findActiveUser(d: Deps, email: string): Promise<DashUser | null> {
  const e = normEmail(email);
  const owner = d.cfg.dashboardOwners.find((o) => o.email === e);
  if (owner) return { email: owner.email, displayName: owner.displayName, telegramId: owner.telegramId, bootstrap: true, id: null };
  const u = (await d.repo.listDashboardUsers()).find((x) => x.email === e);
  return u ? { email: u.email, displayName: u.displayName, telegramId: u.telegramId, bootstrap: false, id: u.id } : null;
}

export const LOGIN_DM = (url: string) =>
  `🔐 Link masuk dashboard mentor Kak Skilly (berlaku 10 menit, sekali pakai):\n${url}\n\nBuka link, lalu tekan "Masuk". Abaikan pesan ini kalau kamu tidak meminta.`;

/** The public origin dashboard links and the Origin check use. */
export function dashboardOrigin(c: Context<DashEnv>): string {
  return c.var.deps.cfg.dashboardBaseUrl ?? new URL(c.req.url).origin;
}

/**
 * Sends a login link if the email belongs to an active user and the rate limit allows.
 * Always resolves the same way so the caller's response can't reveal whether the email is known (AC 2, 3).
 */
export async function requestLoginLink(d: Deps, email: string, origin: string): Promise<void> {
  const user = await findActiveUser(d, email);
  if (!user) return;
  const token = randomToken();
  const issued = await d.repo.issueLoginToken(user.email, await sha256Hex(token), LOGIN_TTL_S, LOGIN_MAX, LOGIN_WINDOW_S);
  if (!issued) return;
  try {
    await d.tg.sendMessage(user.telegramId, LOGIN_DM(`${origin}/dashboard/auth?t=${encodeURIComponent(token)}`));
  } catch (e) {
    console.error("login link DM failed", (e as Error).message);
  }
}

/** Consumes a login link (once) and opens a session. Null when the link is invalid or the user was removed. */
export async function startSession(d: Deps, token: string): Promise<{ sid: string; csrf: string } | null> {
  if (!token || token.length > 200) return null;
  const email = await d.repo.consumeLoginToken(await sha256Hex(token));
  if (!email || !(await findActiveUser(d, email))) return null;
  const sid = randomToken();
  const csrf = randomToken();
  await d.repo.createDashboardSession(await sha256Hex(sid), await sha256Hex(csrf), email, SESSION_TTL_S);
  return { sid, csrf };
}

export function setSessionCookies(c: Context<DashEnv>, s: { sid: string; csrf: string }): void {
  const o = { path: COOKIE_PATH, httpOnly: true, secure: true, sameSite: "Strict" as const, maxAge: SESSION_TTL_S };
  setCookie(c, SESSION_COOKIE, s.sid, o);
  setCookie(c, CSRF_COOKIE, s.csrf, o);
}

export function clearSessionCookies(c: Context<DashEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: COOKIE_PATH, secure: true });
  deleteCookie(c, CSRF_COOKIE, { path: COOKIE_PATH, secure: true });
}

/** POSTs must come from our own origin (AC 6). A missing Origin header is refused. */
export function originOk(c: Context<DashEnv>): boolean {
  const o = c.req.header("Origin");
  return !!o && o === dashboardOrigin(c);
}

/** Puts Deps on the context and sets the security headers every dashboard response carries. */
export const withDeps: MiddlewareHandler<DashEnv> = async (c, next) => {
  c.set("deps", getDeps(c.env));
  await next();
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "same-origin"); // not no-referrer: that makes browsers send "Origin: null" on our own form posts
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
};

/** Shown once when a cross-site navigation (e.g. a link tapped in Telegram) arrives without the Strict cookie. */
const BOUNCE = (url: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="0;url=${url}"><title>Memuat…</title><p>Memuat dashboard…</p>`;

function unauthenticated(c: Context<DashEnv>): Response {
  const wantsHtml = c.req.method === "POST" || (c.req.header("Accept") ?? "text/html").includes("text/html");
  if (c.req.path.endsWith("/image") || !wantsHtml) return c.text("unauthorized", 401);
  // SameSite=Strict cookies aren't sent on a cross-site navigation; one same-site re-navigation picks them up.
  const url = new URL(c.req.url);
  if (c.req.method === "GET" && c.req.header("Sec-Fetch-Site") === "cross-site" && !url.searchParams.has("b")) {
    url.searchParams.set("b", "1");
    const target = (url.pathname + url.search).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    return c.html(BOUNCE(target));
  }
  return c.redirect("/dashboard/login", 303);
}

/** Requires a live session for an active user (AC 1, 7), and a valid CSRF token + Origin on POST (AC 6). */
export const requireSession: MiddlewareHandler<DashEnv> = async (c, next) => {
  const d = c.var.deps;
  const sid = getCookie(c, SESSION_COOKIE);
  const csrf = getCookie(c, CSRF_COOKIE);
  if (!sid || !csrf) return unauthenticated(c);
  const sessionHash = await sha256Hex(sid);
  const session = await d.repo.getDashboardSession(sessionHash);
  if (!session || session.csrfHash !== (await sha256Hex(csrf))) return unauthenticated(c);
  const user = await findActiveUser(d, session.email);
  if (!user) return unauthenticated(c);

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    if (!originOk(c) || typeof body.csrf !== "string" || (await sha256Hex(body.csrf)) !== session.csrfHash) {
      return c.text("Permintaan ditolak.", 403);
    }
  }
  c.set("user", user);
  c.set("csrf", csrf);
  c.set("sessionHash", sessionHash);
  await next();
};
