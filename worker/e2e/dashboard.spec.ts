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
