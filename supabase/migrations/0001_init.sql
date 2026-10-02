-- Uptime Monitor — initial schema
-- Run in Supabase SQL editor (or `supabase db push`). Requires pg_cron + pg_net (enabled below).

create extension if not exists pgcrypto;
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------- users
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- agents (one per location)
create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  host text,
  token_hash text not null unique,
  token_tail text not null,
  status text not null default 'pending' check (status in ('pending','online','offline','revoked')),
  last_heartbeat_at timestamptz,
  heartbeat_timeout_sec int not null default 120 check (heartbeat_timeout_sec between 30 and 3600),
  agent_version text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- targets
create table if not exists targets (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  name text not null,
  method text not null check (method in ('http','ping','dns')),
  address text not null,
  interval_sec int not null default 30 check (interval_sec between 10 and 3600),
  timeout_ms int not null default 5000 check (timeout_ms between 100 and 60000),
  fail_threshold int not null default 2 check (fail_threshold between 1 and 20),
  slow_threshold_ms int not null default 1000 check (slow_threshold_ms > 0),
  options jsonb not null default '{}'::jsonb,
  is_gateway boolean not null default false,
  paused boolean not null default false,
  created_at timestamptz not null default now(),
  -- runtime state maintained by the ingest engine
  state text not null default 'unknown' check (state in ('unknown','up','slow','down')),
  consec_fail int not null default 0,
  first_fail_at timestamptz,
  consec_slow int not null default 0,
  state_since timestamptz,
  last_checked_at timestamptz,
  last_response_ms real,
  last_error text,
  last_down_alert_at timestamptz,
  slow_alerted boolean not null default false
);
create index if not exists targets_agent_idx on targets(agent_id);

-- ---------------------------------------------------------------- raw check results
create table if not exists check_results (
  id bigserial primary key,
  target_id uuid not null references targets(id) on delete cascade,
  checked_at timestamptz not null,
  success boolean not null,
  response_ms real,
  status_code int,
  packet_loss real,
  error text,
  detail text,
  delayed boolean not null default false
);
create index if not exists check_results_target_time_idx on check_results(target_id, checked_at desc);
create index if not exists check_results_time_idx on check_results(checked_at);

-- ---------------------------------------------------------------- rollups for long ranges
create table if not exists check_rollups (
  target_id uuid not null references targets(id) on delete cascade,
  bucket text not null check (bucket in ('minute','hour','day')),
  bucket_start timestamptz not null,
  total int not null,
  success_count int not null,
  avg_ms real,
  min_ms real,
  max_ms real,
  p95_ms real,
  primary key (target_id, bucket, bucket_start)
);

-- ---------------------------------------------------------------- incidents
create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('target_down','agent_offline')),
  target_id uuid references targets(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  cause text,          -- timeout | dns | status | loss | conn | isp | lan | internet | server
  detail text,
  notified boolean not null default false
);
create index if not exists incidents_time_idx on incidents(started_at desc);
create index if not exists incidents_open_idx on incidents(agent_id) where ended_at is null;

-- ---------------------------------------------------------------- telegram queue + log
create table if not exists notifications (
  id bigserial primary key,
  kind text not null,  -- down | recovery | slow | agent_offline | agent_online | summary | test
  agent_id uuid references agents(id) on delete set null,
  target_id uuid references targets(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  retries int not null default 0,
  next_attempt_at timestamptz not null default now(),
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists notifications_pending_idx on notifications(next_attempt_at) where status = 'pending';

-- ---------------------------------------------------------------- key/value settings
create table if not exists settings (
  key text primary key,
  value jsonb not null
);
insert into settings(key, value) values
  ('retention_days', '30'),
  ('timezone', '"Asia/Jakarta"'),
  ('telegram', '{"bot_token_enc": null, "chat_id": null}'),
  ('alerts', '{"down": true, "recovery": true, "slow": true, "agent_offline": true}'),
  ('summary', '{"enabled": true, "frequency": "daily", "every_hours": 12, "at": "08:00", "weekday": 1, "last_sent_at": null}'),
  ('quiet_hours', '{"enabled": false, "from": "22:00", "to": "06:00"}'),
  ('cooldown_min', '5')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- "Test now" requests executed by the agent
create table if not exists test_requests (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  spec jsonb not null,
  status text not null default 'pending' check (status in ('pending','sent','done')),
  result jsonb,
  created_at timestamptz not null default now(),
  done_at timestamptz
);

-- ---------------------------------------------------------------- login rate limit
create table if not exists login_attempts (
  ip text primary key,
  fails int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- private config for pg_cron → app
create table if not exists app_secrets (
  key text primary key,
  value text not null
);

-- Lock everything down: the web app uses the service-role key, nothing is exposed to anon.
alter table users enable row level security;
alter table agents enable row level security;
alter table targets enable row level security;
alter table check_results enable row level security;
alter table check_rollups enable row level security;
alter table incidents enable row level security;
alter table notifications enable row level security;
alter table settings enable row level security;
alter table test_requests enable row level security;
alter table login_attempts enable row level security;
alter table app_secrets enable row level security;

-- ================================================================ functions

-- Upsert minute/hour/day rollups for results since p_since.
create or replace function refresh_rollups(p_since timestamptz)
returns void language plpgsql as $$
declare b text;
begin
  foreach b in array array['minute','hour','day'] loop
    insert into check_rollups(target_id, bucket, bucket_start, total, success_count, avg_ms, min_ms, max_ms, p95_ms)
    select target_id, b, date_trunc(b, checked_at) as bs,
           count(*), count(*) filter (where success),
           avg(response_ms) filter (where success),
           min(response_ms) filter (where success),
           max(response_ms) filter (where success),
           percentile_cont(0.95) within group (order by response_ms) filter (where success)
    from check_results
    where checked_at >= date_trunc(b, p_since)
    group by target_id, bs
    on conflict (target_id, bucket, bucket_start) do update set
      total = excluded.total, success_count = excluded.success_count, avg_ms = excluded.avg_ms,
      min_ms = excluded.min_ms, max_ms = excluded.max_ms, p95_ms = excluded.p95_ms;
  end loop;
end $$;

-- Response-time series for many targets, binned by p_step_sec. Returns one JSON document
-- (avoids PostgREST row limits). Uses raw rows for short ranges, hour rollups for long ones.
create or replace function get_series(p_target_ids uuid[], p_from timestamptz, p_to timestamptz, p_step_sec int)
returns jsonb language sql stable as $$
  with src as (
    select target_id, checked_at as t, 1 as total, (case when success then 1 else 0 end) as ok,
           case when success then response_ms end as ms_sum_w, case when success then response_ms end as mx
    from check_results
    where p_step_sec < 3600 and target_id = any(p_target_ids) and checked_at >= p_from and checked_at < p_to
    union all
    select target_id, bucket_start, total, success_count, avg_ms * success_count, max_ms
    from check_rollups
    where p_step_sec >= 3600 and bucket = 'hour' and target_id = any(p_target_ids) and bucket_start >= p_from and bucket_start < p_to
  ), binned as (
    select target_id,
           date_bin(make_interval(secs => p_step_sec), t, timestamptz '2000-01-01 00:00:00+00') as b,
           sum(total) as total, sum(ok) as ok,
           case when sum(ok) > 0 then sum(ms_sum_w) / sum(ok) end as avg_ms,
           max(mx) as max_ms
    from src group by target_id, b
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'target_id', target_id, 't', extract(epoch from b) * 1000,
           'total', total, 'ok', ok, 'avg', round(avg_ms::numeric, 2), 'max', round(max_ms::numeric, 2))
         order by target_id, b), '[]'::jsonb)
  from binned;
$$;

-- Min / avg / max / p95 for one target in a range (raw rows).
create or replace function target_stats(p_target uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'total', count(*), 'ok', count(*) filter (where success),
    'min', min(response_ms) filter (where success),
    'avg', avg(response_ms) filter (where success),
    'max', max(response_ms) filter (where success),
    'p95', percentile_cont(0.95) within group (order by response_ms) filter (where success))
  from check_results where target_id = p_target and checked_at >= p_from and checked_at < p_to;
$$;

-- Paged, filtered check log (status computed against each target's slow threshold).
create or replace function get_logs(p_agent uuid, p_target uuid, p_from timestamptz, p_to timestamptz,
                                    p_status text, p_q text, p_sort text, p_desc boolean, p_limit int, p_offset int)
returns jsonb language sql stable as $$
  with base as (
    select r.id, r.checked_at, r.success, r.response_ms, r.status_code, r.packet_loss, r.error, r.delayed,
           t.id as target_id, t.name as target_name, t.method, t.address, a.name as agent_name,
           case when not r.success then 'down' when r.response_ms > t.slow_threshold_ms then 'slow' else 'up' end as status
    from check_results r
    join targets t on t.id = r.target_id
    join agents a on a.id = t.agent_id
    where r.checked_at >= p_from and r.checked_at < p_to
      and (p_agent is null or t.agent_id = p_agent)
      and (p_target is null or t.id = p_target)
      and (coalesce(p_q, '') = '' or r.error ilike '%' || p_q || '%' or t.name ilike '%' || p_q || '%')
  ), f as (
    select * from base where coalesce(p_status, 'all') = 'all' or status = p_status
  )
  select jsonb_build_object(
    'total', (select count(*) from f),
    'rows', coalesce((select jsonb_agg(to_jsonb(x)) from (
      select * from f order by
        case when p_sort = 'target' and not p_desc then target_name end asc,
        case when p_sort = 'target' and p_desc then target_name end desc,
        case when p_sort = 'status' and not p_desc then status end asc,
        case when p_sort = 'status' and p_desc then status end desc,
        case when p_sort = 'ms' and not p_desc then response_ms end asc nulls first,
        case when p_sort = 'ms' and p_desc then response_ms end desc nulls last,
        case when p_sort = 'time' and not p_desc then checked_at end asc,
        checked_at desc
      limit p_limit offset p_offset) x), '[]'::jsonb));
$$;

-- Daily retention cleanup.
create or replace function cleanup_old_data()
returns void language plpgsql as $$
declare days int;
begin
  select coalesce((value)::text::int, 30) into days from settings where key = 'retention_days';
  delete from check_results where checked_at < now() - make_interval(days => days);
  delete from check_rollups where bucket = 'minute' and bucket_start < now() - make_interval(days => days);
  delete from check_rollups where bucket <> 'minute' and bucket_start < now() - make_interval(days => greatest(days, 400));
  delete from notifications where created_at < now() - interval '60 days';
  delete from test_requests where created_at < now() - interval '1 day';
  delete from login_attempts where updated_at < now() - interval '1 day';
end $$;

-- Calls the app's alert/scheduler endpoint (configured in app_secrets).
create or replace function call_tick()
returns void language plpgsql security definer as $$
declare u text; s text;
begin
  select value into u from app_secrets where key = 'tick_url';
  select value into s from app_secrets where key = 'cron_secret';
  if u is null then return; end if;
  perform net.http_post(url := u, headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || coalesce(s,'')), body := '{}'::jsonb, timeout_milliseconds := 25000);
end $$;

-- ================================================================ schedules
select cron.unschedule(jobname) from cron.job where jobname in ('uptime-tick','uptime-rollups','uptime-cleanup');
select cron.schedule('uptime-tick', '* * * * *', $$select call_tick()$$);
select cron.schedule('uptime-rollups', '*/5 * * * *', $$select refresh_rollups(now() - interval '2 hours')$$);
select cron.schedule('uptime-cleanup', '0 20 * * *', $$select cleanup_old_data()$$);  -- 03:00 WIB
