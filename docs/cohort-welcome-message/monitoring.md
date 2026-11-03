# Monitoring: cohort welcome and leave notices
*Author: Kharisma Wardhana. Stage: Maintain. Written: 2026-11-03. Via /aspec:make-it-simple-v2.*
*Implements: docs/cohort-welcome-message/spec.md*

## Decision (agreed 2026-11-03)
**No control band for this feature.** Joins arrive about 20 at a time, once per cohort, so there's no steady daily series for a band to watch. The project's existing band on the mentor-fallback rate ([feature 1 monitoring.md](../telegram-rag-learning-companion/monitoring.md)) is unchanged and unaffected.

`.claude/monitoring/control_band.py` is still byte-identical to the skill's reference, and its `--self-check` passed on 2026-11-03. Its limits haven't changed:
- it implements Western Electric rules 1–4 only; rules 5–8 are **not** implemented;
- it can't detect an overlapping baseline;
- 8 points is a floor, not a sound sample;
- it has only been run against synthetic data.

## Cohort start day: the check that matters
When a new cohort is added to the group, watch for the first welcome **within about 5 minutes** of the first joins. If it doesn't appear, check in this order:

1. The bot is still a **group admin**. Telegram only sends `chat_member` updates to admin bots.
2. `getWebhookInfo` lists `chat_member` in `allowed_updates` (setup.md §2).
3. Migration `0005` is applied, and **Sambut anggota baru** is switched on (dashboard → Sambutan).
4. The Worker logs show `welcome post failed; re-queueing batch`, usually a wrong topic ID ("message thread not found"). Fix the topic on the Sambutan page: the batch is still waiting and posts at the next tick.

## Weekly read-only check
Run by the owner in the Supabase SQL editor. It returns aggregates only, with no names:

```sql
select count(*) as waiting,
       extract(epoch from now() - min(joined_at)) / 60 as oldest_wait_minutes
from pending_welcomes;
```

| Result | Means | Response |
|---|---|---|
| `waiting = 0` | Normal | None |
| `oldest_wait_minutes > 10` | The cron isn't posting, or every post fails | Run the cohort-day checklist above |
| `oldest_wait_minutes` near 1440 (24 h) | Newcomers are about to be purged without a welcome | Same checklist, urgently. After a fix, anyone purged can be welcomed by hand |

Leave notices store nothing, so they can't be checked after the fact. If a dashboard user says notices stopped arriving, check the **Kabari saat ada yang keluar** switch and the bot's admin rights.

## Security scan
**Reused, not added.** The existing scheduled `pnpm audit` and `uv audit` (feature 1 monitoring.md) still apply. This feature adds no dependencies.

## Closing the loop
The tiers and incident template are project-wide and unchanged. A welcome that fails on cohort start day, or a check that keeps returning a non-zero wait, writes an incident record at `docs/cohort-welcome-message/incidents/YYYY-MM-DD-<slug>.md` using feature 1's template. Its `## Follow-up intent` either links a new `docs/<feature>/intent.md`, which re-enters the loop at Phase 1, or says "None — no change warranted."
