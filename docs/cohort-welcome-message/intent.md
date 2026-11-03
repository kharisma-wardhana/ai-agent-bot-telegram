# Intent: New cohort members are welcomed automatically in the group with an admin-editable message, and dashboard users are told when someone leaves
*Author: Kharisma Wardhana. Stage: Plan. Written: 2026-11-03. Via /aspec:make-it-simple-v2.*

## Problem statement
Learners join the cohort Telegram group mostly in one batch of about 10–20 people when a cohort starts. Admins welcome them by hand, so the welcome is late, inconsistent, or missing. Newcomers aren't reliably told how the group works: the forum topics, pressing Start on the bot, and asking with `#askAI`. When someone leaves the group, nobody on the team notices. The bot sees none of this today: it ignores everything in the group except `#askAI` posts, and its webhook isn't subscribed to member changes.

## Proposed outcome
- When people join the cohort group, the bot posts a welcome **in the group**, as Kak Skilly in Bahasa Indonesia.
- Joins that arrive close together, for example within about 5 minutes, are **combined into one message** that mentions every newcomer. A batch of 15 joins never produces 15 messages.
- The welcome text is **editable by dashboard users** (owner, admin, mentor) on a page in the existing mentor dashboard, with no developer and no redeploy. It supports placeholders such as the newcomers' names.
- The default welcome tells newcomers what to do first: read the rules, press Start on the bot, and ask with `#askAI`.
- When someone leaves the group, **every dashboard user gets a private Telegram DM** saying so. Nothing is posted in the group.
- Bots that join or leave are ignored, and so is every chat except the configured cohort group.

## Affected users and systems
- **New learners** (10–20 per cohort batch) see the welcome in the group.
- **Dashboard users** edit the welcome text and receive leave notices. This is the same user set as `mentor-followup-dashboard`, with the same equal rights.
- **Cohort Telegram group**: the bot posts the combined welcome there.
- **Worker**: the webhook needs to handle member-change updates, plus a way to wait out the batch window before posting. The dashboard gains a settings page.
- **Supabase Postgres**: stores the editable welcome text, and possibly pending joins for the batch window.
- **Telegram webhook registration** (an owner action): it may need `chat_member` added to `allowed_updates`, and the bot may need group-admin rights.

## Constraints
- Free tier only: Cloudflare free plan and Supabase free. No new paid service and no new secret.
- Learner-facing text is in Bahasa Indonesia as Kak Skilly. The welcome text an admin writes is capped at 1000 characters.
- The dashboard page is in Bahasa Indonesia, works on a phone, and uses the existing dashboard login, CSRF and Origin protections.
- It acts only in the configured cohort group (`GROUP_CHAT_ID`) and skips bots.
- Migrations are additive.
- Deadline: 2026-12-02, the same as features 1 and 2.

## Open questions
1. How is the ~5-minute batch window implemented on the free Worker: the existing 5-minute cron, a Durable Object alarm, or posting on the first join and editing that message as more people arrive?
2. Which Telegram update does the bot rely on for joins and leaves: service messages (`new_chat_members` / `left_chat_member`) or `chat_member` updates, which need admin rights and a webhook re-registration? Should the "X joined" service messages be deleted to keep topics clean?
3. What is the default welcome text, and which placeholders exist: the newcomers' names or mentions, a rules link, the bot's deep link?
4. Which forum topic does the welcome go to, and is that set on the dashboard page or in Worker config?
5. Is someone who joins and leaves within the same window still welcomed? Is a rejoin welcomed again?
6. The leave notice names the person to dashboard users. Are joins and leaves stored, and for how long?
7. Can admins switch welcomes off, for example during a mass import of members?
