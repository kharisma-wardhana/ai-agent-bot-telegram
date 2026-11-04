# Spec: Mentors handle every follow-up question from one phone-friendly web dashboard, and the bot delivers their reply to the learner
*Author: Kharisma Wardhana. Stage: Design. Written: 2026-11-03. Via /aspec:make-it-simple-v2.*
*Implements: docs/mentor-followup-dashboard/intent.md*

## Behaviour

### Who can use it
A **dashboard user** has an email address and a Telegram account. All dashboard users have the same rights, whether they are the owner, an admin or a mentor:
- view the list
- claim, release and reply to questions
- add a reply to the knowledge base
- add and remove mentors

There are two kinds of dashboard user:
- **Bootstrap users** are listed in Worker config as `email → Telegram ID` pairs. They can't be removed from the dashboard.
- **Added users** are created from the dashboard. Any dashboard user can remove them.

### Logging in (Telegram magic link)
1. The user opens `/dashboard` on their phone and types their email.
2. If the email belongs to an active dashboard user, the bot DMs that user's Telegram account a one-time login link, valid for 10 minutes. The page always shows the same text ("Kalau email terdaftar, link masuk sudah dikirim ke Telegram kamu"), whether or not the email is known.
3. Opening the link shows a "Masuk" button. Pressing it consumes the link and starts a dashboard session that lasts 7 days.
   - The link is only consumed by the button press, never by merely opening the URL. Telegram and in-app browsers may fetch links on their own, and that must not use up the link.
4. "Keluar" ends the session. Removing a user ends all of their sessions at once.

At most 3 login links are sent per email per 15 minutes. Further requests show the same page but send nothing.

### The follow-up list
- Every follow-up created **after this feature ships** appears. Older follow-ups don't.
- Each entry shows:
  - the question text (for voice questions, the transcript)
  - the image, if the question had one
  - the topic it came from, or "lewat DM"
  - when it was asked
  - the status: **Terbuka** (open), **Diklaim oleh <nama pengguna dashboard>** (claimed by a dashboard user), or **Selesai** (closed)
- No learner identity appears anywhere on the dashboard: no name, username, Telegram ID or message link.
- By default the list shows open and claimed questions, newest first. A "Selesai" tab shows closed questions with their replies.
- All UI text is in Bahasa Indonesia, and the layout is designed for a phone screen first.

### Claiming
- **Klaim** on an open question makes it claimed by you. If two users press it at the same moment, exactly one succeeds. The other sees "Sudah diklaim oleh <nama>".
- The claimer can **Lepas** (release) the question, which makes it open again.
- A claim with no reply after **24 hours** lapses automatically and the question shows as open again.
- Only the current claimer can reply.

### Replying
1. The claimer types a reply of up to 900 characters and presses **Kirim**.
2. The bot sends the learner a DM: a fixed Kak Skilly header ("Kak Skilly di sini 👋 Mentor sudah menjawab pertanyaanmu:"), then the question, then the mentor's reply verbatim. The whole message is ≤ 1000 characters.
   - If the learner has never started the bot, the message is held and delivered when they press Start. This is the same held-answer path feature 1 uses.
3. If the question came from a group topic, the bot also posts the reply in that topic. The post replies to the learner's original message and tags the learner with a Telegram mention.
   - If the original message was deleted, the post goes to the topic without the reply link.
4. The question becomes **Selesai**, with the reply and the replier recorded.
5. Replies are not rewritten by the model: the mentor's text is sent exactly as typed. A closed reply can't be edited or resent.

If the DM or the topic post fails for any reason other than "learner hasn't started", the question still closes. The dashboard then shows which delivery failed, so a mentor can follow up by hand.

### Adding a reply to the knowledge base
- A closed question shows a **Tambahkan ke pengetahuan** button. Pressing it asks for confirmation.
- It then appends one new knowledge entry: title "Follow-up mentor: <first words of the question>", content "Pertanyaan: … / Jawaban mentor: …". This uses the same append-only path as `/add_knowledge`, and the bot can answer that question from then on.
- Pressing it again adds nothing; the system reports "sudah ada".
- Nothing is added automatically, and an added entry can't be removed from the dashboard.

### Managing mentors
A **Mentor** page lists dashboard users by name and email.
- Any user can add a new one by entering a name, an email and a Telegram ID.
- Any user can remove an added user.
- Bootstrap users show as "pemilik (config)" and have no remove button.

### Mentor DMs for new follow-ups
These continue as they do today, with two changes:
- The DM goes to the union of the configured `MENTOR_IDS` and every active dashboard user's Telegram ID, with each person messaged once.
- The DM gains a link to that question on the dashboard.

## Architecture and the reason for it
`docs/tech.md` and `docs/structure.md` don't exist, so this conforms to the stack feature 1 settled.

**Departure from feature 1.** `telegram-rag-learning-companion/spec.md` → `## Out of scope` lists "A web admin dashboard. Metrics are SQL views only." This feature adds a web dashboard. The scope is limited to follow-ups and dashboard users, with no metrics. Feature 1's line stays true for metrics, which remain SQL views only. This departure is listed under Flagged concerns.

- **Served by the existing Worker under `/dashboard`, as server-rendered HTML pages with plain form posts and a little inline JavaScript. No SPA framework and no build step.** Reason: zero extra hosting on the free plan, one deploy, and fast to load on a phone in Telegram's in-app browser. About 10 items a week needs no client-side state.
- **Telegram magic-link login, not email delivery or third-party auth.** Reason: it's free and needs no email-sending service. Every dashboard user already has a Telegram account, and on a phone the link opens straight from the Telegram chat. The email whitelist serves as the identifier, and owning the Telegram account is the proof of identity.
- **Login tokens and sessions are random 256-bit values. Only their SHA-256 hash is stored in Postgres.** The session is an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. Reason: a leaked database row can't be replayed. Postgres is already the system of record, and Workers KV would add a second store.
- **Every state-changing request checks the session, a per-session CSRF token and the `Origin` header.** Every page HTML-escapes all stored text. Reason: question and reply text is untrusted input rendered in a browser.
- **Claiming is a single conditional update that succeeds only if the question is open, or its claim is older than 24 hours.** Reason: this makes the two-mentors race impossible without locks or a Durable Object.
- **Lapsed claims are worked out when the list is read, not by the cron job.** Reason: no extra scheduled work, and the result is always correct at read time.
- **Reply delivery reuses the existing Telegram client and the `pending_answers` "not_started" path.** Reason: held delivery on Start already works and is tested (feature 1, AC 12).
  - The question is moved to closed before anything is sent. Reason: a double tap can't send the same reply twice.
- **Images are streamed through an authenticated Worker endpoint.** The endpoint resolves the stored Telegram `file_id` on each view and is never cached. Reason: the bot token stays on the server, the image is never stored by us, and only signed-in users can see it.
- **"Add to knowledge" calls the same chunk → embed → insert path `/add_knowledge` uses**, with `origin = add_knowledge` and `added_by` set to the dashboard user's Telegram ID. Reason: one ingestion path, and its existing content hash already prevents duplicates.
- **Bootstrap users come from a new Worker var. Added users live in a new Postgres table.** Reason: the owner can never lock themselves out, and "add/remove mentor" works at runtime without a redeploy.
- **The public base URL for links comes from a new Worker var.** Reason: the Worker can't reliably know its own public hostname behind custom domains.

## Data
- **Dashboard users** (new): display name, email (lower-cased, unique), Telegram ID, kind (bootstrap is mirrored from config at read time and not stored; added users are stored), added by, added at, removed at. Personal data of staff. Kept until the user is removed, plus 90 days.
- **Login links** (new): hash of the token, user, created at, expires at (+10 min), used at. Operational. Purged after 24 h.
- **Dashboard sessions** (new): hash of the session ID, hash of the CSRF token, user, created at, expires at (+7 days), revoked at. Operational. Purged after expiry.
- **Mentor follow-ups** (extended, additively):
  - existing fields: session, question, mentors notified, status
  - new fields: dashboard-visible flag (false for every row that existed before the migration), photo file reference, claimed by, claimed at, reply text, replied by, replied at, DM delivery result, topic delivery result, knowledge entry reference
  - status gains the values `claimed` and `closed`; the old `resolved` value stays valid
  - A follow-up still belongs to a learner session. `/hapusdata` deletes it through the existing cascade. The topic post already sent in the group is not deleted.
- **The learner's name and Telegram ID** are read only server-side, from `sessions`/`learners`, to address the DM and the mention. They are never sent to the browser.
- **Config**:
  - new var `DASHBOARD_OWNERS` (`email:telegramId` pairs, comma-separated)
  - new var `DASHBOARD_BASE_URL`
  - no new secrets

## Acceptance criteria
1. `GET /dashboard` and every `/dashboard/*` route except the login page, the login-link page and static assets return a redirect to the login page (HTML), or 401 (JSON/image), when there is no valid session cookie.
2. Submitting a whitelisted email to the login form makes the bot send exactly one DM, to that user's Telegram ID, containing a `/dashboard/auth?t=…` link. Submitting an unknown email sends no DM. Both responses have identical status and body.
3. A 4th login request for the same email within 15 minutes sends no DM.
4. A `GET` of the login link does not consume it. A `POST` from its "Masuk" button creates a session cookie with `HttpOnly`, `Secure` and `SameSite=Strict`. A second `POST` with the same token, or a `POST` after 10 minutes, is refused and creates no session.
5. The database never contains a raw login token or session ID, only their hashes. Checked by a test that searches the stored rows for the raw value.
6. Every state-changing dashboard `POST` without a matching CSRF token, or with a foreign `Origin`, is rejected with 403 and changes nothing.
7. Removing an added user immediately makes every one of that user's existing sessions return the unauthenticated response. A bootstrap user can't be removed (403, nothing changes).
8. A follow-up created by the fallback after the migration appears in the list. A follow-up that existed before the migration doesn't.
9. The HTML and JSON returned by every dashboard route contain no learner display name, username or Telegram ID, and no `t.me` message link. Checked by a test whose learner has distinctive name and ID values.
10. Of two concurrent claims on the same open question, exactly one succeeds. The other gets "sudah diklaim" and the claimer is unchanged.
11. A claim older than 24 hours with no reply shows as open, and another user can claim it. A non-claimer's reply to a question claimed less than 24 hours ago is rejected and nothing is sent.
12. A reply to a topic question from a learner who has started the bot produces:
    - one DM to the learner containing the header, the question and the reply, ≤ 1000 characters in total;
    - one message in the original topic that replies to the learner's original message and contains a mention entity for the learner's Telegram ID;
    - status `closed`, with the replier recorded.
13. A reply to a learner who hasn't started the bot sends no DM. It creates a `pending_answers` row with reason `not_started`, and pressing Start delivers it (the same mechanism as feature 1, AC 12).
14. A reply longer than 900 characters is rejected and nothing is sent. Submitting the same reply twice sends exactly one DM and one topic post.
15. When the topic post fails, the question is still `closed`, the DM is still sent, and the dashboard shows the failed delivery.
16. "Tambahkan ke pengetahuan" on a closed question adds exactly one knowledge source with `origin = add_knowledge`, and a later #askAI question with the same wording retrieves its chunk above the retrieval threshold. Pressing it a second time adds nothing. Existing knowledge chunk rows are unchanged.
17. "Tambahkan ke pengetahuan" on a question that is not closed is rejected.
18. A new fallback DMs each Telegram ID in `MENTOR_IDS ∪ active dashboard users` exactly once, and the DM contains the dashboard link to that follow-up.
19. The image endpoint returns the image for a signed-in user, returns 401 without a session, and the response body and headers contain no bot token.
20. Question text containing `<script>` is rendered escaped on every dashboard page.
21. All dashboard pages render without horizontal scrolling at 360 px width. Every form control has a label, and every tap target is at least 44 × 44 px. Checked by a markup test of the rendered HTML (no browser test).
22. The migration is a new file, and it applies cleanly on top of `0001`–`0003` in PGlite with pgvector. The existing repository regression tests still pass.

## Flagged concerns
- **Architecture departure from feature 1**: feature 1's spec ruled out "a web admin dashboard". This adds one, limited to follow-ups and dashboard users. **Decides: project owner (Kharisma)**, by approving this spec.
- **Privacy, learner data on a web page**: question text is shown with no identity, but learners sometimes write identifying details inside the question itself. Images may show faces or names. The dashboard is behind login, and pages are marked no-store so they aren't cached. **Decides: program owner**, the same owner as feature 1's UU PDP concern.
- **Privacy, public reply with a mention**: the mentor's answer is posted publicly in the topic and tags the learner. The learner asked publicly, but the mentor might write something personal. The reply box shows the hint "Balasan ini juga diposting di topik grup". **Decides: mentor team.**
- **Privacy, image retention**: feature 1 promised raw images are never stored. This feature stores only Telegram's `file_id` reference, and Telegram, not us, keeps the file. This is a change to that promise worth stating in the privacy notice. **Decides: program owner.**
- **Security, magic-link login**: the risks are link prefetch, email enumeration, session theft, CSRF, and XSS from learner text. Mitigations are in Architecture and ACs 2–7, 20. The whole login depends on the Telegram account, so someone who takes over a mentor's Telegram account takes over their dashboard access. **Decides: engineering (REVIEW.md).**
- **Security, any user can add users**: by design all roles are equal. One compromised dashboard account can add others. Bootstrap users can't be removed, so the owner keeps control. **Decides: project owner.**
- **Knowledge quality**: a mentor-triggered entry can't be undone from the dashboard, because lesson-docs is append-only. A wrong answer stays searchable until removed in the database by hand. **Decides: mentor team**, who should add only answers they'd want repeated.
- **Brand**: the relayed reply is sent under the Kak Skilly header, but the content is the mentor's own words, not the bot's. **Decides: program owner.**
- **Accessibility**: the dashboard targets phones. ACs 21 cover labels, tap targets and no horizontal scroll. Colour contrast will be checked against WCAG AA in review. Screen-reader support has had only a markup-level check.
- **Free-tier ceilings**: about 10 follow-ups a week and 2–3 users add negligible Worker requests, CPU and Supabase rows. None found beyond feature 1's.

## Out of scope
- Metrics or analytics on the dashboard. Feature 1's SQL views stay the place for those.
- Backfilling follow-ups created before this feature.
- Reminders or nudges for unanswered or long-claimed questions. The only automatic change is the 24-hour claim lapse.
- Editing or resending a reply after it is closed.
- Removing knowledge entries from the dashboard.
- Different permissions per role.
- Replying with images, files or voice. Replies are text only.
- Model rewriting or translating mentor replies.
- Login methods other than the Telegram magic link.
- The `cohort-welcome-message` feature, which is the next chain.
- Production deployment and setting the new Worker vars, which are the owner's actions after this chain.

## Resolved questions
1. *How is ownership of a whitelisted email proven at login, on the free tier?* → Telegram magic link. The email is looked up in the whitelist (bootstrap config plus added users), the bot DMs a one-time link to that user's Telegram ID, and pressing "Masuk" consumes it. Chosen by the project owner on 2026-11-03.
2. *What happens to a claimed question that is never answered?* → The claimer can release it. Otherwise the claim lapses after 24 hours and the question shows as open again. No reminder is sent.
3. *How does "add/remove mentor" relate to the email whitelist and the Telegram IDs?* → A dashboard user is one record of name, email and Telegram ID. The email is the login whitelist, and the Telegram ID both receives the login link and receives follow-up DMs. Bootstrap users live in config and can't be removed; added users live in the database. `MENTOR_IDS` keeps working, and DMs go to the union.
4. *What is written to lesson-docs on "add to knowledge", and can it be undone?* → One text entry with the question and the mentor's reply, under the title "Follow-up mentor: …", through the `/add_knowledge` path, de-duplicated by content hash. It can't be undone from the dashboard, because the corpus is append-only.
5. *Can images be shown without leaking learner identity or the bot token?* → Yes. Only the `file_id` is stored, and the Worker streams the image through an authenticated endpoint without caching it. The bot token never reaches the browser. The image itself may still contain identifying content (flagged).
6. *Can a reply be edited or resent after it's closed?* → No. A delivery failure is shown on the dashboard, and a mentor follows up by hand.
