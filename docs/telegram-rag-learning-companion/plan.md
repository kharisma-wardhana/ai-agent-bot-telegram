# Plan: Learners get fast, grounded answers to #askAI questions in Telegram, and unanswerable ones reach a mentor
*Author: Kharisma Wardhana. Stage: Build. Written: 2026-11-02. Via /aspec:make-it-simple-v2.*
*Implements: docs/telegram-rag-learning-companion/spec.md*

Built as vertical slices (user decision, Phase 3): each slice leaves the bot usable up to that point. Requirements are not restated here. Each step links to [spec.md › Acceptance criteria](spec.md#acceptance-criteria) by number.

## Affected files
All paths are new (empty repo).

**Repo root**
- `.gitignore`: node_modules, `.dev.vars`, `.env*`, `__pycache__`, `.venv`, `lesson-docs/*_files/` (saved-page assets)
- `package.json`, `pnpm-workspace.yaml`: pnpm workspace with `worker`

**Database**
- `db/migrations/0001_init.sql`: extensions (`vector`), all tables from [spec › Data](spec.md#data)
- `db/migrations/0002_functions.sql`: `match_chunks`, `delete_learner_data`, `expire_sessions`, `claim_ingest_job`, view `answer_source_ratio`
- `db/migrations/0003_repository_rpc.sql`: every remaining data operation as a SQL function, so PostgREST (prod) and PGlite (tests) run identical SQL *(amended during build, step 3)*

**Cloudflare Worker (`worker/`)**
- `worker/package.json`, `worker/tsconfig.json`, `worker/wrangler.toml` (DO, AI, R2 bindings; cron), `worker/vitest.config.ts` (workers-pool project + node project for DB tests), `worker/.dev.vars.example` (names only, no values)
- `worker/src/index.ts`: Hono app: `POST /telegram/webhook`, `POST /mcp`, `scheduled()` cron, DO export
- `worker/src/config.ts`: env parsing (group ID, mentor IDs, whitelist, thresholds)
- `worker/src/deps.ts`: builds repo/Telegram/router/embedder from env; test seam to inject fakes *(amended during build, step 8)*
- `worker/src/db/repository.ts`: repository interface + Supabase REST/RPC implementation
- `worker/src/llm/types.ts`, `sse.ts` *(amended, step 4: shared SSE + tool-call assembly)*, `kaggle.ts`, `workers-ai.ts`, `router.ts`: OpenAI-compatible chat (stream + tools), heartbeat-based routing, embeddings (bge-m3)
- `worker/src/rag/chunker.ts`, `retrieve.ts`, `grounding.ts`: text chunking, vector search, NOT_FOUND decision
- `worker/src/answer/length-policy.ts`, `persona.ts`, `prompts.ts`: 1000-char enforcement, Kak Skilly system prompt, prompt assembly with retrieved text wrapped as data
- `worker/src/telegram/types.ts`, `client.ts`, `parse-update.ts`, `progress.ts`: Bot API calls, update classification (#askAI / command / feedback / reaction / start-deeplink), staged progress + throttled streaming
- `worker/src/pipeline/learner-session.ts`: Durable Object (per learner): pipeline runner, held answers, 24 h alarm
- `worker/src/pipeline/ask-pipeline.ts`: stages: media → retrieve → generate (tool loop) → enforce length → deliver
- `worker/src/pipeline/fallback.ts`: topic notice + mentor DMs
- `worker/src/knowledge/add-knowledge.ts`: whitelist check, text chunk+embed, file → R2 + ingest job
- `worker/src/memory/session.ts`: session turns, feedback close, expiry
- `worker/src/memory/graph-extractor.ts`, `graph-store.ts`: background distillation into nodes/edges; recall
- `worker/src/media/transcribe.ts`, `image.ts`: Whisper call; image handling + deferred queue when Kaggle offline
- `worker/src/skills/index.ts`, `jelaskan-konsep.ts`, `contoh-kode.ts`, `ringkas-materi.ts`, `latihan-soal.ts`: skill prompt packs + selector
- `worker/src/tools/index.ts`, `search-lesson-docs.ts`, `recall-memory.ts`, `escalate-to-mentor.ts`: tool schemas + handlers + per-learner escalation rate limit
- `worker/src/mcp/server.ts`: authenticated MCP endpoint exposing the three tools
- `worker/test/fakes/`: fake repository, fake Telegram, fake LLM/embeddings, Telegram update fixtures
- `worker/test/**/*.test.ts`: tests listed per step under Test coverage
- `worker/test/db/helpers.ts`, `worker/test/db/tsconfig.json`: PGlite + pgvector test harness (Node types kept out of the Worker tsconfig) *(amended during build, step 2)*

**Python ingestion + Kaggle (`ingest/`, `kaggle/`)**
- `ingest/pyproject.toml` (uv), `ingest/src/ingest/parsers.py` (pdf/html/md/txt → text), `chunker.py`, `embedder.py` (Workers AI bge-m3 client behind an interface), `store.py` (Supabase writer behind an interface), `seed.py` (CLI: ingest `lesson-docs/`, idempotent by content hash)
- `ingest/tests/`: unit + CLI integration tests with fake embedder/store
- `kaggle/serve.py`: launches vLLM (Qwen3-VL-8B-Instruct, quantized, tool-call parser), auth proxy checking the shared secret, heartbeat loop
- `kaggle/ingest_loop.py`: claims pending ingest jobs (pdf/html), runs `ingest` pipeline
- `kaggle/notebook.ipynb`: thin launcher: installs, starts `serve.py`, `ingest_loop.py`, `cloudflared`
- `kaggle/tests/`: auth-proxy and heartbeat tests

**Evaluation (`eval/`)**
- `eval/questions.jsonl`: ≥ 30 in-scope (from lesson-docs) + ≥ 10 out-of-scope labelled questions, Indonesian + some English
- `eval/run_eval.py`: drives the pipeline against configured live endpoints (**run by the owner**, never from this session); scores latency p90, length, language, source citation, in/out-of-scope rates, persona
- `eval/tests/test_scoring.py`: scorer tested on recorded fixtures

**Docs**
- `docs/telegram-rag-learning-companion/setup.md`: operator setup (BotFather privacy mode off + admin in group, secrets list by name, Supabase migrations, R2 bucket, tunnel, Kaggle notebook)
- `docs/index.md`: links plan, tasks, setup

## Work sequence
**Slice 1: Foundations**
1. **Scaffold**: `.gitignore`, root `package.json`/`pnpm-workspace.yaml`/`pnpm-lock.yaml`, `worker/package.json`, `tsconfig.json`, `wrangler.toml`, `vitest.config.ts`, `.dev.vars.example`, `worker/src/config.ts`, `worker/src/index.ts` (health-route stub only, needed as the test runner's entry; step 8 fills it), `ingest/pyproject.toml`. Supports all ACs. *(Amended during build: index.ts stub moved forward from step 8.)*
2. **Schema**: `db/migrations/0001_init.sql`, `0002_functions.sql`. Advances AC 14, 17, 22.
3. **Repository layer + fakes**: `db/migrations/0003_repository_rpc.sql`, `worker/src/db/repository.ts`, `worker/test/db/pglite-rpc.ts`, `worker/test/fakes/fake-repository.ts`. Advances AC 14, 17.
4. **LLM router + embeddings**: `worker/src/llm/*`. Advances AC 18.
5. **Python ingestion + seed CLI**: `ingest/src/ingest/*`, `ingest/tests/*`, `worker/src/rag/chunker.ts`. Advances AC 14, 22.

**Slice 2: Text #askAI → grounded DM → mentor fallback**
6. **Retrieval, grounding, length policy, persona prompt**: `worker/src/rag/retrieve.ts`, `grounding.ts`, `worker/src/answer/*`. Advances AC 5, 6, 7, 8, 21.
7. **Telegram client, update parsing, progress/streaming**: `worker/src/telegram/*`. Advances AC 1, 3.
8. **Webhook entry + Durable Object pipeline (text) + fallback + deep link**: `worker/src/index.ts`, `worker/src/deps.ts`, `worker/src/pipeline/*`, `worker/wrangler.toml` (DO binding), `worker/test/fakes/fake-llm.ts`, `worker/test/fakes/harness.ts`. Advances AC 1, 2, 3, 9, 12, 19.

**Slice 3: Knowledge growth**
9. **`/add_knowledge`**: `worker/src/knowledge/add-knowledge.ts`, route in `parse-update.ts`. Advances AC 13, 14.

**Slice 4: Session memory + feedback**
10. **Sessions, feedback close, 24 h alarm**: `worker/src/memory/session.ts`, `learner-session.ts` alarm, feedback/reaction handling in `parse-update.ts`. Advances AC 15, 16.

**Slice 5: Multimodal**
11. **Voice + photo questions**: `worker/src/media/*`, `worker/src/deps.ts` (transcriber), image handling in `learner-session.ts`, deferred-image delivery in `scheduled()` of `worker/src/index.ts` *(amended during build: cron entry moved forward from step 12)*. Advances AC 10, 11.

**Slice 6: Long-term graph memory + data deletion**
12. **Graph extraction cron, recall, `/hapusdata`, privacy notice**: `worker/src/memory/graph-*.ts`, `scheduled()` in `index.ts`. Advances AC 16, 17.

**Slice 7: Persona, skills, tool calling**
13. **Skills + tools + tool loop + escalation rate limit**: `worker/src/skills/*`, `worker/src/tools/*`, `ask-pipeline.ts`. Advances AC 15, 21.

**Slice 8: MCP**
14. **MCP server**: `worker/src/mcp/server.ts`, `/mcp` route. Advances AC 19, 20.

**Slice 9: Kaggle + evaluation + setup docs**
15. **Kaggle serving + ingest loop**: `kaggle/*`. Advances AC 11, 14, 18, 19.
16. **Evaluation harness**: `eval/*`. Advances AC 4, 5, 6, 7, 8, 21.
17. **Operator setup guide**: `docs/telegram-rag-learning-companion/setup.md`, `docs/index.md`. Supports deploy readiness.

## Test coverage
Matched rows from `test-scope-by-stage.md`: **backend service, no screen** (integration at the real entry point), **roles/permissions** (authN + authZ integration), **database** (regression on schema/query changes), **agent-config eval** (always; CI deferred, see below). No UI, so there is no e2e/Playwright. New project, so there is no existing-behaviour regression row.

- **Step 1**: unit: `config.ts` parsing (valid, missing var, malformed ID lists).
- **Step 2**: database regression: migrations apply cleanly on PGlite + pgvector; `match_chunks` ordering and threshold; `delete_learner_data` removes only that learner's rows; content-hash uniqueness makes re-seed a no-op; `expire_sessions` marks only sessions idle > 24 h.
- **Step 3**: unit: repository maps rows/errors; contract test: every RPC name the repository calls exists in `0002_functions.sql`. Database regression: repository queries run against PGlite via a SQL adapter.
- **Step 4**: unit: router picks Kaggle when heartbeat ≤ 90 s, Workers AI otherwise; SSE stream parsing; tool-call parsing. Integration: Kaggle client sends the shared-secret header (fake fetch).
- **Step 5**: unit: parsers on the real `lesson-docs/` files (md, pdf, html); chunker sizes/overlap. Integration at the CLI entry point: `seed` over a temp copy of `lesson-docs/` with fake embedder/store; second run adds 0 chunks. Database regression: none new (uses step 2 schema).
- **Step 6**: unit: length policy (≤ 1000 always, sentence-boundary cut, compression pass invoked once); grounding (below threshold → not found; `NOT_FOUND` marker → not found); prompt wraps retrieved text as data; persona prompt contains "Kak Skilly" and "kamu" rules; source line formatting.
- **Step 7**: unit: `parse-update` classifies fixtures (no hashtag → ignore; `#askAI` text/photo/voice; `/add_knowledge`; `/start q_…`; callback 👍/👎; message_reaction; reply text); progress throttling ≤ 1 edit/s.
- **Step 8**: integration at the webhook entry point (Miniflare): text `#askAI` → DM with stages, no topic message (AC 2, 3); no hashtag → no calls, no session (AC 1); not-found → exact topic text + mentor DMs (AC 9); learner not started → deep link, held answer delivered on `/start` (AC 12). Auth integration: missing/wrong secret-token header → 401 (AC 19).
- **Step 9**: auth integration at the webhook entry: whitelisted mentor can add text and file; non-whitelisted gets refusal and repository unchanged (AC 13). Integration: file → R2 put + ingest job row. Database regression: chunk count only increases (AC 14).
- **Step 10**: integration (DO): follow-up DM includes prior turn in prompt (AC 15); button, reaction and text reply each close the session; alarm at 24 h expires it (AC 16). Database regression: session status transitions.
- **Step 11**: integration at the webhook entry: voice → Whisper fake → transcription stage shown → text answer, no media persisted (AC 10); photo with Kaggle online → answered; offline → "delayed" notice + deferred job, delivered when heartbeat returns (AC 11).
- **Step 12**: integration at the `scheduled()` entry point: closed + expired sessions → nodes/edges written, expired with lower weight (AC 16). Auth integration: `/hapusdata` deletes only the caller's data (AC 17). Database regression: graph tables + delete function.
- **Step 13**: unit: skill selector; tool schemas; escalation rate limit. Integration (fake LLM emitting tool calls): `search_lesson_docs` → answer; `escalate_to_mentor` → fallback path.
- **Step 14**: integration at `POST /mcp`: `tools/list` returns exactly the three tools; `search_lesson_docs` returns chunks (AC 20). Auth integration: no/invalid token → rejected; `recall_memory` mentor-only (AC 19).
- **Step 15**: unit: heartbeat writer, job claim/complete. Integration at the auth-proxy entry: missing secret → 401, valid → forwarded (AC 19). (vLLM itself is not run locally: no GPU.)
- **Step 16**: unit: scorer on recorded fixtures (latency p90, length, language, citation, scope rates, persona). The live run is the owner's action.
- **Step 17**: none (documentation).
- **Agent-config eval**: `.claude/hooks/eval.sh` run locally in Phase 4. CI job **deferred**: the project has no CI (Phase 0).

## Agent configuration changes
Each is shown as its own diff and needs its own `approve write` before it is written.
1. **`CLAUDE.md`** (new, written right after this plan is approved, before step 1): context pointer to `docs/product.md`/`tech.md`/`structure.md` (absent for now; noted), commands table (`pnpm -C worker test`, `uv run --project ingest pytest`, …), conventions, docs layout, matched test-scope rows, workflow rule.
2. **Hook `protect-paths` (recipe 1, Node-based parser since `jq` is absent)** guarding `lesson-docs/` only. The source corpus is append-only through `/add_knowledge` and the seed. An agent should never edit it.
3. **Subagent `answer-quality-reviewer`** (read-only: Read, Grep, Glob): reviews prompt/persona/length-policy changes and eval output against AC 5, 6, 7, 21. A recurring task, since every prompt tweak needs it.
4. **Hook `guard-tests` (recipe 3)**: Phase 4, only if fix tasks arise.
5. **Hook `deploy-gate` (recipe 4) + credential deny-list**: Phase 5, extended with `wrangler deploy|wrangler secret|supabase db push|kaggle kernels push|cloudflared tunnel`.
6. **CI agent-config eval job**: **deferred**, no CI platform (Phase 0 answer: "no CI").

Parallel sessions: steps 5 (Python ingest) and 15 (Kaggle) share no files with the Worker steps 6–14. A worktree for the Python track is possible if you want two sessions. It won't be created unless you ask.

## Rollback
Nothing is deployed by this work. Every step is its own commit, so `git revert <sha>` undoes a step. To undo the whole feature, delete the branch. Once the owner deploys, rollback is `wrangler rollback` for the Worker. Migrations are additive-only (new tables/functions), so reverting means dropping the feature's tables. That's documented in `setup.md`.
