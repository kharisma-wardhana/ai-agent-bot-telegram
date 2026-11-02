# Ops tools: deploy, status, rollback as scoped MCP tools
*Author: Kharisma Wardhana. Stage: Deploy. Written: 2026-11-02. Via /aspec:make-it-simple-v2.*

**Documented, not wired.** Nothing in this repo connects these tools to anything, and no agent session should hold the credentials they need. They describe what an ops MCP server *would* expose if the team later wants an agent to assist with operations, and the narrowest scope each one would need. A human keeps the final approval on every write action.

| Tool | Does | Needs (narrowest scope) | Read/Write | Human approval |
|---|---|---|---|---|
| `status` | Worker health (`GET /health`), latest Kaggle heartbeat age, cron last-run time, this week's `answer_source_ratio`, open mentor follow-ups count | Supabase **read-only** role with `SELECT` on `inference_heartbeat`, `mentor_followups`, view `answer_source_ratio`. HTTPS GET to the Worker `/health` | Read | No |
| `deploy` | `wrangler deploy` of a given git SHA from `worker/` after `pnpm -C worker test` passes | Cloudflare API token: *Workers Scripts: Edit* on the one account, nothing else (no DNS, no R2 delete, no Zero Trust) | Write | **Yes**, every run, with the SHA and test output shown |
| `rollback` | `wrangler rollback` to the previous Worker version, or `deleteWebhook` to silence the bot instantly | Same token as `deploy` (Workers Scripts: Edit); Telegram bot token only for `deleteWebhook` | Write | **Yes** |
| `migrate` (deliberately **not** provided) | Applying SQL migrations | n/a | n/a | Migrations stay a manual step in the Supabase SQL editor (setup.md §2) |

## Rules if this is ever wired
- One credential per tool, scoped as above, stored in the MCP server's secret store. Never in the repo, the agent's environment or a prompt.
- The `deploy` and `rollback` tools refuse to run without an explicit human confirmation token per invocation. The deploy-gate hook in `.claude/settings.json` still asks before any `wrangler deploy` typed into a session.
- `status` returns aggregates only, no learner messages or names.
- Every write action posts to the mentors' DM with who/what/SHA, so a deploy is never silent.
