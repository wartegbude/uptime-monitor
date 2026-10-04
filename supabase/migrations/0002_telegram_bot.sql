-- Telegram bot commands (/status, /test, /mute, ...)
-- Run once in the Supabase SQL editor after 0001_init.sql.

-- "Test now" requests started from Telegram reply to this chat when the agent answers
alter table test_requests add column if not exists reply_chat text;

-- /mute state: until = epoch ISO time, all = also mute down/recovery/offline alerts
insert into settings(key, value) values ('mute', '{"until": null, "all": false}')
on conflict (key) do nothing;
