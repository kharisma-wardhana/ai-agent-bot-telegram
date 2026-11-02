# Spec: Learners get fast, grounded answers to #askAI questions in Telegram, and unanswerable ones reach a mentor
*Author: Kharisma Wardhana. Stage: Design. Written: 2026-11-02. Via /aspec:make-it-simple-v2.*
*Implements: docs/telegram-rag-learning-companion/intent.md*

## Behaviour

### Asking a question
1. A learner posts a message in any forum topic of the cohort group containing the hashtag `#askAI`. The message may be text, a photo (with or without caption), or a voice note/audio file. Messages without `#askAI` are ignored.
2. The bot answers by **DM** to that learner, never in the topic (except the two topic notices below).
3. In the DM the bot shows live progress as one message updated in place:
   `✅ Pertanyaan diterima` → `🎧 Mentranskrip audio` / `🖼️ Membaca gambar` (only when relevant) → `🔎 Sedang mencari dokumen terkait` → `✍️ Menyusun jawaban` → the answer, streamed as it is generated.
4. The final answer is in Bahasa Indonesia, text only, **at most 1000 characters**, and ends with a short source line naming the lesson-docs file(s) it came from.
5. Under the final answer the bot asks for feedback: inline buttons (👍 / 👎), or the learner may react with an emoji (✅ 👍 👎) or reply with text. Feedback closes the session.
6. Follow-up questions sent by DM within the open session continue the same conversation (session memory). A new `#askAI` post after the session closed starts a new session.

### When lesson-docs has no answer
7. If nothing relevant is found, the bot:
   - replies **in the same topic** to the learner's post with exactly: `Saya tidak punya data terkait pertanyaan tersebut, akan saya follow up ke mentor`
   - DMs every configured mentor with the learner's name/handle, the topic, the question (transcribed text for audio, plus the image for photos) and a link to the original post.
   It does **not** generate a speculative answer.

### When the bot cannot DM the learner
8. If the learner has never started the bot, the bot replies in the topic with a short notice and a deep link (`t.me/<bot>?start=q_<id>`). The prepared answer is held and delivered as soon as the learner presses Start.

### Growing the knowledge base
9. A whitelisted mentor sends `/add_knowledge` by DM (Telegram commands cannot contain hyphens; `/addknowledge` is accepted too), either followed by text, or as the caption of an attached `.md`, `.txt`, `.pdf` or `.html` file. The bot confirms receipt, indexes the content, and confirms again with the number of chunks added. Content is **appended**. Nothing existing is edited or removed. Non-whitelisted users get a polite refusal.

### Memory
10. **Session memory**: every turn of a session is remembered for 24 hours from the session's last activity. A session ends on feedback or on expiry.
11. **Long-term memory**: when a session ends, a background job distils it into a per-learner knowledge graph (e.g. learner — *struggles with* → "embedding"; learner — *asked about* → "prompt chaining"). Sessions that expired with no feedback are saved with lower weight. Later answers may use this memory to personalise the explanation level, but facts in answers still come only from lesson-docs.
12. `/hapusdata` in DM deletes that learner's sessions and long-term memory. The first DM a learner ever receives includes a one-time privacy notice mentioning it.

### Persona, skills, tools, MCP
13. The bot speaks as **"Kak Skilly"**, a friendly, encouraging teaching assistant. Casual-polite Indonesian ("kamu"), plain language for non-IT learners, more technical depth on request.
14. **Skills**: four prompt packs the model picks from per question: `jelaskan-konsep`, `contoh-kode`, `ringkas-materi`, `latihan-soal`.
15. **Tool calling**: the model may call `search_lesson_docs`, `recall_memory` and `escalate_to_mentor`.
16. **MCP**: the same three tools are exposed as an authenticated MCP server so mentors can use the knowledge base from an MCP client. No external MCP servers are consumed in v1.

### Availability
17. When the Kaggle GPU is online, it serves the model. When it is offline, text and audio questions are served by the free Cloudflare Workers AI Qwen model with no visible difference except speed. Image questions during Kaggle downtime are queued, and the learner is told the answer will be delayed.

## Architecture and the reason for it
No `docs/tech.md` or `docs/structure.md` exists, so there is nothing to conform to.

- **Cloudflare Worker (TypeScript, Hono) as the always-on bot runtime.** Reason: it is the only always-on, free, zero-ops compute in the allowed stack. Kaggle cannot be always-on.
- **Telegram webhook, not long polling.** Reason: Workers are request-driven. Webhook requests are verified with Telegram's secret-token header.
- **One Durable Object per learner runs the question pipeline and owns the 24 h session timer (alarm).** Reason: the pipeline takes up to ~60 s, longer than a webhook should block. A Durable Object serialises one learner's messages, survives the webhook returning, and its alarm gives the TTL for free.
- **LLM router with one OpenAI-compatible interface and two backends:**
  - *Primary*: **vLLM on a Kaggle notebook (free T4 GPU)** serving **Qwen3-VL-8B-Instruct** (quantized), with tool calling enabled, exposed through a **Cloudflare Tunnel** behind a shared-secret header. Reason: free GPU, open Qwen model, reads images.
  - *Fallback*: **Cloudflare Workers AI `@cf/qwen/qwen3-30b-a3b-fp8`**. Reason: free daily allowance, open Qwen, always on.
  - Kaggle health is a heartbeat row the notebook writes every 30 s. The router treats a heartbeat older than 90 s as offline.
- **Audio → text with Whisper (`whisper-large-v3-turbo`) on Workers AI.** Reason: free, always on, good Indonesian accuracy. Qwen still produces every answer.
- **Embeddings with `bge-m3` on Workers AI (1024-dim).** Reason: multilingual and strong on Indonesian. Always available, so query and document vectors always come from the same model regardless of Kaggle state.
- **Supabase Postgres + pgvector** for knowledge chunks, sessions, feedback, follow-ups, the memory graph and metrics, accessed from the Worker over HTTPS (PostgREST + SQL functions for vector search). Reason: free tier, pgvector built in, and HTTP access keeps Worker CPU low.
- **Long-term graph memory as plain Postgres tables (nodes, edges, with embeddings on nodes)**, not a separate graph database. Reason: no extra free service to run. Graph queries here are one or two hops.
- **Cloudflare R2** stores original uploaded files. Reason: 10 GB free. Postgres keeps only text and vectors.
- **Ingestion**: plain text and `.md`/`.txt` are chunked in the Worker. `.pdf` and `.html` are parsed by an ingest loop in the Kaggle notebook that pulls pending jobs from Postgres. Reason: PDF parsing would exceed the Worker free-plan CPU budget. When Kaggle is offline the job waits, and the mentor is told so.
- **Background long-term-memory job**: a Worker cron trigger (every 5 min) picks ended sessions and asks the LLM router to extract entities/relations. Reason: free cron, off the answer's critical path.
- **Grounding and "not found" rule**: retrieve the top-k chunks. If the best cosine similarity is below a tuned threshold (starting value set during the plan's evaluation step), it is *not found*. Otherwise the model answers **only** from the retrieved chunks and must return a `NOT_FOUND` marker if they don't contain the answer, which also triggers the fallback.
- **1000-character policy**: the system prompt sets the budget. If the output is still over 1000 characters, one "compress to ≤ 900 chars" pass runs, then a hard cut at the last sentence boundary as a final guarantee.
- **Streaming to Telegram**: `sendMessageDraft` in private chats where supported, otherwise `editMessageText` throttled to ~1 update/s to stay under Telegram rate limits.
- **Initial corpus**: a one-off seed script ingests the existing `lesson-docs/` folder (the two `.md` files, three PDFs and the glossary HTML; the stray `.jpg` is skipped unless it carries text).

## Data
- **Knowledge sources**: one record per document (title, type, origin = seed or add_knowledge, added by, added at, R2 key). Kept indefinitely. Course material, not personal data.
- **Knowledge chunks**: text chunk, source reference, position, 1024-dim embedding. Kept indefinitely.
- **Learners**: Telegram user ID, display name/handle, has-started-bot flag, privacy-notice-shown flag. Personal data.
- **Sessions and turns**: learner, topic, question (text; transcript for audio; model's image description for photos), answer, answer source (lesson-docs or fallback), timings per stage, backend used (Kaggle/Workers AI), status (open/closed-feedback/expired), last activity. Personal data. Raw images and audio are **not stored**: discarded after transcription/description.
- **Feedback**: session, kind (button/reaction/text), value, text.
- **Mentor follow-ups**: session, question, mentors notified, status.
- **Memory graph**: per-learner nodes (concept/preference/difficulty, embedding) and edges (relation, weight, source session). Personal data. Retained for the cohort's duration plus 90 days, then deleted. Deleted immediately on `/hapusdata`.
- **Ingest jobs** and **inference heartbeat**: operational, short-lived.
- **Config (not in DB)**: group ID, mentor IDs, add-knowledge whitelist, thresholds. Held as Worker environment variables. Secrets as Worker secrets only.

## Acceptance criteria
1. A message in a group topic **without** `#askAI` produces no bot action (no DM, no topic reply, no DB session).
2. A text `#askAI` post from a learner who has started the bot produces a DM to that learner and **no** message in the topic when lesson-docs has an answer.
3. In the DM, the progress message passes through at least the stages "Pertanyaan diterima", "Sedang mencari dokumen terkait" and "Menyusun jawaban" before the final answer.
4. For a question answerable from lesson-docs, the time from the webhook arriving to the final answer being sent is under 60 s at the 90th percentile, over an evaluation set of at least 30 questions, with the Kaggle backend online.
5. Every final answer is ≤ 1000 characters, including for prompts crafted to elicit long output. Verified by an automated test across the evaluation set and by a unit test of the length-enforcement function.
6. Every final answer is in Bahasa Indonesia, including for questions asked in English. Checked by language detection over the evaluation set.
7. Every answer from lesson-docs names at least one source document that exists in the knowledge base.
8. Over a labelled evaluation set of ≥ 30 in-scope and ≥ 10 out-of-scope questions, ≥ 70% of in-scope questions are answered from lesson-docs, and ≥ 90% of out-of-scope questions trigger the fallback rather than an answer.
9. On fallback, the topic receives exactly the text `Saya tidak punya data terkait pertanyaan tersebut, akan saya follow up ke mentor` as a reply to the learner's post, and every configured mentor receives a DM containing the question and a link to the post.
10. A voice-note `#askAI` question is transcribed and answered in text. The DM shows the transcription stage. No audio file is persisted after processing.
11. A photo `#askAI` question is answered in text using the image content when Kaggle is online. When Kaggle is offline, the learner is told the answer is delayed and receives it once Kaggle is back. No image file is persisted after processing.
12. A learner who never started the bot receives a topic notice with a deep link. After pressing Start, they receive the held answer within 10 s.
13. `/add_knowledge` with text from a whitelisted mentor adds chunks, and a subsequent question about that text is answered from it. The same command from a non-whitelisted user changes nothing and gets a refusal.
14. `/add_knowledge` with a `.pdf`, `.md`, `.txt` and `.html` file each results in new searchable chunks and an R2 original. Existing chunks are unchanged (row count only increases).
15. A follow-up DM within an open session is answered with awareness of the previous turn (e.g. "jelaskan lebih sederhana" refers to the prior answer).
16. A session with no activity for 24 h is marked expired. A session with feedback (button, reaction ✅/👍/👎, or text reply) is marked closed. Both are picked up by the background job and produce memory-graph nodes/edges within 10 minutes.
17. `/hapusdata` removes all that learner's sessions, turns, feedback and graph nodes/edges.
18. When the Kaggle heartbeat is older than 90 s, text questions are answered via Workers AI with no learner-visible error.
19. Requests to the webhook without the correct Telegram secret-token header are rejected with 401. Requests to the Kaggle tunnel without the shared secret are rejected. MCP requests without a valid mentor token are rejected.
20. The MCP server lists exactly the tools `search_lesson_docs`, `recall_memory`, `escalate_to_mentor`, and `search_lesson_docs` returns chunks for a known query.
21. Answers to the evaluation set are in the Kak Skilly persona: no "Anda"/"lu", and they identify as Kak Skilly when asked "kamu siapa?".
22. The seed script ingests every `.md`, `.pdf` and `.html` in `lesson-docs/` and is idempotent: running it twice doesn't duplicate chunks.

## Flagged concerns
- **Privacy / compliance (Indonesia UU PDP, Law 27/2022)**: learners' questions, names and a memory profile are stored by third-party processors (Supabase, Cloudflare; Kaggle sees prompts). The notice + `/hapusdata` + retention rule is a baseline, not legal sign-off. **Decides: program owner / organiser.**
- **Course-material licensing**: IBM SkillBuild lesson content (transcripts, glossary) is copied into Supabase and R2 and quoted in answers. **Decides: program owner, against the SkillBuild content terms.**
- **Kaggle terms of use**: using a Kaggle notebook as a tunnelled, user-facing inference server may conflict with Kaggle's acceptable-use terms, and Kaggle may end sessions without notice. The Workers AI fallback limits the impact but doesn't remove the policy question. **Decides: project owner (Kharisma).**
- **Free-tier ceilings** that could break the "< 1 minute" or "70%" goals: Worker 10 ms CPU per request on the free plan; Workers AI ~10k neurons/day; Supabase free project pauses after a week of inactivity and has a 500 MB DB limit; Kaggle ~30 GPU-h/week. The plan's first step is a spike that measures these. **Decides: project owner, on whether degraded behaviour is acceptable.**
- **Security, prompt injection**: learner questions and `add-knowledge` content are untrusted input to a model that can call tools (including messaging mentors). Mitigations: tool allow-list, escalation rate-limited per learner, retrieved text wrapped as data in the prompt, add-knowledge limited to whitelisted mentors. **Decides: engineering (in REVIEW.md).**
- **Security, secrets**: Telegram token, Supabase service key, tunnel secret and MCP tokens live only in Worker / Kaggle secrets. Never in the repo or logs. **Decides: engineering.**
- **Brand**: the persona name "Kak Skilly" and any mention of "IBM SkillBuild" in bot messages use a third-party brand. **Decides: program owner.**
- **UX**: the public fallback notice reveals in the group that a question went unanswered. That is the requested behaviour, but it's noted for the mentor team. A 1000-char cap may cut complex answers. The bot offers "tanya lanjut" (ask a follow-up) in the session instead. **Decides: mentor team.**
- **Accessibility**: answers are text only. Voice input helps learners who prefer speaking. No voice output is planned. None further found: checked text formatting (plain text with minimal Markdown so screen readers on Telegram read cleanly).

## Out of scope
- Voice or image **answers**. Output is text only.
- Editing or deleting existing lesson-docs. `add-knowledge` only appends.
- A web admin dashboard. Metrics are SQL views only.
- Supporting more than one Telegram group.
- Consuming external MCP servers.
- Any paid tier, paid API or paid hosting.
- Answering from general model knowledge when lesson-docs has no answer.
- Production deployment itself, which is the owner's action after this chain.

## Resolved questions
1. *Kaggle can't serve 24/7. What serves inference when it's down?* → Router: Kaggle vLLM primary, Cloudflare Workers AI Qwen (`qwen3-30b-a3b-fp8`) fallback, chosen by heartbeat freshness. Image questions are queued during downtime.
2. *Which Qwen models and sizes, and what transcribes audio?* → Qwen3-VL-8B-Instruct (quantized) on Kaggle; Qwen3-30B-A3B on Workers AI as fallback; Whisper large-v3-turbo for audio; bge-m3 for embeddings.
3. *What happens when the learner never started the bot?* → Topic notice with a deep link. The answer is held and delivered on Start.
4. *Who may run add-knowledge, and which file types?* → Whitelisted mentor Telegram IDs; text, `.md`, `.txt`, `.pdf`, `.html`.
5. *Who receives follow-up DMs?* → A configured list of mentor IDs, starting with one owner.
6. *How is "not found" decided, and how is 70% measured?* → Similarity threshold **or** model `NOT_FOUND` marker. 70% = answered ÷ (answered + fallback), from session records, plus a labelled evaluation set (AC 8).
7. *What happens to sessions without feedback?* → Expire at 24 h and are still saved to long-term memory at lower weight.
8. *What do skills, tool calling and MCP do in v1?* → Four prompt-pack skills; three tools; the same tools exposed as an authenticated MCP server for mentors; no external MCP servers.
9. *What is the persona?* → "Kak Skilly", casual-polite Indonesian ("kamu"), friendly teaching assistant.
10. *What consent and retention for personal data?* → One-time notice, `/hapusdata`, raw media never stored, memory kept for the cohort + 90 days. Flagged for program-owner sign-off.
