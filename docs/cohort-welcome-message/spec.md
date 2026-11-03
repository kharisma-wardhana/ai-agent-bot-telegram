# Spec: New cohort members are welcomed automatically in the group with an admin-editable message, and dashboard users are told when someone leaves
*Author: Kharisma Wardhana. Stage: Design. Written: 2026-11-03. Via /aspec:make-it-simple-v2.*
*Implements: docs/cohort-welcome-message/intent.md*

## Behaviour

### Welcoming new members
- When a person (not a bot) joins the cohort group, the bot **doesn't post right away**. It adds them to a waiting list.
- Every 5 minutes the bot posts **one welcome message** in the group that greets everyone on the waiting list, each name as a Telegram mention so they get notified. The waiting list is then cleared. A newcomer waits at most about 5 minutes. A batch of 15 joins becomes one message, or at most two if the batch straddles a 5-minute tick.
- More than 50 newcomers at once are split across several messages, 50 names each.
- The welcome is posted in the **welcome topic** set on the dashboard. If none is set, it goes to the group's General topic.
- Someone who joins and then leaves **before** the welcome is posted isn't welcomed. Someone who leaves after being welcomed and joins again is welcomed again. Joining twice inside one window produces one mention.
- Joins and leaves in any chat other than the configured cohort group, and joins and leaves of bots, are ignored.
- Telegram's own "X bergabung" service messages are left alone: the bot doesn't delete them. Admins who want them hidden can use Telegram's built-in group setting.

### The welcome text
- The text is a template a dashboard user edits. `{nama}` is replaced by the list of newcomers, for example "Ani, Budi, dan Citra", each a mention. `{bot}` is replaced by the bot's `@username`.
- The template must contain `{nama}` and be at most **1000 characters** before substitution.
- It is sent as **plain text**, exactly as written apart from the placeholders. The model never rewrites it.
- Until someone edits it, this default is used:

  > Halo {nama}! 👋 Selamat datang di grup cohort. Aku Kak Skilly, asisten belajar kalian di sini.
  >
  > Biar lancar:
  > 1. Baca dulu topik aturan grup ya.
  > 2. Tekan Start di {bot} supaya aku bisa membalas pertanyaanmu lewat DM.
  > 3. Ada pertanyaan soal materi? Tulis di topik mana saja dengan tagar #askAI.
  >
  > Semangat belajar! 🚀

### When someone leaves
- When a person (not a bot) leaves the cohort group, or is removed from it, **every dashboard user** gets one Telegram DM. That means the config owners plus the added users. MENTOR_IDS that aren't dashboard users don't get it. The DM looks like: "👋 Ani (@ani) keluar dari grup cohort." or "… dikeluarkan dari grup cohort." for a removal.
- Nothing is posted in the group.
- If the person was still on the welcome waiting list, they're taken off it.

### The settings page (dashboard)
A new **Sambutan** page in the existing dashboard, reached from the top menu. Any signed-in dashboard user can:
- edit the welcome template. It shows a live character count, checked when saved, plus the placeholder help;
- set the welcome topic ID (a number, or blank for General);
- switch **Sambut anggota baru** (welcome new members) on or off;
- switch **Kabari saat ada yang keluar** (notify when someone leaves) on or off;
- see who last saved the settings, and when.

Saving a template over 1000 characters, or one without `{nama}`, is refused and nothing changes. Welcomes switched **off** means joins aren't even put on the waiting list, so nothing piles up to be posted later. The page is in Bahasa Indonesia, works on a phone, and uses the same login, CSRF and Origin protections as the rest of the dashboard.

## Architecture and the reason for it
This conforms to the stack features 1 and 2 settled. `docs/tech.md` and `docs/structure.md` still don't exist.

- **Joins and leaves come from `chat_member` updates.** These are the bot's view of a member's status changing: `left`/`kicked` → `member`/`restricted` is a join, and the reverse is a leave. Reason: Telegram sends them reliably for every join route, including invite links and admin adds. Service messages (`new_chat_members`) can be missing or hidden in large supergroups. The cost is two owner actions: the bot stays a group **admin**, which feature 1 setup already requires, and the webhook is **re-registered** with `chat_member` in `allowed_updates`.
- **Batching uses the existing 5-minute cron**, as a new isolated job in `runScheduled`. Reason: no new Durable Object class means no `wrangler.toml` migration. Every mention in a freshly *sent* message notifies the newcomer, whereas mentions added by *editing* a message don't. It also costs nothing extra on the free plan.
  - The job takes the waiting list with one atomic delete-and-return, so an overlapping cron run can't post the same people twice.
- **Join/leave handling runs directly in the webhook request, not through the per-learner Durable Object.** Reason: it's one small database write, or a few DMs sent after the response returns. There's no learner session involved, and the Durable Object is keyed per learner for the question pipeline.
- **Settings are one database row, edited from a new dashboard route.** Reason: the text changes without a redeploy, and the dashboard already provides authenticated, CSRF-protected forms. Nothing new is added to `wrangler.toml`. That file holds your uncommitted local values.
- **Mentions use `text_mention` entities and no `parse_mode`**, as in feature 2. Reason: they work for users without a username, and the admin's template can't inject markup.
- **Leave notices go to the dashboard users** (config owners plus active added users) through a new recipient helper. Reason: the intent names dashboard users specifically. Feature 2's `followupRecipients` also includes `MENTOR_IDS`, which is a different set.

**Relation to earlier features.** Feature 1, AC 1 ("a group message without `#askAI` produces no bot action") still holds. `chat_member` updates aren't messages, and service messages keep being ignored. Feature 2's dashboard gains one page, under its existing auth rules. No earlier decision is contradicted.

## Data
- **Welcome settings** (new): one row holding the template text, welcome topic ID (nullable), welcome on/off, leave-notice on/off, last edited by (email) and last edited at. Not personal data apart from the editor's email.
- **Welcome waiting list** (new): Telegram user ID, display name and joined-at, one row per person. Personal data, kept only until the welcome is posted (minutes). Rows older than 24 h are purged in case the post keeps failing.
- **Leaves are not stored.** The DM is sent and nothing is recorded.
- No change to learner tables. A newcomer isn't a `learners` row until they use the bot.
- **Config:** no new vars or secrets. `BOT_USERNAME` and `GROUP_CHAT_ID` are reused. The Telegram webhook's `allowed_updates` gains `chat_member` (owner action).

## Acceptance criteria
1. A `chat_member` update in the cohort group where a non-bot user goes from `left` or `kicked` to `member` or `restricted` adds that user to the waiting list, and **no** message is sent during the webhook request.
2. The same update for a bot, or from a chat other than `GROUP_CHAT_ID`, changes nothing and sends nothing.
3. A cron run with N waiting newcomers (1 ≤ N ≤ 50) sends **exactly one** `sendMessage` to `GROUP_CHAT_ID`:
   - in the configured topic (`message_thread_id`), or with none when no topic is set;
   - with text from the current template, `{nama}` replaced by all N names and `{bot}` by `@BOT_USERNAME`;
   - with exactly one `text_mention` entity per newcomer, at the right offset and length;
   - with no `parse_mode`.

   The waiting list is then empty, and the next cron run sends nothing.
4. 51 to 100 waiting newcomers produce exactly two messages, splitting the names 50 + the rest.
5. A user who joins and then leaves before the cron run isn't welcomed. Joining twice before the cron run gives one mention. A user who joins, is welcomed, leaves and joins again is welcomed again on the next run.
6. A `chat_member` update in the cohort group where a non-bot user goes to `left` or `kicked` sends exactly one DM to each dashboard user (config owners ∪ active added users, each once) that names the user. No message goes to the group or to a `MENTOR_IDS` entry who isn't a dashboard user. `left` says "keluar" and `kicked` says "dikeluarkan".
7. With welcomes switched off, a join adds nothing to the waiting list and the cron sends nothing. With leave notices switched off, a leave sends no DM.
8. With no saved settings, the default template is used. It contains `{nama}` and `{bot}`, mentions Start and `#askAI`, and renders in Bahasa Indonesia.
9. `GET /dashboard/sambutan` without a session redirects to login. A `POST` without a valid CSRF token or `Origin` returns 403 and changes nothing. A signed-in user's valid save is stored, along with their email and the time, and the next cron welcome uses the new text and topic.
10. Saving a template longer than 1000 characters, one without `{nama}`, or a non-numeric topic ID is refused, and the stored settings are unchanged.
11. A template containing `<b>` and `<script>` is sent to Telegram verbatim as plain text, and rendered escaped on the dashboard page.
12. The Sambutan page passes the same markup checks as feature 2, AC 21 (labels, 44 px tap targets, viewport). In Playwright at 360 px it has no horizontal scroll, and saving a template round-trips.
13. Migration `0005` applies on top of `0001`–`0004` in PGlite. The take-the-waiting-list function returns each waiting user exactly once even when called twice. Waiting rows older than 24 h are purged. The existing test suites pass unchanged.
14. Regression: a group `message` update carrying `new_chat_members` or `left_chat_member` and no `#askAI` still produces no bot action (feature 1, AC 1).
15. If the welcome cron job throws, the other cron jobs (expire sessions, memory job, deferred images) still run.

## Flagged concerns
- **Privacy, leave notices name people to staff.** A learner's name and username are DMed to every dashboard user when they leave. That's staff-only and not stored, but it's a new use of learner data. **Decides: program owner**, alongside feature 1's UU PDP sign-off.
- **Privacy, the waiting list** briefly stores the names of people who may never use the bot, so they've never seen the privacy notice. It's held for minutes and purged within 24 h at most. **Decides: program owner.**
- **Telegram permissions.** `chat_member` updates require the bot to be a group admin and the webhook to list `chat_member`. If either is missing, the feature silently does nothing. The setup doc makes this a checklist item, and the dashboard page shows a hint about it. **Decides: project owner (Kharisma)**, at deploy.
- **UX, the welcome can arrive up to ~5 minutes after the join,** and a batch that straddles a cron tick gets two messages. This is accepted in exchange for no new infrastructure and notifying mentions. **Decides: project owner**, by approving this spec.
- **Brand.** The default text avoids the "IBM SkillBuild" name, but admins can type whatever they like. **Decides: program owner.**
- **Abuse.** Any dashboard user can change what the bot posts publicly to the whole cohort. Edits record who made them. Removing a misbehaving dashboard user is feature 2's existing control. **Decides: project owner.**
- **Accessibility:** the same markup and layout rules as feature 2 apply (AC 12). None found beyond that. I checked labels, tap targets, the live counter (plain text, no script, since the dashboard CSP forbids JS) and the no-JS forms.
- **Free-tier ceilings:** none found. That's one database write per join, at most a few cron sends every 5 minutes, and a few DMs per leave.

## Out of scope
- Deleting Telegram's join and leave service messages.
- DMing the welcome to newcomers.
- Posting a goodbye in the group.
- Per-topic or per-person welcome texts, images or buttons in the welcome.
- A join/leave history or statistics page.
- Telegram's join-request approval flow.
- Any group other than the configured cohort group.
- Changing the webhook registration itself. That's an owner action, documented in setup.
- Production deployment.

## Resolved questions
1. *How is the ~5-minute batch window implemented on the free Worker?* → It uses the existing 5-minute cron as a new isolated job. Joins go on a waiting list in Postgres, and each cron run posts and clears it atomically. No new Durable Object and no `wrangler.toml` change. Posting fresh messages rather than editing one keeps mentions notifying.
2. *Which Telegram update does the bot rely on, and should "X joined" messages be deleted?* → `chat_member` updates. They need admin rights and `chat_member` in `allowed_updates`, both owner actions. Service messages aren't deleted, and Telegram's own group setting can hide them.
3. *What is the default text, and which placeholders exist?* → The default is under Behaviour. The placeholders are `{nama}` (required; the newcomer mentions) and `{bot}` (`@BOT_USERNAME`).
4. *Which topic does the welcome go to, and where is that set?* → A topic ID set on the dashboard's Sambutan page. If it's blank, the welcome goes to General.
5. *Is someone who joins and leaves within the window welcomed, and is a rejoin welcomed again?* → Joining and then leaving before the post means no welcome, and the leave notice is still sent. A rejoin after being welcomed is welcomed again. A duplicate join within one window gives one mention.
6. *Are joins and leaves stored, and for how long?* → Joins sit on the waiting list only until posted, purged after 24 h at the latest. Leaves aren't stored. Flagged for the program owner.
7. *Can admins switch welcomes off?* → Yes. There are two switches on the Sambutan page, one for welcomes and one for leave notices. With welcomes off, joins aren't queued at all.
