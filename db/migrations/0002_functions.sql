-- 0002_functions: SQL functions called by the Worker (via PostgREST RPC) and the Kaggle ingest loop.

-- Vector search over lesson-docs. similarity = cosine similarity (1 = identical).
create or replace function match_chunks(query_embedding vector(1024), match_count int, min_similarity float)
returns table (id bigint, source_id uuid, title text, content text, similarity float)
language sql stable as $$
  select c.id, c.source_id, s.title, c.content, 1 - (c.embedding <=> query_embedding) as similarity
  from knowledge_chunks c
  join knowledge_sources s on s.id = c.source_id
  where 1 - (c.embedding <=> query_embedding) >= min_similarity
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- Recall a learner's long-term memory nodes closest to the question.
create or replace function match_memory_nodes(p_learner bigint, query_embedding vector(1024), match_count int)
returns table (id bigint, kind text, label text, weight real, similarity float)
language sql stable as $$
  select n.id, n.kind, n.label, n.weight, 1 - (n.embedding <=> query_embedding) as similarity
  from memory_nodes n
  where n.learner_id = p_learner and n.embedding is not null
  order by n.embedding <=> query_embedding
  limit match_count;
$$;

-- /hapusdata: removes the learner and, by cascade, every session, turn, feedback,
-- follow-up, pending answer and memory node/edge. Returns sessions removed.
create or replace function delete_learner_data(p_learner bigint)
returns int
language plpgsql as $$
declare n int;
begin
  select count(*) into n from sessions where learner_id = p_learner;
  delete from learners where telegram_id = p_learner;
  return n;
end;
$$;

-- Marks open sessions idle longer than the TTL as expired. Returns their ids.
create or replace function expire_sessions(ttl_hours int)
returns setof uuid
language sql as $$
  update sessions
     set status = 'expired', closed_at = now()
   where status = 'open'
     and last_activity_at < now() - make_interval(hours => ttl_hours)
  returning id;
$$;

-- Ingest loop: atomically claims the oldest pending job (safe with concurrent workers).
create or replace function claim_ingest_job()
returns setof ingest_jobs
language sql as $$
  update ingest_jobs
     set status = 'processing', claimed_at = now()
   where id = (
     select id from ingest_jobs
      where status = 'pending'
      order by created_at
      for update skip locked
      limit 1)
  returning *;
$$;

-- Weekly share of #askAI questions answered from lesson-docs (the 70% goal).
create or replace view answer_source_ratio as
select date_trunc('week', created_at) as week,
       count(*) filter (where answer_source = 'lesson_docs') as answered,
       count(*) filter (where answer_source = 'fallback') as fallback,
       round(
         (count(*) filter (where answer_source = 'lesson_docs'))::numeric
         / nullif(count(*) filter (where answer_source is not null), 0), 3) as answered_ratio
from session_turns
where role = 'assistant'
group by 1
order by 1;
