-- Uptime Monitor — rate limit for the agent endpoints (PRD: "Endpoint agent ... dibatasi rate limit").
-- Fixed-window counters in Postgres: on Vercel every request may run in a different instance,
-- so an in-memory counter would not hold.

create table if not exists rate_limits (
  key text primary key,
  window_start timestamptz not null,
  hits int not null
);
alter table rate_limits enable row level security;

-- Counts one hit for p_key and returns true while it is within p_limit hits per p_window_sec.
create or replace function rate_hit(p_key text, p_limit int, p_window_sec int)
returns boolean language sql as $$
  insert into rate_limits as r (key, window_start, hits) values (p_key, now(), 1)
  on conflict (key) do update set
    hits = case when r.window_start <= now() - make_interval(secs => p_window_sec) then 1 else r.hits + 1 end,
    window_start = case when r.window_start <= now() - make_interval(secs => p_window_sec) then now() else r.window_start end
  returning hits <= p_limit;
$$;

-- Daily retention cleanup (same as 0001, plus old rate-limit windows).
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
  delete from rate_limits where window_start < now() - interval '1 day';
end $$;
