# Plan: New cohort members are welcomed automatically in the group with an admin-editable message, and dashboard users are told when someone leaves
*Author: Kharisma Wardhana. Stage: Build. Written: 2026-11-03. Via /aspec:make-it-simple-v2.*
*Implements: docs/cohort-welcome-message/spec.md*

Requirements are not restated here. Each step links to [spec.md › Acceptance criteria](spec.md#acceptance-criteria) by number.

## Affected files

**Database**
- `db/migrations/0005_cohort_welcome.sql` (new):
  - tables `welcome_settings` (a single row) and `pending_welcomes`
  - functions `get_welcome_settings`, `save_welcome_settings`, `queue_welcome` (which also purges rows older than 24 h), `unqueue_welcome` and `take_pending_welcomes` (atomic delete-returning)

**Worker (`worker/`)**
- `worker/src/telegram/types.ts` (edit): `TgChatMemberUpdated`, plus `chat_member` on `TgUpdate`.
- `worker/src/telegram/parse-update.ts` (edit): `classify` returns `member_join` / `member_leave` for `chat_member` updates in the cohort group, and ignores bots and other chats. Message handling is unchanged.
- `worker/src/db/repository.ts` (edit): the welcome repository methods and their RPC implementations.
- `worker/src/welcome/welcome.ts` (new):
  - default template, template validation and rendering (Indonesian name list, `text_mention` offsets, splitting at 50)
  - the join/leave handlers and the dashboard-user recipient helper for leave notices
  - the cron job `postPendingWelcomes`
- `worker/src/index.ts` (edit): the webhook routes `member_join`/`member_leave` to the welcome handlers instead of the learner Durable Object, and `runScheduled` gains the isolated `welcome batch` job.
- `worker/src/dashboard/app.ts`, `worker/src/dashboard/views.ts` (edit): `GET/POST /dashboard/sambutan`, plus the nav link.
- `worker/test/fakes/fake-repository.ts` (edit): fake welcome methods mirroring `0005`.
- `worker/test/fakes/fake-telegram.ts` (edit): a `chatMember(...)` update fixture builder.
- `worker/test/db/welcome.test.ts` (new): migration and SQL regression.
- `worker/test/db/schema.test.ts` (edit): the table list gains `pending_welcomes` and `welcome_settings`.
- `worker/test/db/dashboard.test.ts` (edit): feature 2's "0004 is the newest migration" assertion becomes "0004 is present". It could only ever hold until the next migration existed. *(amended during build, step 1)*
- `worker/test/welcome.test.ts` (new): integration at the webhook and at `runScheduled`.
- `worker/test/dashboard-welcome.test.ts` (new): settings page authN/authZ, validation, escaping and markup.
- `worker/test/telegram.test.ts` (edit): `classify` cases for `chat_member`, and a regression case for service messages.
- `worker/test/fake-repository.test.ts` (edit): a parity case for the welcome methods.
- `worker/e2e/dashboard.spec.ts` (edit): a Sambutan flow at 360 px.
- `worker/test/dashboard-markup.test.ts` (edit): feature 2's tap-target check listed the nav hrefs one by one. It now accepts any anchor inside `<nav>`, which the new "Sambutan" link needs. *(amended during build, step 6)*

`worker/wrangler.toml` is **not** edited. No new vars, bindings or Durable Objects are needed.

**Docs**
- `docs/cohort-welcome-message/setup.md` (new): migration `0005`, bot admin rights, webhook re-registration with `chat_member`, first configuration, rollback.
- `docs/index.md` (edit): link `plan.md`, `tasks.md` and `setup.md`.

## Work sequence
1. **Schema and SQL functions.** `db/migrations/0005_cohort_welcome.sql`, `worker/test/db/welcome.test.ts`, and the table list in `worker/test/db/schema.test.ts` (edit). Advances AC 13.
2. **Repository layer.** `worker/src/db/repository.ts`, `worker/test/fakes/fake-repository.ts`, `worker/test/fake-repository.test.ts`, plus RPC cases in `worker/test/db/welcome.test.ts`. Advances AC 13.
3. **Parsing `chat_member` updates.** `worker/src/telegram/types.ts`, `worker/src/telegram/parse-update.ts`, `worker/test/fakes/fake-telegram.ts`, `worker/test/telegram.test.ts`. Advances AC 1, 2, 14.
4. **Join and leave handling in the webhook.** `worker/src/welcome/welcome.ts` (handlers, recipients), `worker/src/index.ts` (routing), `worker/test/welcome.test.ts`. Advances AC 1, 2, 5, 6, 7.
5. **The welcome cron job.** `worker/src/welcome/welcome.ts` (rendering, batching, posting), `worker/src/index.ts` (`runScheduled`), `worker/test/welcome.test.ts`. Advances AC 3, 4, 5, 7, 8, 11 (send side), 15.
6. **Dashboard Sambutan page.** `worker/src/dashboard/app.ts`, `worker/src/dashboard/views.ts`, `worker/test/dashboard-welcome.test.ts`, `worker/e2e/dashboard.spec.ts`. Advances AC 9, 10, 11 (render side), 12.
7. **Operator docs.** `docs/cohort-welcome-message/setup.md`, `docs/index.md`. No AC; this is deploy readiness.

## Test coverage
These rows were matched from `test-scope-by-stage.md` against [spec › Architecture](spec.md#architecture-and-the-reason-for-it) and [spec › Data](spec.md#data):
- **Web UI → Playwright e2e** on the main flow (Sambutan page).
- **Accounts/roles → authN + authZ integration** (the Sambutan route).
- **Database → regression** (PGlite + pgvector).
- **Existing project → regression** for every changed behaviour: `classify`, the webhook routing, `runScheduled`, the dashboard nav.
- **Backend entry point → integration** at the webhook and at `runScheduled`.

| Step | Required tests |
|---|---|
| 1 | DB regression: `0005` applies on `0001`–`0004`; `take_pending_welcomes` returns each row once across two calls; `queue_welcome` is idempotent per user and purges rows older than 24 h; settings save/load; the existing `test/db/*` still pass. |
| 2 | DB regression: the RPC repository round-trips every welcome method through PGlite, and the repository↔migration contract test still passes. Parity: a fake-repository case. |
| 3 | Unit plus regression on `classify`: join and leave transitions in the cohort group; bots ignored; other chats ignored; a `message` with `new_chat_members` and no `#askAI` still gives `ignore` (feature 1, AC 1). The existing `telegram.test.ts` cases pass unchanged. |
| 4 | Integration at `POST /telegram/webhook` (real entry point): a join is queued with nothing sent; a leave DMs each dashboard user once and no `MENTOR_IDS`-only user; `kicked` vs `left` wording; switches off → no queue / no DM; join then leave → unqueued. Regression: `webhook.test.ts` passes unchanged. |
| 5 | Integration at `runScheduled` (real cron entry point): N ≤ 50 → one message with correct entities, topic and template, with no `parse_mode`; 51 → two messages; empty → none; the default template is used when nothing is saved; a rejoin after a welcome is welcomed again; the welcome job throwing still lets the other jobs run. Regression: `memory.test.ts` / `multimodal.test.ts` cron cases pass unchanged. |
| 6 | AuthN/authZ integration: no session → redirect; no CSRF or a foreign `Origin` → 403 with no change. Integration: a valid save is stored with the editor, and an invalid template or topic is refused unchanged; `<script>` is escaped. Markup: labels, 44 px, viewport. Playwright: edit and save the template, no horizontal scroll at 360 px. Regression: the existing dashboard suites and e2e pass. |
| 7 | None (docs only). A final full run of `pnpm -C worker typecheck`, `test` and `test:e2e`. |

Every step finishes with `pnpm -C worker test` and `pnpm -C worker typecheck`. Step 6 also runs `pnpm -C worker test:e2e`. Output is pasted in Phase 4.

## Agent configuration changes
- **`CLAUDE.md`:** none. Its existing Test scope rows (backend entry points, web UI Playwright, roles, database) already cover this feature. `## Common mistakes` stays as it is. The pytest-from-root note offered at feature 2's tests gate is still pending your decision.
- **Hooks:** none new. Phase 4 re-runs `.claude/hooks/eval.sh`. `guard-tests` will ask before each test-file edit, as expected.
- **Subagents:** none new. `answer-quality-reviewer` doesn't apply, because no persona, prompt or length-policy code changes. The welcome is an admin template, not model output.
- **CI:** still deferred (no CI platform).

Parallel sessions: not offered. Steps 4 and 5 share `welcome.ts` and `index.ts`.

## Rollback
- Revert the PR and redeploy the previous Worker. The `chat_member` updates are then classified as `ignore` by the old code (an unknown update shape), so nothing is posted.
- Migration `0005` can stay applied. It only adds two tables and their functions.
- Optionally, re-register the webhook without `chat_member`.
