# Ops tools: what the cohort welcome adds
*Author: Kharisma Wardhana. Stage: Deploy. Written: 2026-11-03. Via /aspec:make-it-simple-v2.*

**Documented, not wired.** This feature ships inside the same Worker and reuses `deploy`, `rollback` and `status` from [feature 1](../telegram-rag-learning-companion/ops-tools.md) and [feature 2](../mentor-followup-dashboard/ops-tools.md), with **no new credential**.

| Tool | Change for this feature | Needs (narrowest scope) | Read/Write | Human approval |
|---|---|---|---|---|
| `status` | Adds: number of newcomers waiting, age of the oldest one (a value over 10 min means the cron isn't posting), and whether welcomes and leave notices are on. Aggregates only, no names. | The same Supabase read-only role, plus `SELECT count(*), min(joined_at)` on `pending_welcomes` and `SELECT welcome_enabled, leave_enabled` on `welcome_settings` | Read | No |
| `deploy` | Unchanged. Pre-condition added: `0005` is applied. | Same as before | Write | **Yes** |
| `rollback` | Unchanged. The old Worker ignores `chat_member` updates. | Same as before | Write | **Yes** |
| `set_webhook` (deliberately **not** provided) | Re-registering the webhook with `chat_member` | n/a | n/a | It needs the bot token, so it stays a manual `curl` by the owner (setup.md §2) |

The welcome text and switches are changed by a signed-in human on the dashboard, never by a tool.
