-- 0004_mentor_dashboard: mentor follow-up dashboard (docs/mentor-followup-dashboard/spec.md).
-- Additive only: new tables, new columns, a widened status check, new functions.
-- add_followup (0003) is kept unchanged so the previous Worker still runs against this schema.

-- ---------- Dashboard users added at runtime (bootstrap users live in Worker config) ----------
create table dashboard_users (
  id              bigint generated always as identity primary key,
  email           text not null check (email = lower(email)),
  display_name    text not null,
  telegram_id     bigint not null,
  added_by_email  text not null,
  created_at      timestamptz not null default now(),
  removed_at      timestamptz
);
create unique index dashboard_users_active_email_idx on dashboard_users (email) where removed_at is null;

-- One-time login links. Only the SHA-256 of the token is stored.
create table dashboard_login_tokens (
  token_hash  text primary key,
  email       text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index dashboard_login_tokens_email_idx on dashboard_login_tokens (email, created_at);

-- Dashboard sessions. Only hashes of the session ID and the CSRF token are stored.
create table dashboard_sessions (
  session_hash  text primary key,
  csrf_hash     text not null,
  email         text not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz
);
create index dashboard_sessions_email_idx on dashboard_sessions (email);

-- ---------- Follow-up lifecycle ----------
-- Rows that exist before this migration get false (not shown); rows inserted afterwards get true.
alter table mentor_followups add column dashboard_visible boolean not null default false;
alter table mentor_followups alter column dashboard_visible set default true;

alter table mentor_followups add column photo_file_id       text;
alter table mentor_followups add column claimed_by_email    text;
alter table mentor_followups add column claimed_by_name     text;
alter table mentor_followups add column claimed_at          timestamptz;
alter table mentor_followups add column reply_text          text;
alter table mentor_followups add column replied_by_name     text;
alter table mentor_followups add column replied_at          timestamptz;
alter table mentor_followups add column dm_status           text check (dm_status in ('sent', 'held', 'failed'));
alter table mentor_followups add column topic_status        text check (topic_status in ('sent', 'failed', 'skipped'));
alter table mentor_followups add column knowledge_source_id uuid references knowledge_sources(id) on delete set null;

alter table mentor_followups drop constraint mentor_followups_status_check;
alter table mentor_followups add constraint mentor_followups_status_check
  check (status in ('open', 'claimed', 'closed', 'resolved'));

create index mentor_followups_dashboard_idx on mentor_followups (dashboard_visible, status, created_at desc);

-- ---------- Functions: follow-ups from the fallback ----------
create or replace function add_followup_v2(p_session uuid, p_question text, p_mentors jsonb, p_photo_file_id text)
returns table (id bigint)
language sql as $$
  insert into mentor_followups (session_id, question, mentors_notified, photo_file_id, dashboard_visible)
  values (p_session, p_question,
          coalesce(array(select (jsonb_array_elements_text(coalesce(p_mentors, '[]'::jsonb)))::bigint), '{}'),
          p_photo_file_id, true)
  returning mentor_followups.id;
$$;

create or replace function set_followup_notified(p_id bigint, p_mentors jsonb)
returns table (ok boolean)
language sql as $$
  update mentor_followups
     set mentors_notified = coalesce(array(select (jsonb_array_elements_text(coalesce(p_mentors, '[]'::jsonb)))::bigint), '{}')
   where id = p_id
  returning true;
$$;

-- ---------- Functions: dashboard users ----------
create or replace function dashboard_list_users()
returns table (id bigint, email text, display_name text, telegram_id bigint, added_by_email text, created_at timestamptz)
language sql stable as $$
  select u.id, u.email, u.display_name, u.telegram_id, u.added_by_email, u.created_at
  from dashboard_users u where u.removed_at is null order by u.created_at;
$$;

-- Returns the new id, or no row when the email is already an active user.
create or replace function dashboard_add_user(p_email text, p_name text, p_telegram_id bigint, p_added_by text)
returns table (id bigint)
language sql as $$
  insert into dashboard_users (email, display_name, telegram_id, added_by_email)
  values (lower(trim(p_email)), p_name, p_telegram_id, p_added_by)
  on conflict (email) where removed_at is null do nothing
  returning dashboard_users.id;
$$;

-- Soft-removes the user and revokes every session they hold. Returns the email, or no row.
create or replace function dashboard_remove_user(p_id bigint)
returns table (email text)
language plpgsql as $$
declare e text;
begin
  update dashboard_users set removed_at = now() where id = p_id and removed_at is null returning dashboard_users.email into e;
  if e is null then return; end if;
  update dashboard_sessions set revoked_at = now() where dashboard_sessions.email = e and revoked_at is null;
  update dashboard_login_tokens set used_at = now() where dashboard_login_tokens.email = e and used_at is null;
  return query select e;
end;
$$;

-- ---------- Functions: login links ----------
-- Issues a link unless p_max links were already issued for this email in the last p_window_s seconds.
-- Purges links older than 24 h on the way.
create or replace function dashboard_issue_login_token(p_email text, p_token_hash text, p_ttl_s int, p_max int, p_window_s int)
returns table (issued boolean)
language plpgsql as $$
declare n int;
begin
  delete from dashboard_login_tokens where created_at < now() - interval '24 hours';
  select count(*) into n from dashboard_login_tokens
   where email = p_email and created_at > now() - make_interval(secs => p_window_s);
  if n >= p_max then return query select false; return; end if;
  insert into dashboard_login_tokens (token_hash, email, expires_at)
  values (p_token_hash, p_email, now() + make_interval(secs => p_ttl_s));
  return query select true;
end;
$$;

-- Single use: returns the email once, for an unused, unexpired link. No row otherwise.
create or replace function dashboard_consume_login_token(p_token_hash text)
returns table (email text)
language sql as $$
  update dashboard_login_tokens set used_at = now()
   where token_hash = p_token_hash and used_at is null and expires_at > now()
  returning dashboard_login_tokens.email;
$$;

-- ---------- Functions: sessions ----------
create or replace function dashboard_create_session(p_session_hash text, p_csrf_hash text, p_email text, p_ttl_s int)
returns table (ok boolean)
language plpgsql as $$
begin
  delete from dashboard_sessions where expires_at < now() - interval '1 day';
  insert into dashboard_sessions (session_hash, csrf_hash, email, expires_at)
  values (p_session_hash, p_csrf_hash, p_email, now() + make_interval(secs => p_ttl_s));
  return query select true;
end;
$$;

create or replace function dashboard_get_session(p_session_hash text)
returns table (email text, csrf_hash text)
language sql stable as $$
  select s.email, s.csrf_hash from dashboard_sessions s
  where s.session_hash = p_session_hash and s.revoked_at is null and s.expires_at > now();
$$;

create or replace function dashboard_revoke_session(p_session_hash text)
returns table (ok boolean)
language sql as $$
  update dashboard_sessions set revoked_at = now() where session_hash = p_session_hash and revoked_at is null returning true;
$$;

-- ---------- Functions: the follow-up list ----------
-- Effective status: a claim older than p_claim_ttl_s seconds with no reply reads as 'open'.
-- Never returns learner identity (spec AC 9).
create or replace function dashboard_list_followups(p_tab text, p_claim_ttl_s int)
returns table (id bigint, question text, has_photo boolean, thread_id bigint, via_dm boolean, created_at timestamptz,
               status text, claimed_by_email text, claimed_by_name text, reply_text text, replied_by_name text,
               replied_at timestamptz, dm_status text, topic_status text, knowledge_source_id uuid)
language sql stable as $$
  select * from (
    select f.id, f.question, f.photo_file_id is not null, s.origin_thread_id, s.origin_chat_id is null, f.created_at,
           case when f.status = 'claimed' and f.claimed_at < now() - make_interval(secs => p_claim_ttl_s) then 'open'
                when f.status = 'resolved' then 'closed'
                else f.status end as eff_status,
           case when f.status = 'claimed' and f.claimed_at >= now() - make_interval(secs => p_claim_ttl_s) then f.claimed_by_email end,
           case when f.status = 'claimed' and f.claimed_at >= now() - make_interval(secs => p_claim_ttl_s) then f.claimed_by_name end,
           f.reply_text, f.replied_by_name, f.replied_at, f.dm_status, f.topic_status, f.knowledge_source_id
    from mentor_followups f join sessions s on s.id = f.session_id
    where f.dashboard_visible
  ) x
  where (p_tab = 'closed' and x.eff_status = 'closed') or (p_tab <> 'closed' and x.eff_status in ('open', 'claimed'))
  order by x.created_at desc;
$$;

-- The stored photo reference, for the authenticated image proxy only.
create or replace function dashboard_followup_photo(p_id bigint)
returns table (photo_file_id text)
language sql stable as $$
  select f.photo_file_id from mentor_followups f where f.id = p_id and f.dashboard_visible and f.photo_file_id is not null;
$$;

-- ---------- Functions: claim, release, close ----------
-- Exactly one concurrent caller wins: the update re-checks the predicate under the row lock.
create or replace function dashboard_claim_followup(p_id bigint, p_email text, p_name text, p_claim_ttl_s int)
returns table (claimed boolean, claimed_by_name text)
language plpgsql as $$
declare n int;
begin
  update mentor_followups
     set status = 'claimed', claimed_by_email = p_email, claimed_by_name = p_name, claimed_at = now()
   where id = p_id and dashboard_visible
     and (status = 'open' or (status = 'claimed' and claimed_at < now() - make_interval(secs => p_claim_ttl_s)));
  get diagnostics n = row_count;
  if n > 0 then return query select true, p_name; return; end if;
  return query select false, f.claimed_by_name from mentor_followups f where f.id = p_id;
end;
$$;

create or replace function dashboard_release_followup(p_id bigint, p_email text)
returns table (released boolean)
language plpgsql as $$
declare n int;
begin
  update mentor_followups
     set status = 'open', claimed_by_email = null, claimed_by_name = null, claimed_at = null
   where id = p_id and status = 'claimed' and claimed_by_email = p_email;
  get diagnostics n = row_count;
  return query select n > 0;
end;
$$;

-- Closes a question the caller holds a live claim on, and returns what delivery needs.
-- No row when the caller isn't the live claimer (or it's already closed): nothing gets sent twice.
create or replace function dashboard_close_followup(p_id bigint, p_email text, p_name text, p_reply text, p_claim_ttl_s int)
returns table (session_id uuid, question text, learner_id bigint, learner_name text, learner_started boolean,
               origin_chat_id bigint, origin_thread_id bigint, origin_message_id bigint)
language sql as $$
  with closed as (
    update mentor_followups
       set status = 'closed', reply_text = p_reply, replied_by_name = p_name, replied_at = now()
     where id = p_id and status = 'claimed' and claimed_by_email = p_email
       and claimed_at >= now() - make_interval(secs => p_claim_ttl_s)
    returning mentor_followups.session_id, mentor_followups.question
  )
  select c.session_id, c.question, l.telegram_id, l.display_name, l.has_started,
         s.origin_chat_id, s.origin_thread_id, s.origin_message_id
  from closed c join sessions s on s.id = c.session_id join learners l on l.telegram_id = s.learner_id;
$$;

create or replace function dashboard_set_delivery(p_id bigint, p_dm text, p_topic text)
returns table (ok boolean)
language sql as $$
  update mentor_followups set dm_status = p_dm, topic_status = p_topic where id = p_id returning true;
$$;

-- ---------- Functions: add to knowledge ----------
create or replace function dashboard_followup_for_knowledge(p_id bigint)
returns table (status text, question text, reply_text text, knowledge_source_id uuid)
language sql stable as $$
  select f.status, f.question, f.reply_text, f.knowledge_source_id
  from mentor_followups f where f.id = p_id and f.dashboard_visible;
$$;

-- Links once: a second call leaves the first link in place and returns false.
create or replace function dashboard_set_knowledge(p_id bigint, p_source uuid)
returns table (linked boolean)
language plpgsql as $$
declare n int;
begin
  update mentor_followups set knowledge_source_id = p_source
   where id = p_id and status = 'closed' and knowledge_source_id is null;
  get diagnostics n = row_count;
  return query select n > 0;
end;
$$;
