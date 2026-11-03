import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDepsOverride } from "../src/deps";
import { groupAsk, learner } from "./fakes/fake-telegram";
import { makeHarness, OWNER, type DashSession, type Harness } from "./fakes/harness";

// docs/mentor-followup-dashboard/spec.md › Managing mentors: AC 7 (authZ, revocation) and AC 18 (added users get DMs).

let h: Harness;
let owner: DashSession;
const add = (form: Record<string, string>, s = owner) => h.dash("/dashboard/mentor", { form: { csrf: s.csrf, ...form }, session: s });
const NEW = { name: "Mentor Tiga", email: "Tiga@Skilly.id", telegram_id: "333" };

beforeEach(async () => {
  h = makeHarness();
  owner = await h.login(OWNER.email, OWNER.telegramId);
});
afterEach(() => setDepsOverride(null));

describe("listing and adding", () => {
  it("shows the bootstrap owner as 'pemilik (config)' with no remove button", async () => {
    const page = await (await h.dash("/dashboard/mentor", { session: owner })).text();
    expect(page).toContain(OWNER.email);
    expect(page).toContain("pemilik (config)");
    expect(page).not.toContain("/remove");
  });

  it("adds a user (email normalised), who can then log in and appears with a remove button", async () => {
    const res = await add(NEW);
    expect(res.headers.get("Location")).toBe("/dashboard/mentor?pesan=ditambah");
    expect(h.repo.dashboardUsers.map((u) => [u.email, u.telegramId, u.addedByEmail])).toEqual([["tiga@skilly.id", 333, OWNER.email]]);
    const page = await (await h.dash("/dashboard/mentor", { session: owner })).text();
    expect(page).toContain("Mentor Tiga");
    expect(page).toContain(`/dashboard/mentor/${h.repo.dashboardUsers[0]!.id}/remove`);
    const m3 = await h.login("tiga@skilly.id", 333);
    expect((await h.dash("/dashboard", { session: m3 })).status).toBe(200);
  });

  it("rejects invalid input and duplicates (including an owner's email)", async () => {
    for (const bad of [{ ...NEW, name: "" }, { ...NEW, email: "nope" }, { ...NEW, telegram_id: "abc" }, { ...NEW, telegram_id: "-5" }, { ...NEW, name: "x".repeat(61) }]) {
      expect((await add(bad)).headers.get("Location")).toBe("/dashboard/mentor?pesan=tidak-valid");
    }
    await add(NEW);
    expect((await add({ ...NEW, email: "tiga@skilly.id" })).headers.get("Location")).toBe("/dashboard/mentor?pesan=sudah-ada");
    expect((await add({ ...NEW, email: OWNER.email })).headers.get("Location")).toBe("/dashboard/mentor?pesan=sudah-ada");
    expect(h.repo.dashboardUsers).toHaveLength(1);
  });

  it("an added user receives the next fallback DM (AC 18)", async () => {
    await add(NEW);
    await h.seed("Prompting", "Prompt yang baik harus jelas dan spesifik.");
    const ani = learner(501, "Ani");
    await h.send(groupAsk("#askAI resep rendang padang yang enak gimana?", { from: ani }));
    await h.drain(ani.id);
    expect(h.tg.textsIn(333).join("\n")).toContain("resep rendang");
  });
});

describe("removing (AC 7)", () => {
  it("removing an added user ends their existing session immediately and stops their logins", async () => {
    await add(NEW);
    const m3 = await h.login("tiga@skilly.id", 333);
    expect((await h.dash("/dashboard", { session: m3 })).status).toBe(200);

    const id = h.repo.dashboardUsers[0]!.id;
    expect((await h.dash(`/dashboard/mentor/${id}/remove`, { form: { csrf: owner.csrf }, session: owner })).headers.get("Location")).toBe("/dashboard/mentor?pesan=dihapus");
    expect((await h.dash("/dashboard", { session: m3 })).status).toBe(303);

    h.tg.calls = [];
    await h.dash("/dashboard/login", { form: { email: "tiga@skilly.id" } });
    expect(h.tg.sent("sendMessage")).toHaveLength(0);
  });

  it("refuses to remove a bootstrap owner (403) and changes nothing", async () => {
    const res = await h.dash("/dashboard/mentor/owner/remove", { form: { csrf: owner.csrf }, session: owner });
    expect(res.status).toBe(403);
    expect((await h.dash("/dashboard", { session: owner })).status).toBe(200);
  });

  it("any user can remove another added user; removing an unknown id reports it", async () => {
    await add(NEW);
    await add({ name: "Empat", email: "empat@skilly.id", telegram_id: "444" });
    const m4 = await h.login("empat@skilly.id", 444);
    const id3 = h.repo.dashboardUsers[0]!.id;
    expect((await h.dash(`/dashboard/mentor/${id3}/remove`, { form: { csrf: m4.csrf }, session: m4 })).headers.get("Location")).toBe("/dashboard/mentor?pesan=dihapus");
    expect((await h.dash(`/dashboard/mentor/${id3}/remove`, { form: { csrf: m4.csrf }, session: m4 })).headers.get("Location")).toBe("/dashboard/mentor?pesan=tidak-ditemukan");
  });
});

describe("authorization on mentor management", () => {
  it("without a session or without CSRF nothing is added or removed", async () => {
    expect((await h.dash("/dashboard/mentor", { form: { ...NEW, csrf: owner.csrf } })).status).toBe(303);
    expect((await h.dash("/dashboard/mentor", { form: { ...NEW }, session: owner })).status).toBe(403);
    expect(h.repo.dashboardUsers).toHaveLength(0);
    await add(NEW);
    const id = h.repo.dashboardUsers[0]!.id;
    expect((await h.dash(`/dashboard/mentor/${id}/remove`, { form: {}, session: owner })).status).toBe(403);
    expect((await h.dash(`/dashboard/mentor/${id}/remove`, { form: { csrf: owner.csrf }, session: owner, origin: "https://evil.example" })).status).toBe(403);
    expect(h.repo.dashboardUsers[0]!.removedAt).toBeNull();
  });
});
