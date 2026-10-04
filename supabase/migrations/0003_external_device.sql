-- Target type "external device": monitored and alerted on its own, but it never makes a
-- location Degraded / Internet down and is left out of the location uptime numbers.
-- Run once in the Supabase SQL editor after 0002_telegram_bot.sql.

alter table targets add column if not exists is_device boolean not null default false;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'targets_role_check') then
    alter table targets add constraint targets_role_check check (not (is_gateway and is_device));
  end if;
end $$;

-- separate on/off switch for device alerts (default on)
update settings set value = value || '{"device": true}'::jsonb where key = 'alerts' and not (value ? 'device');
