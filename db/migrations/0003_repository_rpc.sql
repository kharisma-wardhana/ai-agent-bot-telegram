-- 0003_repository_rpc: every Worker/Kaggle data operation as a SQL function, so the same SQL
-- runs behind PostgREST in production and on PGlite in tests. Complex inputs are jsonb.

-- ---------- Learners ----------
create or replace function upsert_learner(p_telegram_id bigint, p_display_name text, p_username text, p_started boolean)
returns table (telegram_id bigint, has_started boolean, privacy_notice_shown boolean, is_new boolean)
language sql as $$
  insert into learners as l (telegram_id, display_name, username, has_started)
  values (p_telegram_id, p_display_name, p_username, coalesce(p_started, false))
  on conflict (telegram_id) do update
     set display_name = coalesce(excluded.display_name, l.display_name),
         username     = coalesce(excluded.username, l.username),
         has_started  = l.has_started or coalesce(p_started, false),
         last_seen_at = now()
  returning l.telegram_id, l.has_started, l.privacy_notice_shown, (xmax = 0) as is_new;
$$;

create or replace function mark_privacy_notice_shown(p_learner bigint)
returns table (ok boolean)
language sql as $$
  update learners set privacy_notice_shown = true where telegram_id = p_learner returning true;
$$;

-- ---------- Sessions ----------
create or replace function open_session(p_learner bigint, p_chat bigint, p_thread bigint, p_message bigint)
returns table (id uuid)
language sql as $$
  insert into sessions (learner_id, origin_chat_id, origin_thread_id, origin_message_id)
  values (p_learner, p_chat, p_thread, p_message)
  returning id;
$$;

create or replace function get_open_session(p_learner bigint)
returns table (id uuid, origin_chat_id bigint, origin_thread_id bigint, origin_message_id bigint, last_activity_at timestamptz)
language sql stable as $$
  select s.id, s.origin_chat_id, s.origin_thread_id, s.origin_message_id, s.last_activity_at
  from sessions s
  where s.learner_id = p_learner and s.status = 'open'
  order by s.last_activity_at desc
  limit 1;
$$;

create or replace function add_turn(p_session uuid, p_role text, p_content text, p_question_kind text,
                                    p_answer_source text, p_sources jsonb, p_backend text, p_stage_timings jsonb)
returns table (id bigint)
language sql as $$
  update sessions set last_activity_at = now() where sessions.id = p_session;
  insert into session_turns (session_id, role, content, question_kind, answer_source, sources, backend, stage_timings)
  values (p_session, p_role, p_content, p_question_kind, p_answer_source,
          coalesce(array(select jsonb_array_elements_text(coalesce(p_sources, '[]'::jsonb))), '{}'),
          p_backend, coalesce(p_stage_timings, '{}'::jsonb))
  returning session_turns.id;
$$;

-- Last p_limit turns, oldest first.
create or replace function get_turns(p_session uuid, p_limit int)
returns table (role text, content text, created_at timestamptz)
language sql stable as $$
  select t.role, t.content, t.created_at from (
    select role, content, created_at, id from session_turns
    where session_id = p_session order by id desc limit p_limit
  ) t order by t.id asc;
$$;

-- Records feedback; closes the session if it was open. closed = whether this call closed it.
create or replace function close_session_feedback(p_session uuid, p_kind text, p_value text)
returns table (closed boolean)
language plpgsql as $$
declare n int;
begin
  insert into feedback (session_id, kind, value) values (p_session, p_kind, p_value);
  update sessions set status = 'closed_feedback', closed_at = now()
   where id = p_session and status = 'open';
  get diagnostics n = row_count;
  return query select n > 0;
end;
$$;

-- ---------- Mentor follow-ups ----------
create or replace function add_followup(p_session uuid, p_question text, p_mentors jsonb)
returns table (id bigint)
language sql as $$
  insert into mentor_followups (session_id, question, mentors_notified)
  values (p_session, p_question,
          coalesce(array(select (jsonb_array_elements_text(coalesce(p_mentors, '[]'::jsonb)))::bigint), '{}'))
  returning id;
$$;

create or replace function count_recent_escalations(p_learner bigint, p_minutes int)
returns table (n bigint)
language sql stable as $$
  select count(*) from mentor_followups f join sessions s on s.id = f.session_id
  where s.learner_id = p_learner and f.created_at > now() - make_interval(mins => p_minutes);
$$;

-- ---------- Held / deferred answers ----------
create or replace function hold_answer(p_learner bigint, p_session uuid, p_reason text, p_payload jsonb)
returns table (id uuid)
language sql as $$
  insert into pending_answers (learner_id, session_id, reason, payload)
  values (p_learner, p_session, p_reason, p_payload)
  returning id;
$$;

-- Claims undelivered items (marks them delivered). p_learner null = any learner.
create or replace function take_pending_answers(p_learner bigint, p_reason text, p_limit int)
returns table (id uuid, learner_id bigint, session_id uuid, reason text, payload jsonb, created_at timestamptz)
language sql as $$
  update pending_answers p set delivered_at = now()
   where p.id in (
     select q.id from pending_answers q
      where q.reason = p_reason and q.delivered_at is null
        and (p_learner is null or q.learner_id = p_learner)
      order by q.created_at
      limit p_limit
      for update skip locked)
  returning p.id, p.learner_id, p.session_id, p.reason, p.payload, p.created_at;
$$;

-- ---------- Knowledge ----------
-- Appends a source and its chunks. Duplicate content_hash → nothing inserted (source_id null, 0).
-- p_chunks: [{ "position": int, "content": text, "embedding": [1024 floats] }]
create or replace function insert_knowledge(p_title text, p_source_type text, p_origin text, p_added_by bigint,
                                            p_r2_key text, p_content_hash text, p_chunks jsonb)
returns table (source_id uuid, chunks_added int)
language plpgsql as $$
declare sid uuid; n int;
begin
  insert into knowledge_sources (title, source_type, origin, added_by, r2_key, content_hash)
  values (p_title, p_source_type, p_origin, p_added_by, p_r2_key, p_content_hash)
  on conflict (content_hash) do nothing
  returning id into sid;
  if sid is null then
    return query select null::uuid, 0;
    return;
  end if;
  insert into knowledge_chunks (source_id, position, content, embedding)
  select sid, (c->>'position')::int, c->>'content', ((c->'embedding')::text)::vector
  from jsonb_array_elements(p_chunks) c;
  get diagnostics n = row_count;
  return query select sid, n;
end;
$$;

create or replace function create_ingest_job(p_r2_key text, p_file_name text, p_source_type text, p_requested_by bigint)
returns table (id uuid)
language sql as $$
  insert into ingest_jobs (r2_key, file_name, source_type, requested_by)
  values (p_r2_key, p_file_name, p_source_type, p_requested_by)
  returning id;
$$;

create or replace function finish_ingest_job(p_id uuid, p_status text, p_error text, p_chunks int)
returns table (ok boolean)
language sql as $$
  update ingest_jobs set status = p_status, error = p_error, chunks_added = p_chunks, finished_at = now()
   where id = p_id returning true;
$$;

-- ---------- Inference heartbeat ----------
create or replace function record_heartbeat(p_backend text, p_model text)
returns table (ok boolean)
language sql as $$
  insert into inference_heartbeat (backend, model, last_seen_at) values (p_backend, p_model, now())
  on conflict (backend) do update set model = excluded.model, last_seen_at = now()
  returning true;
$$;

-- Age computed in the database so Worker/Kaggle clock skew doesn't matter.
create or replace function latest_heartbeat(p_backend text)
returns table (last_seen_at timestamptz, age_seconds float)
language sql stable as $$
  select h.last_seen_at, extract(epoch from now() - h.last_seen_at)::float
  from inference_heartbeat h where h.backend = p_backend;
$$;

-- ---------- Long-term graph memory ----------
create or replace function sessions_pending_memory(p_limit int)
returns table (id uuid, learner_id bigint, status text, turns jsonb)
language sql stable as $$
  select s.id, s.learner_id, s.status,
         coalesce((select jsonb_agg(jsonb_build_object('role', t.role, 'content', t.content) order by t.id)
                   from session_turns t where t.session_id = s.id), '[]'::jsonb)
  from sessions s
  where s.status in ('closed_feedback', 'expired') and s.memory_status = 'pending'
  order by s.closed_at nulls last
  limit p_limit;
$$;

-- p_nodes: [{ "kind", "label", "embedding": [..] | null }]
-- p_edges: [{ "from": {"kind","label"}, "relation", "to": {"kind","label"} }]
create or replace function save_memory(p_learner bigint, p_session uuid, p_weight real, p_nodes jsonb, p_edges jsonb)
returns table (nodes int, edges int)
language plpgsql as $$
declare nn int; ne int;
begin
  insert into memory_nodes as m (learner_id, kind, label, embedding, weight)
  select p_learner, n->>'kind', n->>'label',
         case when n->'embedding' is null or jsonb_typeof(n->'embedding') = 'null' then null
              else ((n->'embedding')::text)::vector end,
         p_weight
  from jsonb_array_elements(coalesce(p_nodes, '[]'::jsonb)) n
  on conflict (learner_id, kind, label) do update
     set weight = m.weight + excluded.weight,
         embedding = coalesce(excluded.embedding, m.embedding),
         updated_at = now();
  get diagnostics nn = row_count;

  insert into memory_edges (learner_id, from_node, relation, to_node, weight, source_session)
  select p_learner, f.id, e->>'relation', t.id, p_weight, p_session
  from jsonb_array_elements(coalesce(p_edges, '[]'::jsonb)) e
  join memory_nodes f on f.learner_id = p_learner and f.kind = e->'from'->>'kind' and f.label = e->'from'->>'label'
  join memory_nodes t on t.learner_id = p_learner and t.kind = e->'to'->>'kind' and t.label = e->'to'->>'label';
  get diagnostics ne = row_count;

  update sessions set memory_status = 'done' where id = p_session;
  return query select nn, ne;
end;
$$;

-- Edges touching the given nodes, for one-hop recall.
create or replace function memory_edges_for(p_learner bigint, p_node_ids jsonb)
returns table (from_label text, relation text, to_label text, weight real)
language sql stable as $$
  select f.label, e.relation, t.label, e.weight
  from memory_edges e
  join memory_nodes f on f.id = e.from_node
  join memory_nodes t on t.id = e.to_node
  where e.learner_id = p_learner
    and (e.from_node in (select (jsonb_array_elements_text(p_node_ids))::bigint)
      or e.to_node in (select (jsonb_array_elements_text(p_node_ids))::bigint))
  order by e.weight desc
  limit 20;
$$;
