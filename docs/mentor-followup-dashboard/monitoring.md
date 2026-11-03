# Monitoring: mentor follow-up dashboard
*Author: Kharisma Wardhana. Stage: Maintain. Written: 2026-11-03. Via /aspec:make-it-simple-v2.*
*Implements: docs/mentor-followup-dashboard/spec.md*

## Decision (agreed 2026-11-03)
**No second control band.** This feature reuses the project's existing band on the **daily mentor-fallback rate** ([feature 1 monitoring.md](../telegram-rag-learning-companion/monitoring.md) › What is watched). The dashboard acts directly on that metric:
- every "Tambahkan ke pengetahuan" should lower it over the following weeks;
- a broken dashboard pushes follow-ups back to hand-handled DMs.

At about 10 follow-ups a week, nothing here produces enough daily points for a sound band of its own.

The detector (`.claude/monitoring/control_band.py`) is unchanged and byte-identical to the skill's reference, and its `--self-check` passed on 2026-11-03. Its limits, stated plainly:
- it implements Western Electric rules 1–4 only; rules 5–8 are **not** implemented;
- it **can't detect** a baseline window that overlaps the recent window, so that's the data producer's job;
- 8 points is the minimum it accepts, not a sound sample;
- it has only been run against synthetic data. Pointing it at real data and scheduling it are owner actions.

## How this feature shows up on the existing band
| Observation after deploy | Reading | Action |
|---|---|---|
| The fallback rate falls over 2–4 weeks | Knowledge additions are working | None |
| The fallback rate is flat | Mentors reply but rarely add to knowledge | Tier 0. Mention it to the mentor team, no incident |
| The fallback rate **rises** (R1–R4 tier 2/3) right after this deploy | Possible regression in the fallback path. Step 3 of the plan changed `runFallback` | Follow feature 1's tier 2/3 response. First check that mentor DMs still arrive and that `0004` was applied before the deploy (setup.md §1) |

## Weekly owner check (threshold counts, not control-band rules)
Run by the owner in the Supabase SQL editor, read-only. It returns aggregates only, with no question or reply text and no emails, matching the documented `status` tool in [ops-tools.md](ops-tools.md):

```sql
select
  count(*) filter (where status = 'closed' and (dm_status = 'failed' or topic_status = 'failed'))       as failed_deliveries,
  count(*) filter (where status = 'claimed' and claimed_at < now() - interval '24 hours')                as lapsed_claims,
  count(*) filter (where status = 'open' and created_at < now() - interval '48 hours')                  as open_over_48h,
  count(*) filter (where status = 'closed' and dm_status = 'held' and replied_at < now() - interval '7 days') as held_over_7d
from mentor_followups
where dashboard_visible;
```

| Count | Non-zero means | Response |
|---|---|---|
| `failed_deliveries` | A reply reached the learner or the topic only partly | The mentor follows up by hand in Telegram. Repeated failures in one week mean an incident record |
| `lapsed_claims` | Someone claimed and walked away | Remind the mentor team. The question is already open again |
| `open_over_48h` | Nobody is picking questions up | Raise it with the mentor team (no reminder feature exists, by design) |
| `held_over_7d` | The learner never pressed Start | Nothing to fix. Optionally nudge them in the topic |

## Security scan
**Reused, not added.** The existing scheduled `pnpm audit` and `uv audit --project {ingest,kaggle,eval}` (feature 1 monitoring.md › Scheduled security scan) already cover this feature's new devDependencies (`@playwright/test`, `@hono/node-server`, `tsx`). Treat a finding in them like any other dependency finding.

## Closing the loop
The tiers and incident template are project-wide and unchanged. A tier-2 or tier-3 finding, or a weekly count that repeats, writes an incident record at `docs/mentor-followup-dashboard/incidents/YYYY-MM-DD-<slug>.md` using feature 1's template. Its `## Follow-up intent` either links a new `docs/<feature>/intent.md`, which re-enters the loop at Phase 1, or says "None — no change warranted."

**Already-known follow-up intent:** the spec's retention line for staff data, "dashboard users kept until removal + 90 days", has no purge job yet (REVIEW.md › Compliance, pr.md › Before merging). It should enter the loop as its own small intent.
