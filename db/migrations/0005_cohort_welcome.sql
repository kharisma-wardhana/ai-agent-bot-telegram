-- 0005_cohort_welcome: batched welcome for new cohort members + leave notices
-- (docs/cohort-welcome-message/spec.md). Additive only: two new tables and their functions.

-- Single row of dashboard-editable settings. No row yet = the Worker's built-in defaults.
create table welcome_settings (
  id               smallint primary key default 1 check (id = 1),
  template         text not null check (char_length(template) <= 1000 and position('{nama}' in template) > 0),
  topic_id         bigint check (topic_id is null or topic_id > 0),
  welcome_enabled  boolean not null default true,
  leave_enabled    boolean not null default true,
  updated_by       text not null,
  updated_at       timestamptz not null default now()
);

-- Newcomers waiting for the next cron welcome. Personal data held for minutes; purged after 24 h at the latest.
create table pending_welcomes (
  telegram_id   bigint primary key,
  display_name  text not null,
  joined_at     timestamptz not null default now()
);

create or replace function get_welcome_settings()
returns table (template text, topic_id bigint, welcome_enabled boolean, leave_enabled boolean, updated_by text, updated_at timestamptz)
language sql stable as $$
  select s.template, s.topic_id, s.welcome_enabled, s.leave_enabled, s.updated_by, s.updated_at from welcome_settings s where s.id = 1;
$$;

create or replace function save_welcome_settings(p_template text, p_topic_id bigint, p_welcome boolean, p_leave boolean, p_by text)
returns table (ok boolean)
language sql as $$
  insert into welcome_settings (id, template, topic_id, welcome_enabled, leave_enabled, updated_by, updated_at)
  values (1, p_template, p_topic_id, p_welcome, p_leave, p_by, now())
  on conflict (id) do update
     set template = excluded.template, topic_id = excluded.topic_id, welcome_enabled = excluded.welcome_enabled,
         leave_enabled = excluded.leave_enabled, updated_by = excluded.updated_by, updated_at = now()
  returning true;
$$;

-- Idempotent per user within a window (a duplicate join keeps the first joined_at). Purges stale rows.
create or replace function queue_welcome(p_user bigint, p_name text)
returns table (queued boolean)
language plpgsql as $$
begin
  delete from pending_welcomes where joined_at < now() - interval '24 hours';
  insert into pending_welcomes (telegram_id, display_name) values (p_user, p_name)
  on conflict (telegram_id) do update set display_name = excluded.display_name;
  return query select true;
end;
$$;

create or replace function unqueue_welcome(p_user bigint)
returns table (removed boolean)
language plpgsql as $$
declare n int;
begin
  delete from pending_welcomes where telegram_id = p_user;
  get diagnostics n = row_count;
  return query select n > 0;
end;
$$;

-- Atomically takes up to p_limit waiting newcomers (oldest first). Each row is returned exactly once.
create or replace function take_pending_welcomes(p_limit int)
returns table (telegram_id bigint, display_name text, joined_at timestamptz)
language sql as $$
  delete from pending_welcomes p
   where p.telegram_id in (select q.telegram_id from pending_welcomes q order by q.joined_at, q.telegram_id limit p_limit for update skip locked)
  returning p.telegram_id, p.display_name, p.joined_at;
$$;
