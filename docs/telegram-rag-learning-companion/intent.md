# Intent: Learners get fast, grounded answers to #askAI questions in Telegram, and unanswerable ones reach a mentor
*Author: Kharisma Wardhana. Stage: Plan. Written: 2026-11-02. Via /aspec:make-it-simple-v2.*

## Problem statement
A learner cohort of 50–100 people, aged 18–34, from both IT and non-IT backgrounds, shares one Telegram group organised into forum topics. When a learner asks a question there, mentors miss it or answer too slowly. Questions go unanswered or get answered long after the learner needed it. The course material that could answer most of them already exists in `lesson-docs/` (Markdown lessons, PDF video transcripts, an HTML glossary, images). Learners can't query it conversationally, and it can't be extended with new material without a developer.

## Proposed outcome
- A learner posts a question in any forum topic with the hashtag `#askAI`. The question may be text, an image, or audio.
- The bot replies to that learner by DM, in Bahasa Indonesia, in under 1 minute.
- The bot shows live progress stages while it works (e.g. "Pertanyaan diterima", "Sedang mencari dokumen terkait", "Menyusun jawaban"), with the answer streamed.
- The answer is grounded in lesson-docs and fits within Telegram's limit: a final answer of at most 1000 characters, text only.
- About 70% of #askAI questions are answered from lesson-docs.
- When lesson-docs has no relevant data, the bot posts in the same topic: "Saya tidak punya data terkait pertanyaan tersebut, akan saya follow up ke mentor". It then DMs a designated mentor/owner with the question so they can follow up.
- An authorised user can grow the knowledge base with an `add-knowledge` command (text or file). The new content is appended to lesson-docs and becomes searchable.
- Each conversation has session memory with a 24-hour TTL. A session closes when the learner gives feedback on the final answer (a text reply or a checkmark-style emoji). On close, the session is distilled into long-term graph memory by a background process.
- The bot has a consistent persona, can use skills and call tools, including tools exposed over MCP.

## Affected users and systems
- Learners (50–100, mixed IT/non-IT backgrounds): ask questions, receive DMs, give feedback.
- Mentors / the designated owner: receive follow-up DMs for unanswered questions, add knowledge.
- The cohort's Telegram group (forum topics): the bot reads #askAI posts and posts fallback notices there.
- `lesson-docs/` corpus: the source of truth for answers; grows via `add-knowledge`.
- Kaggle (free GPU): runs the open Qwen model inference.
- Cloudflare (free plan): edge/webhook/hosting layer.
- Supabase Postgres (free) with pgvector: embeddings, session memory, long-term graph memory, feedback.

## Constraints
- Free tier only: Kaggle free GPU, Cloudflare free plan, Supabase free Postgres. No paid APIs of any kind.
- The LLM must be an open Qwen-family model, not a hosted proprietary model.
- All user-facing answers are in Bahasa Indonesia.
- Answers are text only (multimodal input, text output). The final answer is at most 1000 characters.
- Response time is under 1 minute from the #askAI post to the DM answer.
- Answers must come from lesson-docs. If lesson-docs has nothing relevant, the bot must not invent an answer and must use the mentor fallback instead.
- Session memory expires after 24 hours.
- Deadline: 1 month from 2026-11-02, so by 2026-12-02.

## Open questions
1. Kaggle's free GPU has a weekly quota (~30 h) and a 12-hour session cap, so it can't serve 24/7 alone. What serves inference when the Kaggle session is down: a queue, a smaller fallback model, or a free hosted open-model tier (e.g. Cloudflare Workers AI's free allowance of Qwen models)?
2. Which Qwen model(s) and sizes, given the free GPU (e.g. a Qwen VL model for images, and what transcribes audio)?
3. Telegram bots can't DM a user who has never started the bot. What happens when a learner who hasn't started it posts #askAI?
4. Who is allowed to run `add-knowledge`, and which file types must it accept?
5. Who is the mentor/owner that receives follow-up DMs: one fixed person, or several?
6. How is "not found in lesson-docs" decided (retrieval relevance threshold), and how is the 70% figure measured?
7. What happens to a session the learner never gives feedback on: is it saved to long-term memory at the 24 h TTL, or discarded?
8. What should "skills", "tool calling" and "MCP" concretely do for a learner in v1? Which tools and which MCP servers?
9. What is the persona: name, tone, how formal the Bahasa Indonesia is?
10. Learner messages, images and voice notes stored in long-term memory are personal data. What consent or notice is needed, and how long is it kept?
