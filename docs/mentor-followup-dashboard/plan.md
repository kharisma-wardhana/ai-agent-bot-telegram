# Plan: Mentors handle every follow-up question from one phone-friendly web dashboard, and the bot delivers their reply to the learner
*Author: Kharisma Wardhana. Stage: Build. Written: 2026-11-03. Via /aspec:make-it-simple-v2.*
*Implements: docs/mentor-followup-dashboard/spec.md*

Requirements are not restated here. Each step links to [spec.md › Acceptance criteria](spec.md#acceptance-criteria) by number.

## Affected files

**Database**
- `db/migrations/0004_mentor_dashboard.sql` (new):
  - tables `dashboard_users`, `dashboard_login_tokens` and `dashboard_sessions`
  - additive columns on `mentor_followups`, and its status check widened to `open | claimed | closed | resolved`
  - SQL functions for every new data operation
  - `add_followup_v2`, so the old `add_followup` survives for rollback

**Worker (`worker/`)**
- `worker/src/config.ts` (edit): optional `DASHBOARD_OWNERS` (`email:telegramId,…`) and `DASHBOARD_BASE_URL`, both validated.
- `worker/src/db/repository.ts` (edit): new `Repository` methods and their RPC implementations: dashboard users, login tokens, sessions, follow-up list/claim/release/close/delivery/knowledge-link, and `addFollowupV2`.
- `worker/src/telegram/client.ts` (edit): `SendOptions.entities` for a `text_mention`. Still plain text, with no `parse_mode`.
- `worker/src/pipeline/fallback.ts` (edit):
  - recipients become `MENTOR_IDS` ∪ active dashboard users, each once
  - the mentor DM gains the dashboard link
  - the photo `file_id` is stored on the follow-up
- `worker/src/knowledge/add-knowledge.ts` (edit): export the text-ingest helper, with no behaviour change.
- `worker/src/dashboard/app.ts` (new): a Hono sub-app with every `/dashboard/*` route. It doesn't import the Durable Object, so it can also run in Node for the e2e tests.
- `worker/src/dashboard/auth.ts` (new): token/session hashing, magic link, CSRF token, `Origin` check, login rate limit, the session middleware.
- `worker/src/dashboard/followups.ts` (new): list (including the lapsed-claim rule), claim, release, reply delivery, add-to-knowledge.
- `worker/src/dashboard/users.ts` (new): bootstrap and added users, add, remove (with session revocation).
- `worker/src/dashboard/views.ts` (new): HTML templates, the escape helper, mobile-first inline CSS, Bahasa Indonesia copy.
- `worker/src/index.ts` (edit): mount the dashboard sub-app at `/dashboard`.
- `worker/.dev.vars.example` (edit): add the two new var names.
- `worker/package.json` (edit): devDeps `@playwright/test`, `@hono/node-server` and `tsx`, plus the script `test:e2e`.
- `worker/playwright.config.ts` (new): runs `e2e/server.ts` as the web server and uses Chromium at a 360 px viewport.
- `worker/e2e/server.ts` (new): serves `dashboard/app.ts` in Node with an in-memory repository and a fake Telegram. No network.
- `worker/e2e/dashboard.spec.ts` (new): Playwright main flows.
- `worker/e2e/tsconfig.json` (new): Node types for the e2e folder, which runs outside the Workers runtime. The `typecheck` script in `worker/package.json` gains `tsc --noEmit -p e2e`. *(amended during build, step 4)*
- `.gitignore` (edit): ignore `worker/test-results/` and `worker/playwright-report/` (Playwright output). *(amended during build, step 4)*
- `worker/vitest.config.ts` (edit): `db` project gets `testTimeout`/`hookTimeout` of 30 s. With more test files running in parallel, booting PGlite + pgvector in `beforeEach` exceeded the 10 s default hook timeout, including in the pre-existing `schema.test.ts`. *(amended during build, step 5)*
- `worker/test/fakes/fake-repository.ts`, `worker/test/fakes/harness.ts` (edit): fake implementations of the new repository methods, the dashboard env vars, and a `dashboard()` request helper.
- `worker/test/db/dashboard.test.ts` (new): migration and SQL regression on PGlite + pgvector.
- `worker/test/dashboard-auth.test.ts`, `dashboard-followups.test.ts`, `dashboard-reply.test.ts`, `dashboard-knowledge.test.ts`, `dashboard-users.test.ts`, `dashboard-markup.test.ts`, `fallback-dashboard.test.ts` (new): integration tests at the HTTP entry point.

`worker/wrangler.toml` is **not** edited, because it holds your uncommitted local values. The owner adds the two vars there at deploy time, as documented in `setup.md`.

**Docs**
- `docs/mentor-followup-dashboard/setup.md` (new): new vars, applying migration `0004`, first login, rollback.
- `docs/index.md` (edit): link `plan.md`, `tasks.md` and `setup.md`.

## Work sequence
1. **Schema and SQL functions.** `db/migrations/0004_mentor_dashboard.sql`, `worker/test/db/dashboard.test.ts`. Advances AC 5, 8, 10, 11, 22.
2. **Repository layer.** `worker/src/db/repository.ts`, `worker/test/fakes/fake-repository.ts`; RPC cases added to `worker/test/db/dashboard.test.ts`. Advances AC 5, 10, 11 (data side).
3. **Config, Telegram mentions, fallback recipients and link.** `worker/src/config.ts`, `worker/src/telegram/client.ts`, `worker/src/pipeline/fallback.ts`, `worker/test/fakes/harness.ts`, `worker/test/fallback-dashboard.test.ts`. Advances AC 18 and AC 8 (only post-migration follow-ups listed).
4. **Dashboard skeleton and login.** `worker/src/dashboard/{app,auth,views}.ts`, `worker/src/index.ts`, `worker/test/dashboard-auth.test.ts`, `worker/package.json`, `worker/playwright.config.ts`, `worker/e2e/{server.ts,dashboard.spec.ts}` (login flow). Advances AC 1–6.
5. **Follow-up list, claim/release, image proxy.** `worker/src/dashboard/{followups,views,app}.ts`, `worker/test/dashboard-followups.test.ts`, e2e claim flow. Advances AC 8, 9, 10, 11, 19, 20.
6. **Reply delivery.** `worker/src/dashboard/followups.ts`, `worker/test/dashboard-reply.test.ts`, e2e reply flow. Advances AC 12, 13, 14, 15.
7. **Mentor management.** `worker/src/dashboard/{users,views,app}.ts`, `worker/test/dashboard-users.test.ts`, e2e add/remove flow. Advances AC 7 and AC 18 (added users receive DMs).
8. **Add to knowledge.** `worker/src/knowledge/add-knowledge.ts` (export only), `worker/src/dashboard/followups.ts`, `worker/test/dashboard-knowledge.test.ts`, e2e button. Advances AC 16, 17.
9. **Phone layout and accessibility markup.** `worker/src/dashboard/views.ts`, `worker/test/dashboard-markup.test.ts`. Advances AC 21.
10. **Operator docs.** `worker/.dev.vars.example`, `docs/mentor-followup-dashboard/setup.md`, `docs/index.md`. No AC; this is deploy readiness.

## Test coverage
These rows were matched from `test-scope-by-stage.md` against [spec › Architecture](spec.md#architecture-and-the-reason-for-it) and [spec › Data](spec.md#data):
- **Runs in a web browser with user-visible UI → Playwright e2e on the main flows.** It runs against `e2e/server.ts` (Node, fakes, no network) at a 360 px viewport.
- **Accounts/login and roles/permissions → authN + authZ integration tests.**
- **Any database → regression test** (PGlite + pgvector) whenever schema or a query changes.
- **Existing project → regression** for every pre-existing behaviour a step changes.
- **Backend entry point → integration** at the real HTTP entry (`exports.default.fetch`), in the existing workers vitest project.

| Step | Required tests |
|---|---|
| 1 | DB regression: `0004` applies on `0001`–`0003`; old rows hidden, new rows listed; concurrent `claim_followup` gives exactly one winner; a claim older than 24 h is re-claimable; only hashes are stored; existing `worker/test/db/*.test.ts` still pass. |
| 2 | DB regression: the RPC repository round-trips every new method through PGlite. Existing repository and fake-repository parity tests still pass. |
| 3 | Integration (webhook): a fallback DMs `MENTOR_IDS` ∪ dashboard users once each, with the dashboard link, and stores the `file_id`. Regression: the existing `webhook.test.ts` AC 9 case passes unchanged. |
| 4 | Auth integration (authN): unknown vs known email give identical responses; rate limit; `GET` doesn't consume the link; `POST` consumes it once; expiry; cookie flags; logout. Auth integration (authZ): every protected route without a session gives a redirect or 401; CSRF and foreign `Origin` give 403 with no change. Playwright: login via the magic link (link captured from the fake Telegram). |
| 5 | Integration: list contents and no learner identity anywhere (AC 9); claim race; release; lapse; non-claimer refused; image proxy with and without a session and no token leak; `<script>` escaped. AuthZ: only signed-in users can claim. Playwright: claim from the list. |
| 6 | Integration: started learner gets DM and topic post with mention; unstarted learner's reply is held and delivered on `/start` (regression of feature 1 AC 12); > 900 chars rejected; double submit sends once; topic failure still closes and is shown. Playwright: claim → reply → shows Selesai. |
| 7 | AuthZ integration: removing an added user revokes their sessions; a bootstrap user can't be removed; a removed user can't log in. Integration: an added user receives the next fallback DM. Playwright: add then remove a mentor. |
| 8 | Integration: one knowledge source added with `origin = add_knowledge`; retrievable above threshold; second press adds nothing; refused when not closed. Regression: existing `add-knowledge.test.ts` passes unchanged. Playwright: the button shows the confirmation and then the result. |
| 9 | Markup test of rendered HTML: viewport meta, no fixed widths over 360 px, every input has a label, tap targets ≥ 44 px in CSS. Playwright: no horizontal scroll at 360 px on the list, login and mentor pages. |
| 10 | None (docs only). `pnpm -C worker typecheck` and the full suite run once more. |

Every step finishes with `pnpm -C worker test` and `pnpm -C worker typecheck`. Steps 4–9 also run `pnpm -C worker test:e2e`. Output is pasted in Phase 4.

## Agent configuration changes
Each is shown as its own diff and needs its own `approve write` before it is written.
1. **`CLAUDE.md`, `## Test scope`: append one row.** "Web UI (`/dashboard`): Playwright e2e on the main flows, against `worker/e2e/server.ts` with fakes, no network." The existing "Backend, no UI … no e2e/Playwright" line stays. It still holds for the bot, webhook, cron and MCP. Append-only.
2. **`CLAUDE.md`, `## Commands`: the Test row gains `pnpm -C worker test:e2e`.**
3. **Hooks**: none new. `protect-paths`, `guard-tests` and `deploy-gate` are verified by re-running `.claude/hooks/eval.sh` in Phase 4. `guard-tests` will ask before each edit under `worker/test/`, which is expected here because steps 2, 3 and 5–9 add and extend test files.
4. **Subagents**: none new. `answer-quality-reviewer` doesn't apply, because no persona, prompt or length-policy change is made. Replies are relayed verbatim.
5. **CI agent-config eval job**: still deferred (no CI platform, as on feature 1).

Parallel sessions: not offered. Steps 4–9 all touch `worker/src/dashboard/app.ts` and `views.ts`.

## Rollback
- Revert the PR and redeploy the previous Worker. The Worker-side change is then gone.
- Migration `0004` can stay applied: it only adds tables, columns and functions, and keeps `add_followup` intact, so the old Worker runs unchanged against it.
- Removing the two Worker vars disables nothing else.
