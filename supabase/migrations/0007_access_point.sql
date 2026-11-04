-- Target type "access point": an external device with its own label and icon.
-- It behaves exactly like an external device (is_device = true): monitored and alerted
-- on its own, never makes a location Degraded / Internet down.
-- Run once in the Supabase SQL editor after 0006_agent_rate_limit.sql, before deploying the web app.

alter table targets add column if not exists is_ap boolean not null default false;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'targets_ap_check') then
    alter table targets add constraint targets_ap_check check (not is_ap or is_device);
  end if;
end $$;
