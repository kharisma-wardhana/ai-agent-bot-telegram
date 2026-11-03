import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDepsOverride } from "../src/deps";
import { runScheduled } from "../src/index";
import { DEFAULT_TEMPLATE } from "../src/welcome/welcome";
import { chatMember, GROUP_ID, learner } from "./fakes/fake-telegram";
import { makeHarness, OWNER, type DashSession, type Harness } from "./fakes/harness";

// docs/cohort-welcome-message/spec.md AC 9–12: the dashboard "Sambutan" settings page.

let h: Harness;
let owner: DashSession;
const save = (form: Record<string, string>, origin?: string | null) =>
  h.dash("/dashboard/sambutan", { form: { csrf: owner.csrf, ...form }, session: owner, origin });
const VALID = { template: "Halo {nama}, selamat datang! DM {bot} ya.", topic_id: "42", welcome_enabled: "on", leave_enabled: "on" };

beforeEach(async () => {
  h = makeHarness();
  owner = await h.login(OWNER.email, OWNER.telegramId);
});
afterEach(() => setDepsOverride(null));

describe("auth on the settings page (AC 9)", () => {
  it("redirects without a session; refuses a POST without CSRF or with a foreign Origin; nothing changes", async () => {
    const get = await h.dash("/dashboard/sambutan");
    expect(get.status).toBe(303);
    expect(get.headers.get("Location")).toBe("/dashboard/login");
    expect((await h.dash("/dashboard/sambutan", { form: { ...VALID, csrf: owner.csrf } })).status).toBe(303); // no session cookie
    expect((await h.dash("/dashboard/sambutan", { form: VALID, session: owner })).status).toBe(403);
    expect((await save(VALID, "https://evil.example")).status).toBe(403);
    expect(h.repo.welcomeSettings).toBeNull();
  });
});

describe("saving (AC 9, 10)", () => {
  it("shows the default text before anything is saved", async () => {
    const page = await (await h.dash("/dashboard/sambutan", { session: owner })).text();
    expect(page).toContain("Masih memakai teks bawaan.");
    expect(page).toContain("Selamat datang di grup cohort");
    expect(page).toContain('id="w-welcome" name="welcome_enabled" type="checkbox" value="on" checked');
    expect(DEFAULT_TEMPLATE.length).toBeLessThanOrEqual(1000);
  });

  it("stores a valid save with the editor, and the next cron welcome uses the new text and topic", async () => {
    const res = await save(VALID);
    expect(res.headers.get("Location")).toBe("/dashboard/sambutan?pesan=tersimpan");
    expect(h.repo.welcomeSettings).toMatchObject({ template: VALID.template, topicId: 42, welcomeEnabled: true, leaveEnabled: true, updatedBy: OWNER.email });
    const page = await (await h.dash("/dashboard/sambutan?pesan=tersimpan", { session: owner })).text();
    expect(page).toContain(`Terakhir disimpan oleh ${OWNER.email}`);
    expect(page).toContain("Pengaturan sambutan disimpan");

    await h.send(chatMember(learner(501, "Ani"), "left", "member"));
    await runScheduled(h.deps.env);
    const post = h.tg.sent("sendMessage").find((c) => Number(c.params.chat_id) === GROUP_ID)!;
    expect(post.params.text).toBe("Halo Ani, selamat datang! DM @skilly_test_bot ya.");
    expect(post.params.message_thread_id).toBe(42);
  });

  it("unchecked boxes switch features off; a blank topic means General", async () => {
    await save({ template: "Hai {nama}", topic_id: "" });
    expect(h.repo.welcomeSettings).toMatchObject({ topicId: null, welcomeEnabled: false, leaveEnabled: false });
  });

  it("refuses an over-long template, one without {nama}, or a non-numeric topic, and keeps the stored settings", async () => {
    await save(VALID);
    const before = { ...h.repo.welcomeSettings };
    const cases: [Record<string, string>, string][] = [
      [{ ...VALID, template: `{nama}${"x".repeat(1000)}` }, "terlalu-panjang"],
      [{ ...VALID, template: "Halo semuanya!" }, "tanpa-nama"],
      [{ ...VALID, topic_id: "abc" }, "topik-tidak-valid"],
      [{ ...VALID, topic_id: "-3" }, "topik-tidak-valid"],
    ];
    for (const [form, pesan] of cases) expect((await save(form)).headers.get("Location")).toBe(`/dashboard/sambutan?pesan=${pesan}`);
    expect(h.repo.welcomeSettings).toEqual(before);
  });
});

describe("escaping and markup (AC 11, 12)", () => {
  it("renders a saved template with markup as inert text", async () => {
    await save({ ...VALID, template: `<b>Halo</b> {nama} <script>alert(1)</script>` });
    const page = await (await h.dash("/dashboard/sambutan", { session: owner })).text();
    expect(page).not.toContain("<script>alert");
    expect(page).toContain("&lt;b&gt;Halo&lt;/b&gt; {nama} &lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("is phone-first: viewport, Indonesian, every control labelled, checkbox rows 44 px, nav link present", async () => {
    const page = await (await h.dash("/dashboard/sambutan", { session: owner })).text();
    expect(page).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(page).toContain('<html lang="id">');
    for (const [, attrs] of page.matchAll(/<(?:input|textarea)\b([^>]*)>/g)) {
      if (/type="hidden"/.test(attrs!)) continue;
      const id = /\bid="([^"]+)"/.exec(attrs!)![1];
      expect(page).toMatch(new RegExp(`<label[^>]*for="${id}"`));
    }
    expect(page).toMatch(/\.check\{[^}]*min-height:44px/);
    expect(page).toContain('<a href="/dashboard/sambutan" aria-current="page">Sambutan</a>');
  });
});
