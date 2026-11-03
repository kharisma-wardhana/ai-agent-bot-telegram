import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDepsOverride } from "../src/deps";
import { GROUP_ID } from "./fakes/fake-telegram";
import { makeHarness, OWNER, type DashSession, type Harness } from "./fakes/harness";

// docs/mentor-followup-dashboard/spec.md AC 8, 9, 10, 11, 19, 20 at the HTTP entry point.

let h: Harness;
let owner: DashSession;
const MENTOR3 = { email: "m3@skilly.id", name: "Tiga", telegramId: 333 };

async function followup(q: string, o: { learnerId?: number; name?: string; photo?: string; visible?: boolean } = {}): Promise<number> {
  const learnerId = o.learnerId ?? 501;
  await h.repo.upsertLearner({ telegramId: learnerId, displayName: o.name ?? "Ani", username: (o.name ?? "ani").toLowerCase().replace(/\s/g, ""), started: true });
  const s = await h.repo.openSession({ learnerId, chatId: GROUP_ID, threadId: 55, messageId: 4242 });
  const id = await h.repo.addFollowupV2(s, q, [111], o.photo ?? null);
  if (o.visible === false) h.repo.followups.find((f) => f.id === id)!.visible = false;
  return id;
}

const html = async (path: string, s: DashSession) => {
  const res = await h.dash(path, { session: s });
  expect(res.status, path).toBe(200);
  return res.text();
};

beforeEach(async () => {
  h = makeHarness();
  await h.repo.addDashboardUser({ email: MENTOR3.email, displayName: MENTOR3.name, telegramId: MENTOR3.telegramId, addedByEmail: OWNER.email });
  owner = await h.login(OWNER.email, OWNER.telegramId);
});
afterEach(() => setDepsOverride(null));

describe("the list (AC 8)", () => {
  it("shows follow-ups created after the migration, newest first, and hides pre-existing ones", async () => {
    await followup("pertanyaan lama", { visible: false });
    await followup("Apa itu RAG?");
    await followup("Bedanya prompt zero-shot dan few-shot?");
    const page = await html("/dashboard", owner);
    expect(page).toContain("Apa itu RAG?");
    expect(page).not.toContain("pertanyaan lama");
    expect(page.indexOf("zero-shot")).toBeLessThan(page.indexOf("Apa itu RAG?"));
    expect(page).toContain("Topik #55");
    expect(page).toContain("Terbuka");
  });

  it("shows the empty state", async () => {
    expect(await html("/dashboard", owner)).toContain("Tidak ada pertanyaan yang menunggu");
    expect(await html("/dashboard?tab=selesai", owner)).toContain("Belum ada pertanyaan yang selesai");
  });
});

describe("no learner identity on any dashboard page (AC 9)", () => {
  it("never renders the learner's name, username, Telegram ID or a t.me link", async () => {
    const id = await followup("Kenapa model halusinasi?", { learnerId: 987654321, name: "Zulaikha Unik" });
    await h.dash(`/dashboard/followups/${id}/claim`, { form: { csrf: owner.csrf }, session: owner });
    const pages = [await html("/dashboard", owner), await html("/dashboard?tab=selesai", owner), await html(`/dashboard?pesan=diklaim&id=${id}`, owner)];
    expect(pages[0]).toContain("Kenapa model halusinasi?");
    for (const p of pages) {
      expect(p).not.toContain("987654321");
      expect(p).not.toMatch(/zulaikha/i);
      expect(p).not.toContain("t.me/");
    }
  });
});

describe("claiming (AC 10, 11)", () => {
  it("lets exactly one of two concurrent claims win; the loser is told who has it", async () => {
    const m3 = await h.login(MENTOR3.email, MENTOR3.telegramId);
    const id = await followup("Apa itu RAG?");
    const [a, b] = await Promise.all([
      h.dash(`/dashboard/followups/${id}/claim`, { form: { csrf: owner.csrf }, session: owner }),
      h.dash(`/dashboard/followups/${id}/claim`, { form: { csrf: m3.csrf }, session: m3 }),
    ]);
    const locs = [a.headers.get("Location")!, b.headers.get("Location")!];
    expect(locs.filter((l) => l.includes("pesan=diklaim&"))).toHaveLength(1);
    expect(locs.filter((l) => l.includes("pesan=sudah-diklaim"))).toHaveLength(1);
    const f = h.repo.followups[0]!;
    const winner = f.claimedByEmail === OWNER.email ? "owner" : MENTOR3.name;
    const loserSession = f.claimedByEmail === OWNER.email ? m3 : owner;
    const loserPage = await html(locs.find((l) => l.includes("sudah-diklaim"))!.replace(/#.*$/, ""), loserSession);
    expect(loserPage).toContain(`Sudah diklaim oleh ${winner}.`);
    expect(loserPage).toContain(`Diklaim oleh ${winner}`);
  });

  it("a second claim by another user changes nothing", async () => {
    const m3 = await h.login(MENTOR3.email, MENTOR3.telegramId);
    const id = await followup("Apa itu RAG?");
    await h.dash(`/dashboard/followups/${id}/claim`, { form: { csrf: owner.csrf }, session: owner });
    await h.dash(`/dashboard/followups/${id}/claim`, { form: { csrf: m3.csrf }, session: m3 });
    expect(h.repo.followups[0]!.claimedByEmail).toBe(OWNER.email);
  });

  it("the claimer can release; a non-claimer can't", async () => {
    const m3 = await h.login(MENTOR3.email, MENTOR3.telegramId);
    const id = await followup("Apa itu RAG?");
    await h.dash(`/dashboard/followups/${id}/claim`, { form: { csrf: owner.csrf }, session: owner });
    const denied = await h.dash(`/dashboard/followups/${id}/release`, { form: { csrf: m3.csrf }, session: m3 });
    expect(denied.headers.get("Location")).toContain("pesan=bukan-klaim");
    expect(h.repo.followups[0]!.status).toBe("claimed");
    const ok = await h.dash(`/dashboard/followups/${id}/release`, { form: { csrf: owner.csrf }, session: owner });
    expect(ok.headers.get("Location")).toContain("pesan=dilepas");
    expect(h.repo.followups[0]!.status).toBe("open");
  });

  it("a claim older than 24 hours shows as open and can be claimed by someone else", async () => {
    const m3 = await h.login(MENTOR3.email, MENTOR3.telegramId);
    const id = await followup("Apa itu RAG?");
    await h.dash(`/dashboard/followups/${id}/claim`, { form: { csrf: owner.csrf }, session: owner });
    h.repo.followups[0]!.claimedAt = new Date(Date.now() - 25 * 3600_000);
    const page = await html("/dashboard", m3);
    expect(page).toContain("Terbuka");
    expect(page).not.toContain("Diklaim oleh owner");
    const res = await h.dash(`/dashboard/followups/${id}/claim`, { form: { csrf: m3.csrf }, session: m3 });
    expect(res.headers.get("Location")).toContain("pesan=diklaim&");
    expect(h.repo.followups[0]!.claimedByEmail).toBe(MENTOR3.email);
  });

  it("only the claimer sees the release button; others see who claimed it", async () => {
    const m3 = await h.login(MENTOR3.email, MENTOR3.telegramId);
    const id = await followup("Apa itu RAG?");
    await h.dash(`/dashboard/followups/${id}/claim`, { form: { csrf: owner.csrf }, session: owner });
    expect(await html("/dashboard", owner)).toContain(`/dashboard/followups/${id}/release`);
    const other = await html("/dashboard", m3);
    expect(other).not.toContain(`/dashboard/followups/${id}/release`);
    expect(other).not.toContain(`/dashboard/followups/${id}/claim`);
    expect(other).toContain("Diklaim oleh owner");
  });
});

describe("image proxy (AC 19)", () => {
  it("serves the photo to a signed-in user, 401 without a session, and never exposes the bot token", async () => {
    const id = await followup("Ini error apa?", { photo: "PHOTO-9" });
    h.tg.files.set("files/PHOTO-9", new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    expect(await html("/dashboard", owner)).toContain(`src="/dashboard/followups/${id}/image"`);

    const res = await h.dash(`/dashboard/followups/${id}/image`, { session: owner, headers: { Accept: "image/*" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const headerDump = JSON.stringify([...res.headers.entries()]);
    expect(headerDump).not.toContain("TOKEN");
    expect(headerDump).not.toContain("api.telegram.org");

    expect((await h.dash(`/dashboard/followups/${id}/image`, { headers: { Accept: "image/*" } })).status).toBe(401);
  });

  it("404s for a follow-up without a photo", async () => {
    const id = await followup("tanpa gambar");
    expect((await h.dash(`/dashboard/followups/${id}/image`, { session: owner })).status).toBe(404);
  });
});

describe("escaping (AC 20)", () => {
  it("renders learner text containing markup as inert text", async () => {
    await followup(`<script>alert("x")</script><img src=x onerror=alert(1)>`);
    const page = await html("/dashboard", owner);
    expect(page).not.toContain("<script>alert");
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });
});
