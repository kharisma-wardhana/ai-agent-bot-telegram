# REVIEW.md
*Author: Kharisma Wardhana. Stage: Deploy. Written: 2026-11-02. Via /aspec:make-it-simple-v2.*
*Amended: 2026-11-03 for mentor-followup-dashboard.*

What every merge request in this repo is reviewed against, by a human or by Claude. Specific to this codebase: a Cloudflare Worker Telegram bot (`worker/`), Supabase SQL (`db/migrations/`), Python ingestion (`ingest/`) and Kaggle services (`kaggle/`).

## Passes
### Bugs
- **1000-character rule.** Every learner-facing send path ends in `composeFinal` (`worker/src/answer/length-policy.ts`) or a short constant. Any new `tg.sendMessage`/`editMessageText` to a learner carrying model text must go through it. The live preview in `ProgressMessage.render()` must keep the *whole* message ≤ `maxAnswerChars`.
- **Grounding.** No path may deliver a lesson answer when retrieval found nothing or the source list is empty (`answerQuestion` → `decide` + `sources.length === 0` guard). Image questions are not an exception. The fallback topic text is exactly `FALLBACK_TOPIC_TEXT`.
- **NOT_FOUND never shown.** The streaming hold-back in `answerQuestion` stays in place, and `modelSaysNotFound` recognises the marker at the start or end of a reply only.
- **Durable Object queue.** Handlers in `LearnerSession.handle` must catch their own errors (an alarm retry re-runs the whole queue and would double-send). Nothing may block inside `alarm()` beyond one learner's events. The `busy` flag stays a timestamp.
- **SQL ↔ repository contract.** A new repository method needs a SQL function in a *new* migration file, and the contract test in `worker/test/db/repository.test.ts` must still pass. Applied migrations are never edited.
- **Chunker parity.** A change to `ingest/src/ingest/chunker.py` or `worker/src/rag/chunker.ts` updates both, and the shared fixture test passes on both sides.
- **Async errors in cron jobs** stay isolated per job in `runScheduled`: one failing job must not stop the others.
- **Dashboard reply closes before it sends.** `replyToFollowup` (`worker/src/dashboard/followups.ts`) calls `closeFollowup`, the claimer-only conditional update, before any Telegram send, so a double submit or race can't deliver twice. The learner DM goes through `learnerReplyText` (≤ 1000 chars), and an unstarted learner or a 403 goes to `holdAnswer(..., "not_started")`.
- **One claim TTL.** The 24 h lapse is computed at read time in SQL (`dashboard_list_followups`, `dashboard_claim_followup`, `dashboard_close_followup`) and always passed in as `CLAIM_TTL_S`. Don't hard-code a second value anywhere.
- **Fake ↔ SQL parity for 0004.** `FakeRepository`'s dashboard methods mirror the SQL semantics, as covered by `test/fake-repository.test.ts` and `test/db/dashboard.test.ts`. Change both together.

### Security
- **Secrets.** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `SUPABASE_SERVICE_KEY`, `KAGGLE_SHARED_SECRET`, `MCP_TOKENS` and the Kaggle-only R2/Cloudflare/tunnel tokens appear only as names (wrangler secrets, Kaggle secrets, `.dev.vars.example`). Never as values in code, tests, logs or error messages. `TelegramError` and `RepositoryError` must not include URLs, because the Telegram URL contains the token.
- **Auth on every entry point.** `POST /telegram/webhook` checks the secret-token header with `safeEqual`. `POST /mcp` checks a bearer token from `MCP_TOKENS`. The Kaggle proxy checks `X-Skilly-Secret` with `hmac.compare_digest` and exposes only `/v1/chat/completions` and `/health`. vLLM binds to `127.0.0.1`. A new route without one of these checks is a blocker.
- **Authorization.** `/add_knowledge` stays limited to `KNOWLEDGE_WHITELIST_IDS`. `/hapusdata` and `recall_memory` act only on the caller's own learner ID, taken from context and never from model output or tool arguments. The one exception is MCP `recall_memory` for authenticated mentors.
- **Prompt injection.** All untrusted text (learner input, retrieved chunks, memory notes, history, tool results, compression drafts) goes inside a data tag through `sanitizeData` (`worker/src/answer/prompts.ts`). New tags are added to `TAGS`. New tools have a fixed allow-list entry in `TOOL_DEFS`, validate their arguments, and any side effect is rate-limited like `escalate_to_mentor`.
- **Telegram output** is plain text (no `parse_mode`), so model or learner text can't inject markup or links styled as buttons.
- **Supply chain.** New npm/Python dependencies pin a version at least two weeks old (`uv` uses `exclude-newer`). pnpm build scripts stay limited to `allowBuilds` (esbuild, workerd). Exceptions are per package, documented with a reason, and only for security fixes. **Current exception:** `pypdf>=6.21.4` (`exclude-newer-package` in `ingest/` and `kaggle/`, 2026-11-02) because 6.21.1 had 10 DoS advisories in the PDF parser that handles mentor uploads. Remove the per-package override once the general cutoff passes that release.
- **Dependency audit clean before merge:** `pnpm audit` and `uv audit --project {ingest,kaggle,eval}` (see `docs/telegram-rag-learning-companion/monitoring.md`).
- **Dashboard auth.** Every `/dashboard/*` route except `GET/POST /login` and `GET/POST /auth` sits behind `requireSession`, which checks a live session, an active user and, on POST, the CSRF token plus `Origin`. A route registered above `app.use("*", requireSession)` in `dashboard/app.ts` is a **blocker** unless it is a deliberate public route.
- **Tokens.** Only SHA-256 hashes of login tokens, session IDs and CSRF tokens are stored. A login link is consumed only by POST, never by GET (link prefetch). The login response is identical for known and unknown emails.
- **No learner identity on the dashboard.** `FollowupView` and `dashboard_list_followups` carry no learner name, username, Telegram ID or message link. Adding one is a blocker.
- **Output escaping and CSP.** All dynamic HTML goes through `esc()` in `dashboard/views.ts`. The CSP forbids scripts, so adding JavaScript means changing the CSP, which needs a reviewer. Keep `Referrer-Policy: same-origin`, because `no-referrer` makes browsers send `Origin: null` and breaks every form.
- **Image proxy** streams bytes through the Worker and never redirects to a Telegram file URL, because that URL contains the bot token.
- **Mentions** use `entities` (`text_mention`), never `parse_mode`.

### Compliance
- **Personal data (UU PDP).** No raw audio or image bytes are persisted (R2 holds only mentor-uploaded course files). New learner data goes into tables that cascade from `learners`, so `delete_learner_data` still removes it. Retention (cohort + 90 days) is unchanged unless the program owner signs off.
- **Privacy notice** is still sent once, before or with the first DM, and still mentions `/hapusdata`.
- **Course material.** `lesson-docs/` stays append-only through `/add_knowledge` and the seed. It is not pushed to a public remote until the program owner confirms the IBM SkillBuild content terms (spec › Flagged concerns).
- **Free tier only.** No change may add a paid API, a paid plan dependency or a non-Qwen answer model.
- **Photo follow-ups store a Telegram `file_id`** (`mentor_followups.photo_file_id`). This is a reference, not bytes, but the privacy notice should say so once the program owner signs off.
- **Add-to-knowledge is person-triggered only.** Nothing may call `addFollowupToKnowledge` automatically.
- **Staff data.** `dashboard_users` holds staff emails and Telegram IDs. The spec sets retention at removal + 90 days, but **no purge job exists yet** (accepted debt, tracked as a follow-up).

## Severity levels
| Level | Meaning | Action |
|---|---|---|
| **Blocker** | Secret exposure, an unauthenticated route, a learner message that can exceed 1000 chars, an ungrounded/unsourced answer path, personal data kept beyond policy, an edited applied migration | Must be fixed before merge |
| **Major** | Missing test for changed behaviour, broken chunker parity, unhandled error in a DO handler or cron job, a prompt path that skips `sanitizeData` | Fix before merge unless a human records why not |
| **Minor** | Naming, duplication, small perf issues, unclear learner wording | Comment; merge allowed |
| **Info** | Suggestions and follow-ups | Comment only |

## Exclusions
- `pnpm-lock.yaml`, `*/uv.lock`, `node_modules/`, `.wrangler/`: generated.
- `lesson-docs/` content and `lesson-docs/*_files/`: third-party course material, reviewed for licensing by the program owner, not for code quality.
- `ingest/tests/fixtures/chunk_case.json`: generated by the Python chunker. Review the generator change, not the JSON.
- `kaggle/notebook.ipynb` cell outputs (there should be none committed).
- Indonesian wording style in learner strings, unless it breaks the persona rules ("kamu", never "Anda"/"lu").
- Accepted debt: Workers AI and Hugging Face model IDs are unverified until first deploy (setup.md §8). The CI agent-config eval is deferred (no CI).
- `worker/e2e/server.ts` `/__test/*` routes are test-only. Review only that nothing under `worker/src/` imports from `worker/e2e/` or `worker/test/`.
- Dashboard CSS/visual styling, beyond the 44 px tap targets and the no-horizontal-scroll rule.
- Accepted debt: the publish age of `@playwright/test`, `@hono/node-server` and `tsx` was not verified from the build environment (see the `pr.md` checklist).

## What a human must decide
- Whether a change to `RETRIEVAL_THRESHOLD`, the prompt rules or the skill packs is worth its effect on the live eval numbers (AC 4, 6, 8, 21). Claude reports the numbers; a human chooses the trade-off.
- Anything touching personal data scope, retention or the privacy notice (program owner).
- Use of the IBM SkillBuild brand or course content outside the cohort (program owner).
- Whether running on Kaggle stays acceptable under Kaggle's terms, and when to move to paid hosting (project owner).
- Merging, deploying and rolling back: always a human action. See `docs/telegram-rag-learning-companion/setup.md` and `ops-tools.md`.
- **Organisation responsibilities not configured from this repo:** OS-level sandboxing for agent sessions, network/domain allowlisting, and credential isolation (managed Claude Code settings, Cloudflare/Supabase/Kaggle account access). These belong to whoever administers the accounts. The hooks and deny-list in `.claude/settings.json` are defence in depth, not a substitute.
