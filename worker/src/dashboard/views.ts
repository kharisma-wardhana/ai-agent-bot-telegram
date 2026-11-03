/**
 * Server-rendered dashboard HTML. Every dynamic value goes through esc() (spec AC 20).
 * No JavaScript: the CSP forbids scripts. Mobile-first, Bahasa Indonesia (spec › Behaviour, AC 21).
 */
import type { FollowupView } from "../db/repository";
import type { DashUser } from "./auth";

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b1f24;--muted:#57606a;--line:#d0d7de;--brand:#0b5cad;--brand-ink:#fff;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--ink:#e6edf3;--muted:#9da7b3;--line:#30363d;--brand:#4493f8;--brand-ink:#0d1117;--ok:#3fb950;--warn:#d29922;--bad:#f85149}}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line)}
.wrap{max-width:40rem;margin:0 auto;padding:0 16px}
header .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding-top:8px;padding-bottom:8px}
h1{font-size:1.15rem;margin:0}
h2{font-size:1.05rem;margin:1.25rem 0 .5rem}
nav{display:flex;flex-wrap:wrap;gap:4px}
nav a,.link{display:inline-flex;align-items:center;min-height:44px;padding:0 12px;color:var(--brand);text-decoration:none;border-radius:8px}
nav a[aria-current=page]{background:var(--bg);font-weight:600}
main{padding-top:12px;padding-bottom:32px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:0 0 12px;overflow-wrap:anywhere}
.meta{color:var(--muted);font-size:.875rem;margin:0 0 6px}
.q{white-space:pre-wrap;margin:0 0 10px}
.badge{display:inline-block;font-size:.8rem;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid currentColor}
.s-open{color:var(--warn)}.s-claimed{color:var(--brand)}.s-closed{color:var(--ok)}
.flash{border-left:4px solid var(--brand)}.flash.bad{border-left-color:var(--bad)}
label{display:block;font-weight:600;margin:0 0 4px}
input[type=email],input[type=text],input[type=number],textarea{width:100%;min-height:44px;padding:10px 12px;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px}
textarea{min-height:8rem;resize:vertical}
.field{margin:0 0 12px}
.hint{color:var(--muted);font-size:.875rem;margin:4px 0 0}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
button{min-height:44px;min-width:44px;padding:0 16px;font:inherit;font-weight:600;border-radius:8px;border:1px solid var(--brand);background:var(--brand);color:var(--brand-ink);cursor:pointer}
button.secondary{background:transparent;color:var(--brand)}
button.danger{background:transparent;color:var(--bad);border-color:var(--bad)}
img.photo{display:block;max-width:100%;height:auto;border-radius:8px;margin:0 0 10px}
form.inline{display:inline}
.empty{color:var(--muted);text-align:center;padding:24px 0}
:focus-visible{outline:3px solid var(--brand);outline-offset:2px}
`;

export interface PageOpts { user?: DashUser; csrf?: string; current?: "aktif" | "selesai" | "mentor" }

export function page(title: string, body: string, o: PageOpts = {}): string {
  const nav = o.user
    ? `<nav aria-label="Menu">
        <a href="/dashboard"${o.current === "aktif" ? ' aria-current="page"' : ""}>Aktif</a>
        <a href="/dashboard?tab=selesai"${o.current === "selesai" ? ' aria-current="page"' : ""}>Selesai</a>
        <a href="/dashboard/mentor"${o.current === "mentor" ? ' aria-current="page"' : ""}>Mentor</a>
      </nav>`
    : "";
  const logout = o.user && o.csrf
    ? `<form method="post" action="/dashboard/logout" class="inline">${csrfField(o.csrf)}<button type="submit" class="secondary">Keluar</button></form>`
    : "";
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · Dashboard Mentor Kak Skilly</title>
<style>${CSS}</style>
</head>
<body>
<header><div class="wrap"><h1>Dashboard Mentor</h1>${nav}${logout}</div></header>
<main class="wrap">
${body}
</main>
</body>
</html>`;
}

export const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

export const LOGIN_SENT = "Kalau email terdaftar, link masuk sudah dikirim ke Telegram kamu. Link berlaku 10 menit.";

export function loginPage(sent = false): string {
  return page("Masuk", `
<h2>Masuk</h2>
${sent ? `<p class="card flash" role="status">${esc(LOGIN_SENT)}</p>` : ""}
<form method="post" action="/dashboard/login" class="card">
  <div class="field">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required>
    <p class="hint">Link masuk dikirim lewat Telegram ke akun yang terdaftar dengan email ini.</p>
  </div>
  <button type="submit">Kirim link masuk</button>
</form>`);
}

export function authConfirmPage(token: string): string {
  return page("Konfirmasi masuk", `
<h2>Masuk ke dashboard</h2>
<form method="post" action="/dashboard/auth" class="card">
  <input type="hidden" name="t" value="${esc(token)}">
  <p>Tekan tombol di bawah untuk masuk. Link ini hanya bisa dipakai sekali.</p>
  <button type="submit">Masuk</button>
</form>`);
}

export function authFailedPage(): string {
  return page("Link tidak berlaku", `
<h2>Link tidak berlaku</h2>
<p class="card flash bad" role="alert">Link masuk sudah dipakai, kedaluwarsa, atau tidak dikenal. Minta link baru.</p>
<p><a class="link" href="/dashboard/login">Minta link baru</a></p>`);
}

// ---------- Follow-up list ----------

/** Flash messages, keyed by the `pesan` query value. Unknown keys show nothing. */
export const FLASH: Record<string, { text: string; bad?: boolean }> = {
  diklaim: { text: "Pertanyaan berhasil diklaim. Kamu bisa menjawabnya sekarang." },
  "sudah-diklaim": { text: "Sudah diklaim oleh mentor lain.", bad: true },
  dilepas: { text: "Klaim dilepas. Pertanyaan kembali terbuka." },
  "bukan-klaim": { text: "Kamu tidak sedang mengklaim pertanyaan ini.", bad: true },
};

export function fmtTime(d: Date | null): string {
  if (!d) return "";
  try {
    return d.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" }) + " WIB";
  } catch {
    return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
}

const STATUS_LABEL = { open: "Terbuka", claimed: "Diklaim", closed: "Selesai" } as const;

function itemCard(f: FollowupView, me: DashUser, csrf: string): string {
  const where = f.viaDm ? "Lewat DM" : f.threadId !== null ? `Topik #${f.threadId}` : "Grup";
  const status = f.status === "claimed" ? `Diklaim oleh ${f.claimedByName ?? "mentor"}` : STATUS_LABEL[f.status];
  const photo = f.hasPhoto ? `<img class="photo" src="/dashboard/followups/${f.id}/image" alt="Gambar yang dikirim bersama pertanyaan" loading="lazy">` : "";
  const action = (path: string, label: string, cls = "") =>
    `<form method="post" action="/dashboard/followups/${f.id}/${path}" class="inline">${csrfField(csrf)}<button type="submit"${cls ? ` class="${cls}"` : ""}>${esc(label)}</button></form>`;

  let actions = "";
  if (f.status === "open") actions = `<div class="row">${action("claim", "Klaim")}</div>`;
  else if (f.status === "claimed" && f.claimedByEmail === me.email) actions = `<div class="row">${action("release", "Lepas", "secondary")}</div>`;

  return `<article class="card" id="f-${f.id}" aria-labelledby="f-${f.id}-q">
  <p class="meta">${esc(where)} · ${esc(fmtTime(f.createdAt))} · <span class="badge s-${f.status}">${esc(status)}</span></p>
  <p class="q" id="f-${f.id}-q">${esc(f.question || "(tanpa teks)")}</p>
  ${photo}
  ${actions}
</article>`;
}

export function listPage(o: { user: DashUser; csrf: string; tab: "aktif" | "selesai"; items: FollowupView[]; flash?: string; flashId?: number }): string {
  const title = o.tab === "selesai" ? "Pertanyaan selesai" : "Pertanyaan aktif";
  let flash = "";
  const f = o.flash ? FLASH[o.flash] : undefined;
  if (f) {
    const who = o.flash === "sudah-diklaim" ? o.items.find((i) => i.id === o.flashId)?.claimedByName : null;
    const text = who ? `Sudah diklaim oleh ${who}.` : f.text;
    flash = `<p class="card flash${f.bad ? " bad" : ""}" role="${f.bad ? "alert" : "status"}">${esc(text)}</p>`;
  }
  const body = o.items.length
    ? o.items.map((i) => itemCard(i, o.user, o.csrf)).join("\n")
    : `<p class="empty">${o.tab === "selesai" ? "Belum ada pertanyaan yang selesai." : "Tidak ada pertanyaan yang menunggu. 🎉"}</p>`;
  return page(title, `<h2>${esc(title)}</h2>\n${flash}\n${body}`, { user: o.user, csrf: o.csrf, current: o.tab });
}
