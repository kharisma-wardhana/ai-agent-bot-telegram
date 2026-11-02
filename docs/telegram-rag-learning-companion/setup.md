# Setup: Kak Skilly Telegram learning companion
*Author: Kharisma Wardhana. Stage: Build. Written: 2026-11-02. Via /aspec:make-it-simple-v2.*
*Implements: docs/telegram-rag-learning-companion/plan.md, step 17*

Every step here is an **owner action** taken outside the repo. Nothing in this repository deploys itself. All services are on free tiers. Secrets are referred to **by name only**: never commit their values.

## 0. Accounts (all free)
Telegram, Cloudflare (Workers, Durable Objects, R2, Workers AI, Tunnel), Supabase, Kaggle (phone-verified, for GPU), Hugging Face (optional, if the model repo needs a token).

## 1. Telegram bot
1. In @BotFather: `/newbot`. Keep the token as **`TELEGRAM_BOT_TOKEN`**. Note the username for **`BOT_USERNAME`**.
2. `/setprivacy` → *Disable*. The bot must read group messages to see `#askAI`.
3. `/setcommands`: `start - Mulai`, `add_knowledge - (mentor) tambah materi`, `hapusdata - Hapus semua dataku`.
4. Add the bot to the cohort group (forum topics on) **as admin**. Admin rights are needed to receive reactions and to reply in topics.
5. Get the group ID (`-100…`), e.g. from the first update the webhook receives → **`GROUP_CHAT_ID`**.
6. Collect mentor Telegram user IDs → **`MENTOR_IDS`** (comma-separated) and **`KNOWLEDGE_WHITELIST_IDS`**. Each mentor must press **Start** on the bot once, or Telegram blocks follow-up DMs to them.

## 2. Supabase (Postgres + pgvector)
1. Create a project (choose the Singapore region, closest to Indonesia).
2. SQL editor → run, **in order**: `db/migrations/0001_init.sql`, `0002_functions.sql`, `0003_repository_rpc.sql`.
3. Settings → API: **`SUPABASE_URL`** and the **service_role** key → **`SUPABASE_SERVICE_KEY`**. The service key bypasses row-level security: it lives only in Worker/Kaggle secrets.
4. Free-tier note: projects pause after ~7 days without activity. The Kaggle heartbeat and the Worker cron keep it active while the bot is in use.

## 3. Cloudflare
1. **R2**: create bucket `skilly-knowledge`. Create an R2 API token (Object Read only, this bucket) → **`R2_ACCESS_KEY_ID`**, **`R2_SECRET_ACCESS_KEY`** (Kaggle only).
2. **Workers AI token**: an API token with *Workers AI: Read* → **`CF_API_TOKEN`**. Account ID → **`CF_ACCOUNT_ID`**. Used by the seed CLI and the Kaggle ingest loop for bge-m3 embeddings.
3. **Tunnel**: Zero Trust → Networks → Tunnels → create a *named* tunnel. Public hostname e.g. `skilly-llm.<your-domain>` → service `http://localhost:8080`. Keep the tunnel token as **`CF_TUNNEL_TOKEN`** (Kaggle only). The hostname becomes **`KAGGLE_BASE_URL`**. A named tunnel needs a domain on Cloudflare. A quick tunnel's URL changes on every run, so it doesn't fit here.
4. Generate two random secrets (e.g. `openssl rand -hex 32`): **`TELEGRAM_WEBHOOK_SECRET`** and **`KAGGLE_SHARED_SECRET`** (same value as Kaggle's `SKILLY_SHARED_SECRET`). Generate one token per mentor for MCP → **`MCP_TOKENS`** (comma-separated).

## 4. Worker
1. Edit `worker/wrangler.toml` `[vars]`: `BOT_USERNAME`, `GROUP_CHAT_ID`, `MENTOR_IDS`, `KNOWLEDGE_WHITELIST_IDS`, `SUPABASE_URL`, `KAGGLE_BASE_URL`. Tune `RETRIEVAL_THRESHOLD` after the eval (§7).
2. Secrets: `pnpm -C worker exec wrangler secret put <NAME>` for `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `SUPABASE_SERVICE_KEY`, `KAGGLE_SHARED_SECRET`, `MCP_TOKENS`.
3. Deploy: `pnpm -C worker exec wrangler deploy`. This creates the Durable Object class (migration `v1`) and the 5-minute cron.
4. Register the webhook (run it yourself; the token is in the URL):
   `curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" -d url=https://<worker-host>/telegram/webhook -d secret_token=$TELEGRAM_WEBHOOK_SECRET -d 'allowed_updates=["message","callback_query","message_reaction"]'`

## 5. Seed the lesson corpus
`SUPABASE_URL=… SUPABASE_SERVICE_KEY=… CF_ACCOUNT_ID=… CF_API_TOKEN=… uv run --project ingest skilly-seed lesson-docs`
Try `--dry-run` first: it needs no network and prints per-file chunk counts. Re-running is safe, because unchanged files are skipped by content hash. The `.jpg` is skipped by design. The glossary is read from its saved `_files/pdfplayer.html`, which may hold only part of the 4-page glossary: if answers miss glossary terms, add the full glossary PDF with `/add_knowledge`.

## 6. Kaggle (GPU inference + PDF/HTML ingest)
1. New notebook → import `kaggle/notebook.ipynb`. Accelerator **GPU T4 x2**, Internet **on**.
2. Add-ons → Secrets: `SKILLY_SHARED_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `TELEGRAM_BOT_TOKEN`, `CF_TUNNEL_TOKEN`, `REPO_URL`.
3. In cell 2, **pin** `VLLM_VERSION` (a release with Qwen3-VL support, at least two weeks old) and `CLOUDFLARED_VERSION`. The cell refuses to run with placeholders.
4. Run all. Within a few minutes `serve.log` shows the proxy up, and the heartbeat starts. The Worker then routes to Kaggle automatically. When the session ends (12 h cap, ~30 GPU-h/week), the Worker falls back to Workers AI within 90 s. Image questions and PDF/HTML ingestion wait for the next session.

## 7. Evaluate before go-live (AC 4, 5, 6, 7, 8, 21)
Use a **staging** bot and Supabase project with `MENTOR_IDS` set to your own ID, because out-of-scope questions DM mentors. Press Start on the staging bot with your test account, then:
`EVAL_WEBHOOK_URL=… EVAL_WEBHOOK_SECRET=… EVAL_LEARNER_ID=… SUPABASE_URL=… SUPABASE_SERVICE_KEY=… uv run --project eval python eval/run_eval.py`
It prints a pass/fail table per criterion. If in-scope answers fall back too often, lower `RETRIEVAL_THRESHOLD`; if out-of-scope questions get answered, raise it. Run once with Kaggle online, and once offline (Workers AI only).

## 8. Assumptions to verify on first deploy
These came from documentation knowledge, not a live check (this build never reached a live service):
- Workers AI model IDs `@cf/qwen/qwen3-30b-a3b-fp8`, `@cf/baai/bge-m3` (1024-dim), `@cf/openai/whisper-large-v3-turbo` are available on your account, and Whisper accepts Telegram's OGG/Opus voice notes.
- The Hugging Face repo `Qwen/Qwen3-VL-8B-Instruct-AWQ` exists and fits 2×T4 in fp16. If not, set `SKILLY_MODEL` to an available quantized Qwen3-VL-8B build.
- The free Workers plan's 10 ms CPU limit holds for the webhook and alarm paths. If you see CPU-limit errors, move the heaviest step (PDF parsing already runs on Kaggle) or upgrade.
- Streaming uses `editMessageText` at ~1 edit/s. Bot API `sendMessageDraft` isn't used.

## 9. Rollback
- Worker: `pnpm -C worker exec wrangler rollback` (previous version), or `deleteWebhook` to silence the bot instantly.
- Kaggle: stop the notebook. The Worker falls back to Workers AI by itself.
- Data: the migrations only add objects. To remove the feature entirely, drop its functions and tables (sessions-side first: `feedback`, `mentor_followups`, `pending_answers`, `session_turns`, `memory_edges`, `memory_nodes`, `sessions`, `learners`, then `knowledge_chunks`, `knowledge_sources`, `ingest_jobs`, `inference_heartbeat`).
