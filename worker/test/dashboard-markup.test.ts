import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setDepsOverride } from "../src/deps";
import { GROUP_ID } from "./fakes/fake-telegram";
import { makeHarness, OWNER, type Harness } from "./fakes/harness";

// docs/mentor-followup-dashboard/spec.md AC 21: phone layout + accessibility, checked on the rendered HTML.
// (The no-horizontal-scroll check in a real browser is in e2e/dashboard.spec.ts.)

let h: Harness;
const pages: Record<string, string> = {};

beforeAll(async () => {
  h = makeHarness();
  const owner = await h.login(OWNER.email, OWNER.telegramId);
  await h.repo.addDashboardUser({ email: "m3@skilly.id", displayName: "Tiga", telegramId: 333, addedByEmail: OWNER.email });
  await h.repo.upsertLearner({ telegramId: 501, displayName: "Ani", username: "ani", started: true });
  const mk = async (q: string, photo: string | null = null) =>
    h.repo.addFollowupV2(await h.repo.openSession({ learnerId: 501, chatId: GROUP_ID, threadId: 55, messageId: 1 }), q, [111], photo);
  await mk("Pertanyaan terbuka dengan gambar", "P1");
  const claimed = await mk("Pertanyaan yang saya klaim");
  const closed = await mk("Pertanyaan yang sudah dijawab");
  const post = (path: string, form: Record<string, string> = {}) => h.dash(path, { form: { csrf: owner.csrf, ...form }, session: owner });
  await post(`/dashboard/followups/${closed}/claim`);
  await post(`/dashboard/followups/${closed}/reply`, { reply: "Ini jawabannya." });
  await post(`/dashboard/followups/${claimed}/claim`);

  const get = async (path: string, session = true) => (await h.dash(path, session ? { session: owner } : {})).text();
  pages.login = await get("/dashboard/login", false);
  pages.auth = await get("/dashboard/auth?t=abc", false);
  pages.aktif = await get("/dashboard");
  pages.selesai = await get("/dashboard?tab=selesai");
  pages.mentor = await get("/dashboard/mentor");
  pages.knowledge = await get(`/dashboard/followups/${closed}/knowledge`);
});
afterEach(() => setDepsOverride(null));

const css = (html: string) => /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
const rule = (sheet: string, selector: string) => new RegExp(`(^|[},])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[,{][^}]*`).exec(sheet)?.[0] ?? "";

describe("every dashboard page is phone-first and labelled (AC 21)", () => {
  it("renders the pages under test with the controls they should have", () => {
    expect(pages.aktif).toContain("<textarea");
    expect(pages.aktif).toContain("Klaim");
    expect(pages.selesai).toContain("Tambahkan ke pengetahuan");
    expect(pages.mentor).toContain("Telegram ID");
  });

  for (const name of ["login", "auth", "aktif", "selesai", "mentor", "knowledge"]) {
    it(`${name}: viewport meta, Indonesian lang, labelled controls, alt text`, () => {
      const p = pages[name]!;
      expect(p).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
      expect(p).toContain('<html lang="id">');

      const controls = [...p.matchAll(/<(input|textarea|select)\b([^>]*)>/g)].filter((m) => !/type="hidden"/.test(m[2]!));
      for (const [tag, , attrs] of controls) {
        const id = /\bid="([^"]+)"/.exec(attrs!)?.[1];
        expect(id, `${name}: ${tag} has an id`).toBeTruthy();
        expect(p, `${name}: label for #${id}`).toContain(`<label for="${id}">`);
      }
      for (const img of p.match(/<img\b[^>]*>/g) ?? []) expect(img).toMatch(/\balt="[^"]+"/);
      for (const a of p.match(/<a\b[^>]*>/g) ?? []) {
        const inNav = /<nav[\s\S]*<\/nav>/.exec(p)?.[0].includes(a) ?? false; // nav links get the 44 px rule via `nav a`
        expect(inNav || /class="link"/.test(a), `${name}: tap-target class on ${a}`).toBe(true);
      }
    });
  }

  it("CSS gives buttons, inputs and links a 44 px minimum tap target and sets no fixed width over 360 px", () => {
    const sheet = css(pages.aktif!);
    expect(rule(sheet, "button")).toMatch(/min-height:44px/);
    expect(rule(sheet, "button")).toMatch(/min-width:44px/);
    expect(rule(sheet, "input[type=email]")).toMatch(/min-height:44px/);
    expect(rule(sheet, "nav a")).toMatch(/min-height:44px/);
    expect(rule(sheet, ".link")).toMatch(/min-height:44px/);
    for (const m of sheet.matchAll(/(?<![-\w])(?:min-)?width:\s*(\d+)px/g)) expect(Number(m[1])).toBeLessThanOrEqual(360);
    expect(sheet).toMatch(/overflow-wrap:anywhere/);
    expect(sheet).toMatch(/max-width:100%/);
  });
});
