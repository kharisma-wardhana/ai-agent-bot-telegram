# Setup: mentor follow-up dashboard
*Author: Kharisma Wardhana. Stage: Build. Written: 2026-11-03. Via /aspec:make-it-simple-v2.*
*Implements: docs/mentor-followup-dashboard/plan.md, step 10*

Every step here is an **owner action** taken outside the repo. Nothing in this repository deploys itself. It builds on [the feature 1 setup](../telegram-rag-learning-companion/setup.md). The bot, Supabase and Worker must already be running. No new secrets and no new paid services are needed.

## 1. Apply the migration
Supabase → SQL editor → run `db/migrations/0004_mentor_dashboard.sql` **once**, after `0001`–`0003`.

- It only **adds** things: three tables, new columns on `mentor_followups`, and new functions.
- Every follow-up that already exists is hidden from the dashboard by design (spec AC 8).
- `add_followup` from `0003` is kept, so the previous Worker version keeps working if you roll back.

Apply the migration **before** deploying the new Worker. The new Worker calls `add_followup_v2`.

## 2. Worker config (two new `[vars]`)
Add these to `worker/wrangler.toml` `[vars]`. They are configuration, not secrets:

| Name | Value | Example |
|---|---|---|
| `DASHBOARD_OWNERS` | Bootstrap users, comma-separated `email:telegramId`. They can always sign in and can't be removed from the dashboard. | `kharisma@example.com:839537685` |
| `DASHBOARD_BASE_URL` | The Worker's public **origin** (https, no path). It's used in login links, in the dashboard link in mentor DMs, and by the `Origin` check on every form. | `https://skilly-worker.<subdomain>.workers.dev` |

- `DASHBOARD_BASE_URL` must be the exact origin the browser sees. If it's wrong, every login and form post returns 403 ("Permintaan ditolak").
- If it's left empty, the Worker falls back to the request's own origin, and the mentor DMs carry no dashboard link.
- Each owner must have pressed **Start** on the bot once, or Telegram blocks the login-link DM. The same applies to every mentor you add later.

## 3. Deploy and first login
1. `pnpm -C worker exec wrangler deploy`.
2. On your phone, open `<DASHBOARD_BASE_URL>/dashboard`, type your owner email, and tap **Kirim link masuk**.
3. The bot DMs you a link that's valid for 10 minutes and works once. Open it and tap **Masuk**. The session lasts 7 days.
4. On **Mentor**, add each mentor's name, email and **numeric** Telegram ID. One way to find a Telegram ID is the `Dari:` line of a follow-up DM, or the `from.id` of any update they send. Added mentors can sign in straight away. From the next follow-up on, they also get the follow-up DMs, which go to `MENTOR_IDS` ∪ owners ∪ added users, each person once.

## 4. Daily use (for mentors)
- **Aktif** lists open and claimed questions, newest first. Tap **Klaim**, type the reply (max. 900 characters), and tap **Kirim**.
  - The learner gets a DM. If they never started the bot, the reply is held and delivered when they press Start.
  - The reply is also posted in the original topic, tagging the learner.
- **Lepas** releases a claim. A claim with no reply lapses after 24 hours.
- **Selesai** shows the reply and its delivery status. If it shows `GAGAL`, follow up by hand in Telegram.
- **Tambahkan ke pengetahuan** adds the question and reply to the knowledge base, after a confirmation step. It **can't be undone from the dashboard**. Only add answers you want Kak Skilly to repeat, and never ones with personal data.

## 5. Verify locally (no network)
```
pnpm -C worker test          # vitest: Worker + PGlite regression
pnpm -C worker test:e2e      # Playwright: real browser at 360 px against e2e/server.ts (fakes)
pnpm -C worker typecheck
```
`pnpm -C worker exec playwright install chromium` is needed once per machine.

## 6. Rollback
- Redeploy the previous Worker version: `wrangler rollback`, or deploy the previous commit. The dashboard disappears, and follow-ups go back to DMs only.
- Leave migration `0004` applied. Nothing reads its tables without the new Worker, and the old `add_followup` function is intact.
- To fully remove the dashboard data later, write a **new** migration that drops the three `dashboard_*` tables. Never edit `0004`.
