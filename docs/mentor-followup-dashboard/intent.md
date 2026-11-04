# Intent: Mentors handle every follow-up question from one phone-friendly web dashboard, and the bot delivers their reply to the learner
*Author: Kharisma Wardhana. Stage: Plan. Written: 2026-11-03. Via /aspec:make-it-simple-v2.*

## Problem statement
When the bot can't answer an #askAI question from lesson-docs, it DMs every mentor separately and records a row in `mentor_followups` (feature `telegram-rag-learning-companion`, AC 9). With 2 mentors and about 10 follow-ups per week, there is no shared view of which questions are still open. Mentors may both answer the same question, or each assume the other did and miss it. A mentor has to answer by hand, in the group or by DMing the learner. Nothing ever marks a follow-up as `resolved`, and the bot never learns what the answer was, so the same question escalates again next time.

## Proposed outcome
- One web dashboard, in Bahasa Indonesia, usable on a phone, lists every follow-up question with its status.
- A question moves through the statuses **open → claimed → closed**. Once someone claims a question, nobody else can claim it.
- A dashboard user replies to a claimed question. The bot then:
  - DMs the reply to the learner who asked, as Kak Skilly passing on the mentor's answer. If the learner hasn't started the bot, the reply is held and delivered later, the same way held answers work today.
  - Posts the reply in the original group topic, tagging the learner.
  - Marks the question closed.
- Mentors still receive a Telegram DM for each new follow-up, as they do today.
- A reply is **not** added to the knowledge base automatically. A dashboard user can press a button to add that question and reply to lesson-docs, through the same append-only path as `add-knowledge`, so the bot can answer it next time.
- Dashboard users can add and remove mentors from the dashboard.

## Affected users and systems
- **Owner, admin and mentors** (currently 2 mentors). All three roles have the same rights: view, claim, reply, trigger knowledge ingest, and add or remove mentors. They mostly use a phone.
- **Learners** receive the mentor's reply by DM and are tagged in the group topic.
- **Cohort Telegram group (forum topics)**: replies are posted in the topic where the question was asked.
- **Worker (Cloudflare, Hono)**: serves the dashboard and its API, and sends the replies.
- **Supabase Postgres**: `mentor_followups` gains the claim/close lifecycle and the reply, and `pending_answers` holds replies for learners who haven't started the bot. The mentor list moves somewhere editable at runtime.
- **lesson-docs corpus / knowledge pipeline**: grows when a dashboard user triggers ingest of a reply.

## Constraints
- Free tier only: Cloudflare free plan and Supabase free. No paid services, and no separate hosting.
- Login is restricted to a **whitelist of email addresses held in config**.
- The dashboard shows **only the question** (text, image and topic). It shows no learner identity: no name, username or Telegram ID.
- Learner-facing text, including the relayed reply, is in Bahasa Indonesia as Kak Skilly, and the final answer is ≤ 1000 characters. The dashboard UI is in Bahasa Indonesia.
- `lesson-docs/` is append-only. Knowledge ingest is triggered by a person, never automatic.
- Only follow-ups created after this feature ships appear. Existing follow-ups are not backfilled.
- No reminder or nudge when a question stays unanswered.
- Migrations are additive.
- Deadline is the same as feature 1: 2026-12-02.

## Open questions
1. How is ownership of a whitelisted email proven at login, on the free tier, without a paid email or auth service?
2. What happens to a question that is claimed but never answered: does it time out back to open, or can another user or the claimer release it?
3. Mentors are configured today as Telegram IDs (`MENTOR_IDS`) for the follow-up DMs, and the dashboard is gated by email. How does "add/remove mentor" in the dashboard relate to the email whitelist and to the Telegram IDs that receive DMs?
4. What exactly gets written to lesson-docs on "add to knowledge": the question and the reply, in what format, and can it be undone?
5. If a question includes an image, can the dashboard show it without leaking learner identity, given that Telegram file URLs carry the bot token?
6. Can a reply be edited or resent after it's closed?
