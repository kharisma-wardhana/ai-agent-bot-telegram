-- 0001_init: tables for the Telegram RAG learning companion.
-- Additive only. Never edit after it has been applied; add a new migration instead.

create extension if not exists vector;

-- ---------- Knowledge base (course material, not personal data) ----------
create table knowledge_sources (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  source_type   text not null check (source_type in ('md', 'txt', 'pdf', 'html', 'text')),
  origin        text not null check (origin in ('seed', 'add_knowledge')),
  added_by      bigint,                       -- mentor Telegram ID for add_knowledge; null for seed
  r2_key        text,                         -- original file in R2, if any
  content_hash  text not null unique,         -- sha256 of normalised text: makes re-ingest a no-op
  created_at    timestamptz not null default now()
);

create table knowledge_chunks (
  id          bigint generated always as identity primary key,
  source_id   uuid not null references knowledge_sources(id) on delete cascade,
  position    int not null,
  content     text not null,
  embedding   vector(1024) not null,          -- bge-m3
  created_at  timestamptz not null default now(),
  unique (source_id, position)
);

-- ---------- Learners and sessions (personal data) ----------
create table learners (
  telegram_id           bigint primary key,
  display_name          text,
  username              text,
  has_started           boolean not null default false,
  privacy_notice_shown  boolean not null default false,
  created_at            timestamptz not null default now(),
  last_seen_at          timestamptz not null default now()
);

create table sessions (
  id                 uuid primary key default gen_random_uuid(),
  learner_id         bigint not null references learners(telegram_id) on delete cascade,
  origin_chat_id     bigint,
  origin_thread_id   bigint,                  -- forum topic
  origin_message_id  bigint,
  status             text not null default 'open' check (status in ('open', 'closed_feedback', 'expired')),
  memory_status      text not null default 'pending' check (memory_status in ('pending', 'done', 'skipped')),
  created_at         timestamptz not null default now(),
  last_activity_at   timestamptz not null default now(),
  closed_at          timestamptz
);
create index sessions_learner_idx on sessions (learner_id);
create index sessions_open_idx on sessions (status, last_activity_at);

create table session_turns (
  id              bigint generated always as identity primary key,
  session_id      uuid not null references sessions(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  question_kind   text check (question_kind in ('text', 'voice', 'photo')),
  answer_source   text check (answer_source in ('lesson_docs', 'fallback')),
  sources         text[] not null default '{}',
  backend         text check (backend in ('kaggle', 'workers_ai')),
  stage_timings   jsonb not null default '{}',
  created_at      timestamptz not null default now()
);
create index session_turns_session_idx on session_turns (session_id, id);

create table feedback (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references sessions(id) on delete cascade,
  kind        text not null check (kind in ('button', 'reaction', 'text')),
  value       text not null,
  created_at  timestamptz not null default now()
);

create table mentor_followups (
  id                bigint generated always as identity primary key,
  session_id        uuid not null references sessions(id) on delete cascade,
  question          text not null,
  mentors_notified  bigint[] not null default '{}',
  status            text not null default 'open' check (status in ('open', 'resolved')),
  created_at        timestamptz not null default now()
);

-- Answers held for learners who haven't started the bot, and image questions deferred while Kaggle is offline.
create table pending_answers (
  id            uuid primary key default gen_random_uuid(),
  learner_id    bigint not null references learners(telegram_id) on delete cascade,
  session_id    uuid references sessions(id) on delete cascade,
  reason        text not null check (reason in ('not_started', 'image_deferred')),
  payload       jsonb not null,
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz
);
create index pending_answers_open_idx on pending_answers (reason, delivered_at);

-- ---------- Long-term graph memory (personal data) ----------
create table memory_nodes (
  id          bigint generated always as identity primary key,
  learner_id  bigint not null references learners(telegram_id) on delete cascade,
  kind        text not null check (kind in ('concept', 'preference', 'difficulty')),
  label       text not null,
  embedding   vector(1024),
  weight      real not null default 1.0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (learner_id, kind, label)
);

create table memory_edges (
  id              bigint generated always as identity primary key,
  learner_id      bigint not null references learners(telegram_id) on delete cascade,
  from_node       bigint not null references memory_nodes(id) on delete cascade,
  relation        text not null,
  to_node         bigint not null references memory_nodes(id) on delete cascade,
  weight          real not null default 1.0,
  source_session  uuid,
  created_at      timestamptz not null default now()
);
create index memory_edges_learner_idx on memory_edges (learner_id);

-- ---------- Operational ----------
create table ingest_jobs (
  id            uuid primary key default gen_random_uuid(),
  r2_key        text not null,
  file_name     text not null,
  source_type   text not null check (source_type in ('pdf', 'html')),
  requested_by  bigint not null,
  status        text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed')),
  error         text,
  chunks_added  int,
  created_at    timestamptz not null default now(),
  claimed_at    timestamptz,
  finished_at   timestamptz
);

create table inference_heartbeat (
  backend       text primary key,             -- 'kaggle'
  model         text,
  last_seen_at  timestamptz not null default now()
);
