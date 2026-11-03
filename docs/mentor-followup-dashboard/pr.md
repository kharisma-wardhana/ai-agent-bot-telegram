# PR: Mentor follow-up dashboard
*Author: Kharisma Wardhana. Stage: Deploy. Written: 2026-11-03. Via /aspec:make-it-simple-v2.*

**Branch:** `feature/mentor-followup-dashboard` → **base:** `feature/telegram-rag-learning-companion`. This is stacked on feature 1, which isn't merged to `main` yet, so the diff shows only this feature. Re-target it to `main` once feature 1 merges. `gh` isn't installed here, so paste this description when you open the PR.

---

## What this adds
A web dashboard at `/dashboard`, served by the existing Worker, in Bahasa Indonesia and built for phones. On it, the owner, admins and mentors handle every #askAI question the bot couldn't answer:

- **Login with a Telegram magic link.** The user types a whitelisted email, and the bot DMs a one-time link valid for 10 minutes. Tapping "Masuk" opens a 7-day session.
- **List of follow-ups** showing the question, any image and the topic, with **no learner identity**. Status goes Terbuka → Diklaim oleh X → Selesai.
- **Claim / release.** Exactly one person wins a claim, and an unanswered claim lapses after 24 h.
- **Reply** (≤ 900 characters, sent verbatim):
  - the learner gets a DM under a Kak Skilly header, or it's held until they press Start;
  - the reply is posted in the original topic, tagging the learner with a mention;
  - the question closes;
  - a failed delivery is shown on the dashboard.
- **Add to knowledge.** After a confirmation step, the question and reply are appended once to the knowledge base, so the bot can answer that question next time. It never happens automatically.
- **Manage mentors.** Users can add and remove others. Owners from config can't be removed, and removing a user ends their sessions at once.
- **Mentor DMs.** They now go to `MENTOR_IDS` ∪ dashboard users, each person once, and include a link to the question on the dashboard.

## The chain
- Intent: [`docs/mentor-followup-dashboard/intent.md`](intent.md)
- Spec (behaviour, architecture, 22 acceptance criteria, flagged concerns): [`spec.md`](spec.md)
- Plan (files, order, test coverage, with amendments marked inline): [`plan.md`](plan.md). Progress: [`tasks.md`](tasks.md) (10/10)
- Operator setup (migration, two new vars, first login, rollback): [`setup.md`](setup.md). Ops tools (documented, not wired): [`ops-tools.md`](ops-tools.md)
- Review checklist (amended for this feature): [`REVIEW.md`](../../REVIEW.md)

## Evidence
- `pnpm -C worker typecheck`: clean across `src`/`test`, `test/db` and `e2e`.
- `pnpm -C worker test`: **188/188** (Workers runtime via Miniflare + PGlite/pgvector for SQL). The feature 1 suites pass unchanged, including the webhook AC 9 fallback and `add-knowledge`.
- `pnpm -C worker test:e2e`: **6/6** Playwright tests in Chromium at a 360 px viewport (login, single-use link, claim, mentors, layout, reply → knowledge).
- `ingest` **14/14** and `kaggle` **9/9** pytest, each run from inside its own folder.
- `.claude/hooks/eval.sh`: all assertions ok, exit 0. `pnpm audit`: no known vulnerabilities.
- The AC-by-AC results are in the Phase 4 summary. Every AC is covered by an automated test.

## Before merging
1. Apply `db/migrations/0004_mentor_dashboard.sql` in a staging Supabase project and run the setup.md §3 first-login flow on a real phone.
2. **Check the three new devDependencies are at least two weeks old** (REVIEW.md › Supply chain): `@playwright/test 1.64.1`, `@hono/node-server 2.1.5`, `tsx 4.23.15`. The publish dates couldn't be confirmed from this environment.
3. The program owner signs off on the spec's flagged concerns:
   - the dashboard departs from feature 1's "no web dashboard" scope line;
   - a Telegram `file_id` is now stored for photo questions, so the privacy notice needs updating;
   - replies are posted publicly with a mention.
4. **Known gap:** the spec's retention line "dashboard users: kept until removed + 90 days" has no purge job yet. Removed users are soft-deleted and can't sign in, but their rows stay. A follow-up intent is suggested.

## Not in this PR
Metrics on the dashboard, backfill of older follow-ups, reminders, editing a reply after it's closed, removing knowledge entries, per-role permissions, and `cohort-welcome-message` (the next chain). Merging and deploying are the owner's actions.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
