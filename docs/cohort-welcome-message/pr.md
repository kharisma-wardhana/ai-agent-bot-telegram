# PR: Cohort welcome and leave notices
*Author: Kharisma Wardhana. Stage: Deploy. Written: 2026-11-03. Via /aspec:make-it-simple-v2.*

**Branch:** `feature/cohort-welcome-message` → **base:** `feature/mentor-followup-dashboard`. This is stacked, because the Sambutan page lives in the dashboard. Re-target it once the dashboard PR merges. `gh` isn't installed here, so paste this description when you open the PR.

---

## What this adds
- **Batched welcome.** People (not bots) who join the cohort group are queued. The existing 5-minute cron posts **one** plain-text welcome in the configured topic for everyone waiting, each name a `text_mention`, with 50 names per message.
  - Joining then leaving before the post means no welcome.
  - A rejoin is welcomed again.
- **Admin-editable text** on a new dashboard page, **Sambutan**:
  - a template with `{nama}` (required) and `{bot}`, ≤ 1000 characters, sent verbatim;
  - the welcome topic ID;
  - an on/off switch for welcomes and one for leave notices.

  It uses the existing dashboard login, CSRF and Origin protections.
- **Leave notices.** Every dashboard user (config owners plus added users) gets one DM: "X keluar / dikeluarkan dari grup cohort". Nothing is posted in the group, and nothing is stored.
- Joins and leaves come from `chat_member` updates and are handled in the webhook request. No new Durable Object, no `wrangler.toml` change, no new vars or secrets.

## The chain
- Intent: [`docs/cohort-welcome-message/intent.md`](intent.md)
- Spec (behaviour, architecture, 15 acceptance criteria, flagged concerns): [`spec.md`](spec.md)
- Plan (with amendments marked inline): [`plan.md`](plan.md). Progress: [`tasks.md`](tasks.md) (7/7)
- Operator setup (migration `0005`, admin rights, webhook re-registration, Sambutan): [`setup.md`](setup.md). Ops note: [`ops-tools.md`](ops-tools.md)
- Review checklist (amended): [`REVIEW.md`](../../REVIEW.md)

## Evidence
- `pnpm -C worker typecheck`: clean across all three tsconfigs.
- `pnpm -C worker test`: **223/223**. That includes the new `welcome.test.ts` (webhook + `runScheduled`), `dashboard-welcome.test.ts` and `db/welcome.test.ts`. Every existing suite still passes.
- `pnpm -C worker test:e2e`: **7/7** Playwright tests at 360 px, including the new Sambutan flow.
- `ingest` 14/14. `kaggle` 9/9 on committed code; one test fails only with the author's separate, uncommitted `DEFAULT_MODEL` edit to `serve.py`, which isn't part of this PR.
- `.claude/hooks/eval.sh`: all ok. No agent configuration changed.

## Before merging or deploying
1. Apply `db/migrations/0005_cohort_welcome.sql` **before** deploying.
2. Keep the bot a group admin and **re-register the webhook with `chat_member`** (setup.md §2). Without both, the feature silently does nothing.
3. Program owner sign-off on the flagged concerns:
   - leave notices DM a learner's name to staff;
   - the waiting list briefly holds the names of people who haven't seen the privacy notice (minutes, purged within 24 h).

## Not in this PR
Deleting join/leave service messages, DM welcomes, goodbye posts in the group, per-topic texts, and join/leave history. Merging and deploying are the owner's actions.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
