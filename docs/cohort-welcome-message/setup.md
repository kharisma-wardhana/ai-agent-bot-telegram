# Setup: cohort welcome and leave notices
*Author: Kharisma Wardhana. Stage: Build. Written: 2026-11-03. Via /aspec:make-it-simple-v2.*
*Implements: docs/cohort-welcome-message/plan.md, step 7*

Every step here is an **owner action** taken outside the repo. It builds on [feature 1's setup](../telegram-rag-learning-companion/setup.md) and [the dashboard setup](../mentor-followup-dashboard/setup.md). The dashboard must already work. No new secrets, vars or paid services are needed, and `wrangler.toml` doesn't change.

## 1. Apply the migration
Supabase → SQL editor → run `db/migrations/0005_cohort_welcome.sql` **once**, after `0001`–`0004`. It only adds two tables (`welcome_settings` and `pending_welcomes`) and their functions. Apply it **before** deploying the new Worker.

## 2. Telegram: admin rights and `chat_member` updates
If either of these is missing, the feature silently does nothing.

1. The bot must be an **admin** of the cohort group. Feature 1 already requires this. Telegram only sends member changes to admin bots.
2. **Re-register the webhook** with `chat_member` added to `allowed_updates`. Run this yourself; the token is in the URL:

   ```
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -d url=https://<worker-host>/telegram/webhook \
     -d secret_token=$TELEGRAM_WEBHOOK_SECRET \
     -d 'allowed_updates=["message","callback_query","message_reaction","chat_member"]'
   ```

   Then check that `getWebhookInfo` lists all four in `allowed_updates`.

## 3. Deploy and configure
1. `pnpm -C worker exec wrangler deploy`. The existing 5-minute cron now also posts welcomes.
2. On your phone, open `/dashboard` → **Sambutan**:
   - **Teks sambutan:** keep the default, or write your own. It must contain `{nama}`, which becomes the newcomers' names, each mentioned. `{bot}` becomes the bot's `@username`. Max. 1000 characters. It's sent exactly as typed, as plain text.
   - **ID topik sambutan:** the forum topic for welcomes, or blank for General. The ID is the number after `t.me/c/<group>/` in a link to any message in that topic.
   - **Sambut anggota baru** / **Kabari saat ada yang keluar:** the two on/off switches.
3. Test it with a second Telegram account: join the group, wait up to 5 minutes, and the welcome appears. Leave the group, and every dashboard user gets a DM.

## 4. Before a mass import of members
If you add many people at once and don't want a welcome for them, switch **Sambut anggota baru** off first. Joins aren't queued while it's off, and anyone already waiting is dropped at the next tick rather than posted. Switch it back on afterwards.

## 5. Verify locally (no network)
```
pnpm -C worker test        # includes welcome.test.ts (webhook + cron) and dashboard-welcome.test.ts
pnpm -C worker test:e2e    # includes the Sambutan flow at 360 px
pnpm -C worker typecheck
```

## 6. Rollback
- Redeploy the previous Worker version. Old code ignores `chat_member` updates, so nothing is posted.
- Optionally, re-register the webhook without `chat_member`.
- Leave migration `0005` applied, since nothing else reads it. To remove it later, write a **new** migration that drops the two tables. Never edit `0005`.
