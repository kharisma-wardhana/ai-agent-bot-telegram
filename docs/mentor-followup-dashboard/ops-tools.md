# Ops tools: what the mentor dashboard adds to deploy, status and rollback
*Author: Kharisma Wardhana. Stage: Deploy. Written: 2026-11-03. Via /aspec:make-it-simple-v2.*

**Documented, not wired.** The dashboard ships inside the same Worker, so it reuses the `deploy`, `rollback` and `status` tools in [feature 1's ops-tools.md](../telegram-rag-learning-companion/ops-tools.md) with **no new credential**. These are the additions to them. Nothing here connects to anything.

| Tool | Change for this feature | Needs (narrowest scope) | Read/Write | Human approval |
|---|---|---|---|---|
| `status` | Adds counts per dashboard status: open, claimed (live), claims lapsed past 24 h, and closed with a failed DM or topic delivery. Also the number of active dashboard users. **Aggregates only**: no question text, reply text, emails or learner data. | The same Supabase read-only role, plus `SELECT` on `mentor_followups` columns `status`, `claimed_at`, `dm_status`, `topic_status`, and `count(*)` on `dashboard_users` | Read | No |
| `deploy` | Unchanged. Pre-condition added: migration `0004` is already applied, which the tool checks via `status`. It also runs `pnpm -C worker test:e2e` along with `pnpm -C worker test`. | The same Workers Scripts: Edit token | Write | **Yes** |
| `rollback` | Unchanged. Rolling back the Worker removes the dashboard. Migration `0004` stays, because the old Worker ignores it (setup.md §6). | Same as feature 1 | Write | **Yes** |
| `revoke_dashboard_sessions` (deliberately **not** provided) | An emergency logout for everyone | n/a | n/a | It stays a manual SQL statement in the Supabase editor (`update dashboard_sessions set revoked_at = now() where revoked_at is null`), run by the owner. A tool holding a write role on the auth tables is a bigger risk than the convenience is worth. |
| `migrate` (still **not** provided) | Applying `0004` | n/a | n/a | Manual, in the Supabase SQL editor (setup.md §1) |

## Rules (in addition to feature 1's)
- No tool reads or returns dashboard login tokens, session hashes, emails, question text or reply text.
- Adding or removing dashboard users stays a dashboard action taken by a signed-in human, never a tool.
