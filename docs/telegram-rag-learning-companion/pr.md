# PR: Telegram #askAI learning companion (Kak Skilly)
*Author: Kharisma Wardhana. Stage: Deploy. Written: 2026-11-02. Via /aspec:make-it-simple-v2.*

**Branch:** `feature/telegram-rag-learning-companion` → **base:** `main` (at `f91e403`, the `intent.md` commit). No remote yet. Paste this description when the repo is pushed.

---

## What this adds
A Telegram learning bot for the IBM SkillBuild AI cohort. A learner posts `#askAI` in a forum topic (text, photo or voice). "Kak Skilly" answers by DM in Bahasa Indonesia from `lesson-docs`, with live progress stages and a streamed answer of at most 1000 characters that cites its source. If the docs don't cover the question, the bot posts the agreed fallback text in the topic and DMs the mentors. Mentors grow the knowledge base with `/add_knowledge`. The bot also has session memory (24 h), long-term graph memory, skills, tool calling, an MCP server for mentors, and `/hapusdata`.

**Stack (free tier only):** Cloudflare Worker + Durable Objects + R2 + Workers AI (Qwen3-30B fallback, bge-m3, Whisper) · Kaggle T4×2 vLLM (Qwen3-VL-8B) behind a Cloudflare Tunnel · Supabase Postgres + pgvector.

## The chain
- Intent: [`docs/telegram-rag-learning-companion/intent.md`](intent.md)
- Spec (behaviour, architecture, 22 acceptance criteria, flagged concerns): [`spec.md`](spec.md)
- Plan (files, order, test coverage; amendments marked inline): [`plan.md`](plan.md) · progress: [`tasks.md`](tasks.md) (17/17)
- Operator setup / eval / rollback: [`setup.md`](setup.md) · ops tools (documented, not wired): [`ops-tools.md`](ops-tools.md)
- Review checklist: [`REVIEW.md`](../../REVIEW.md)

## Evidence
- Worker: typecheck clean; **114/114** vitest (Workers runtime via Miniflare + PGlite/pgvector for SQL), including 10 regression tests from the answer-quality review.
- `ingest` **14/14**, `kaggle` **9/9**, `eval` scorer **4/4** pytest.
- `.claude/hooks/eval.sh`: every installed hook checked in both directions, exit 0.
- AC-by-AC results are in the Phase 4 summary. **AC 4, 6, 8 and 21 still need the live staging eval** (`eval/run_eval.py`, setup.md §7) before go-live.

## Reviewer focus (see REVIEW.md)
- The 1000-char cap, grounding and NOT_FOUND hold-back in `worker/src/pipeline/ask-pipeline.ts`.
- Auth on `/telegram/webhook`, `/mcp` and the Kaggle proxy.
- `sanitizeData` coverage for every untrusted text path.
- Personal-data handling and the `/hapusdata` cascade.

## Open decisions (owners named in spec › Flagged concerns)
UU PDP sign-off · IBM course-content licence (keep `lesson-docs/` off any public remote until confirmed) · Kaggle terms of use · brand use of "Kak Skilly"/IBM SkillBuild.

## Not in this PR
No deployment, no CI (none configured; the agent-config eval job is deferred), no live-service calls of any kind. Merging and deploying are the owner's actions.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
