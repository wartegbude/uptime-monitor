-- Run ONCE after deploying the web app to Vercel (SQL editor in Supabase).
-- Replace both values. CRON_SECRET must match the Vercel environment variable.
insert into app_secrets(key, value) values
  ('tick_url', 'https://YOUR-APP.vercel.app/api/cron/tick'),
  ('cron_secret', 'PASTE_YOUR_CRON_SECRET')
on conflict (key) do update set value = excluded.value;

-- Check the schedule is running (should list uptime-tick, uptime-rollups, uptime-cleanup):
select jobname, schedule, active from cron.job;
-- Recent tick calls (status 200 = OK):
-- select id, status_code, created from net._http_response order by id desc limit 5;
