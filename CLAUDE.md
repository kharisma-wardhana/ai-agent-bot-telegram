# IBM SkillBuild AI — Telegram learning companion

## Context
Read these first — they are the project's foundation documents:
- `docs/product.md` — what this is for, who uses it
- `docs/tech.md` — stack, commands, constraints
- `docs/structure.md` — layout and conventions
- `docs/index.md` — table of contents for all feature documentation
(The first three don't exist yet; run `/aspec:steering-docs` once there is code to document.)

## Commands
| What | Command |
|---|---|
| Install | `pnpm install` · `uv sync --project ingest` |
| Run locally | `pnpm -C worker dev` (wrangler dev, local only) |
| Test | `pnpm -C worker test` · `pnpm -C worker test:e2e` · `uv run --project ingest pytest` · `uv run --project kaggle pytest` |
| Lint / format | `pnpm -C worker lint` · `pnpm -C worker format` |
| Build / typecheck | `pnpm -C worker typecheck` |

## Conventions
- Worker is TypeScript (Hono) on Cloudflare Workers; Python (uv) only for ingestion, Kaggle and eval.
- All learner-facing text is Bahasa Indonesia, persona "Kak Skilly", final answers ≤ 1000 chars.
- Secrets only via `wrangler secret` / Kaggle secrets; `.dev.vars.example` lists names, never values.
- `lesson-docs/` is append-only source corpus — never edit it; grow it via `/add_knowledge` or the seed.
- Migrations are additive: new file per change, never edit an applied one.

## Documentation layout
All project documentation lives under `docs/`. `docs/index.md` is a table
of contents linking to one folder per feature. Each feature's own docs live
in `docs/<feature-name>/`. Whenever a feature is added or changed, update
`docs/index.md` in the same change.

## Test scope
- Backend, no UI: integration test at the real entry point (webhook, cron `scheduled()`, `/mcp`, seed CLI) — no e2e/Playwright.
- Web UI (`/dashboard`): Playwright e2e on the main flows, against `worker/e2e/server.ts` with fakes, no network.
- Roles/permissions: authN + authZ integration tests (webhook secret, add_knowledge whitelist, MCP token, tunnel secret, /hapusdata scope).
- Database: regression test (PGlite + pgvector) whenever a step changes schema or a query.
- Agent config: `.claude/hooks/eval.sh` re-run whenever `CLAUDE.md`, `.claude/agents/*` or a hook changes (CI job deferred — no CI).
Run the tests before reporting a task complete, and paste the output.

## Workflow
Nothing is implemented without an accepted plan. Work on this repo follows
`intent.md` -> `spec.md` -> `plan.md`, each committed before the next
starts. See `docs/telegram-rag-learning-companion/` for the current chain;
tick `tasks.md` boxes only in the commit that lands the step and its tests.

## Common mistakes
- (none yet)
