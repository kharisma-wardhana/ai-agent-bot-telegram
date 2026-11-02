# Kak Skilly: Telegram AI learning companion

A Telegram bot for the IBM SkillBuild AI cohort. Learners post a question with **`#askAI`** in any forum topic, as text, a photo or a voice note. **Kak Skilly** answers by DM in Bahasa Indonesia, grounded in the course material (`lesson-docs/`). Answers are at most 1000 characters and cite their source. If the material doesn't cover the question, the bot says so in the topic and hands the question to a mentor.

Everything runs on free tiers: Cloudflare, Supabase, Kaggle, and open Qwen models.

## Features

- **#askAI → DM answer.** Live progress stages ("Pertanyaan diterima → Sedang mencari dokumen terkait → Menyusun jawaban"), a streamed answer, and a source line.
- **RAG over lesson-docs.** pgvector search with a similarity threshold. The model answers only from the retrieved text.
- **Mentor fallback.** When nothing relevant is found, the bot replies in the topic with *"Saya tidak punya data terkait pertanyaan tersebut, akan saya follow up ke mentor"* and DMs every mentor.
- **`/add_knowledge`** (mentors only): append text, `.md`, `.txt`, `.pdf` or `.html` to the knowledge base.
- **Multimodal input, text output.** Voice is transcribed with Whisper. Photos are read by Qwen3-VL.
- **Memory.** Session memory with a 24-hour TTL, closed by feedback (👍/👎 button, ✅ reaction, or a text reply). Long-term per-learner graph memory, built in the background.
- **Persona, skills, tools, MCP.** The "Kak Skilly" persona and 4 answer styles (explain, code example, summary, practice quiz). The model can call 3 tools: `search_lesson_docs`, `recall_memory`, `escalate_to_mentor`. The same tools are exposed as an authenticated MCP server for mentors.
- **Privacy.** A one-time notice, and `/hapusdata` deletes all of a learner's data. Raw audio and images are never stored.

## Architecture

```
Telegram ──webhook──► Cloudflare Worker (Hono)
                        ├─ Durable Object per learner: queue, pipeline, 24 h session alarm
                        ├─ Cron (5 min): expire sessions, build graph memory, deliver deferred photos
                        ├─ /mcp: MCP server for mentors (bearer token)
                        ├─ LLM router ──► Kaggle vLLM (Qwen3-VL-8B) via Cloudflare Tunnel  [primary]
                        │               └► Workers AI Qwen3-30B-A3B                           [fallback]
                        ├─ Workers AI: bge-m3 embeddings, Whisper transcription
                        ├─ R2: original uploaded files
                        └─ Supabase Postgres + pgvector: knowledge, sessions, memory graph
Kaggle notebook ── vLLM + auth proxy + heartbeat + PDF/HTML ingest loop
```

When the Kaggle GPU is offline (it has a 12-hour session cap and a weekly quota), text and voice questions switch to Workers AI automatically. Photo questions and PDF/HTML ingestion wait until Kaggle is back.

## Repository layout

| Path | What |
|---|---|
| `worker/` | Cloudflare Worker (TypeScript): webhook, pipeline, Durable Object, MCP, cron |
| `db/migrations/` | Supabase SQL: tables and every data operation as a SQL function |
| `ingest/` | Python: parsers, chunker, seed CLI (`skilly-seed`) |
| `kaggle/` | Python: vLLM auth proxy and heartbeat, ingest loop, `notebook.ipynb` |
| `eval/` | Labelled question set, scorer, live evaluation harness |
| `lesson-docs/` | Course material (append-only; not committed) |
| `docs/` | Feature docs: intent → spec → plan, setup, monitoring. Start at [`docs/index.md`](docs/index.md) |
| `.claude/` | Claude Code hooks, subagent, monitoring detector |

## Quick start (local)

Requirements: Node 24+, pnpm, [uv](https://docs.astral.sh/uv/). No Docker is needed: the database tests run on PGlite in-process.

```bash
pnpm install                         # Worker dependencies
pnpm -C worker typecheck
pnpm -C worker test                  # Workers runtime (Miniflare) + PGlite/pgvector SQL tests

uv run --project ingest pytest ingest
uv run --project kaggle pytest kaggle
uv run --project eval pytest eval

uv run --project ingest skilly-seed lesson-docs --dry-run   # parse + chunk only, no network
bash .claude/hooks/eval.sh                                   # agent-config checks
```

`pnpm -C worker dev` runs the Worker locally. Copy `worker/.dev.vars.example` to `worker/.dev.vars` and fill in values; never commit them.

## Deploy

Deployment is a manual owner action. **Follow [`docs/telegram-rag-learning-companion/setup.md`](docs/telegram-rag-learning-companion/setup.md)** step by step:

1. Telegram bot setup
2. Supabase migrations
3. Cloudflare (R2, Tunnel, tokens)
4. Worker secrets and `wrangler deploy`, then register the webhook
5. Seed the corpus
6. Run the Kaggle notebook
7. Run the live evaluation on staging before go-live

Secrets are referred to by name only (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `SUPABASE_SERVICE_KEY`, `KAGGLE_SHARED_SECRET`, `MCP_TOKENS`, plus the Kaggle-only tokens). Set them with `wrangler secret put` or Kaggle Secrets.

## Bot commands

| Where | Command | Who |
|---|---|---|
| Group topic | `#askAI <question>` (text, photo caption, or voice note) | Learners |
| DM | `/start` | Everyone |
| DM | follow-up question, or reply to an answer to give feedback | Learners |
| DM | `/add_knowledge <text>` or a file with caption `/add_knowledge` | Whitelisted mentors |
| DM | `/hapusdata` | Learners |

## Quality, review and operations

- **Tests:** 141 across the Worker (114), ingest (14), Kaggle (9) and eval (4).
- **Live acceptance check:** [`eval/run_eval.py`](eval/run_eval.py), run against staging. It covers latency p90 < 60 s, ≤ 1000 chars, Indonesian output, cited sources, ≥ 70% answered and ≥ 90% correct fallbacks, and the persona.
- **Review checklist:** [`REVIEW.md`](REVIEW.md).
- **Monitoring:** a control band on the daily mentor-fallback rate, response tiers, incident template and security scans. See [`docs/telegram-rag-learning-companion/monitoring.md`](docs/telegram-rag-learning-companion/monitoring.md).
- **Rollback:** `wrangler rollback`, or `deleteWebhook` to silence the bot (setup.md §9).

## Open items before go-live

- Run the live evaluation (AC 4, 6, 8, 21 depend on real model behaviour).
- Verify the Workers AI and Hugging Face model IDs (setup.md §8).
- Program-owner sign-off: personal data (UU PDP), IBM course-content licence (keep `lesson-docs/` off public remotes), Kaggle terms of use, brand use.
