import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Main dashboard flows in a real browser at 360 px (docs/mentor-followup-dashboard/plan.md › Test coverage).

const OWNER = { email: "owner@skilly.id", telegramId: 111 };

async function login(page: Page, request: APIRequestContext, email = OWNER.email, telegramId = OWNER.telegramId): Promise<void> {
  await page.goto("/dashboard/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Kirim link masuk" }).click();
  await expect(page.getByRole("status")).toContainText("Kalau email terdaftar");
  const link = await (await request.get(`/__test/login-link?chat=${telegramId}`)).text();
  expect(link).toContain("/dashboard/auth?t=");
  await page.goto(link);
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
});

test("login: an unauthenticated visit lands on the login page, the Telegram link signs in, logout signs out", async ({ page, request }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard\/login$/);

  await login(page, request);
  await expect(page.getByRole("heading", { name: "Pertanyaan aktif" })).toBeVisible();

  await page.getByRole("button", { name: "Keluar" }).click();
  await expect(page).toHaveURL(/\/dashboard\/login$/);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard\/login$/);
});

test("login: a used link can't be used twice", async ({ page, request }) => {
  await login(page, request);
  const link = await (await request.get(`/__test/login-link?chat=${OWNER.telegramId}`)).text();
  await page.context().clearCookies();
  await page.goto(link);
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page.getByRole("heading", { name: "Link tidak berlaku" })).toBeVisible();
});

test("claim: a signed-in mentor claims an open question from the list and can release it", async ({ page, request }) => {
  const { id } = await (await request.post("/__test/followup?q=Bagaimana%20cara%20kerja%20embedding%3F")).json();
  await login(page, request);
  const card = page.locator(`#f-${id}`);
  await expect(card).toContainText("Bagaimana cara kerja embedding?");
  await expect(card).toContainText("Terbuka");
  await card.getByRole("button", { name: "Klaim" }).click();
  await expect(page.getByRole("status")).toContainText("berhasil diklaim");
  await expect(page.locator(`#f-${id}`)).toContainText("Diklaim oleh owner");
  await page.locator(`#f-${id}`).getByRole("button", { name: "Lepas" }).click();
  await expect(page.locator(`#f-${id}`)).toContainText("Terbuka");
});

test("mentors: add a mentor, the new mentor can sign in, then remove them", async ({ page, request, browser }) => {
  await login(page, request);
  await page.getByRole("link", { name: "Mentor" }).click();
  await expect(page.getByText("pemilik (config)")).toBeVisible();
  await page.getByLabel("Nama").fill("Mentor Tiga");
  await page.getByLabel("Email").fill("tiga@skilly.id");
  await page.getByLabel("Telegram ID").fill("333");
  await page.getByRole("button", { name: "Tambah" }).click();
  await expect(page.getByRole("status")).toContainText("Mentor ditambahkan");

  const other = await browser.newPage({ viewport: { width: 360, height: 740 } });
  await login(other, request, "tiga@skilly.id", 333);
  await expect(other.getByRole("heading", { name: "Pertanyaan aktif" })).toBeVisible();

  await page.getByRole("button", { name: "Hapus Mentor Tiga" }).click();
  await expect(page.getByRole("status")).toContainText("Mentor dihapus");
  await other.reload();
  await expect(other).toHaveURL(/\/dashboard\/login$/);
  await other.close();
});

test("reply: claim → type a reply → Kirim delivers it and the question shows under Selesai", async ({ page, request }) => {
  const { id } = await (await request.post("/__test/followup?q=Apa%20itu%20RAG%3F&learner=501&name=Ani")).json();
  await login(page, request);
  await page.locator(`#f-${id}`).getByRole("button", { name: "Klaim" }).click();
  await page.getByLabel("Jawaban kamu").fill("RAG menggabungkan pencarian dokumen dengan model bahasa.");
  await page.getByRole("button", { name: "Kirim" }).click();

  await expect(page).toHaveURL(/tab=selesai/);
  await expect(page.getByRole("status")).toContainText("Jawaban terkirim");
  const card = page.locator(`#f-${id}`);
  await expect(card).toContainText("RAG menggabungkan pencarian dokumen");
  await expect(card).toContainText("DM ke peserta: terkirim");

  const calls = (await (await request.get("/__test/calls")).json()) as { method: string; params: Record<string, unknown> }[];
  const sends = calls.filter((c) => c.method === "sendMessage");
  expect(sends.filter((c) => c.params.chat_id === 501)).toHaveLength(1);
  expect(sends.filter((c) => c.params.chat_id === -1001234567890)).toHaveLength(1);

  // Add to knowledge: confirmation page, then the result.
  await card.getByRole("link", { name: "Tambahkan ke pengetahuan" }).click();
  await expect(page.getByRole("heading", { name: "Tambahkan ke pengetahuan?" })).toBeVisible();
  await page.getByRole("button", { name: "Ya, tambahkan" }).click();
  await expect(page.getByRole("status")).toContainText("Ditambahkan ke basis pengetahuan");
  await expect(page.locator(`#f-${id}`)).toContainText("Sudah ditambahkan ke pengetahuan");
});
