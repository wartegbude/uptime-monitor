-- Uptime Monitor — claim Telegram notifications before sending them.
-- dispatch() runs from the 1-minute cron and after every agent ingest, so two runs can overlap.
-- Without a claim, both read the same pending rows and the same alert is sent twice.

alter table notifications drop constraint if exists notifications_status_check;
alter table notifications add constraint notifications_status_check
  check (status in ('pending','sending','sent','failed','skipped'));
alter table notifications add column if not exists claimed_at timestamptz;

-- Atomically moves due rows to 'sending' and returns them. Concurrent callers never get the
-- same row (skip locked). A row stuck in 'sending' (the function died mid-send) is picked up
-- again after 2 minutes.
create or replace function claim_notifications(p_limit int default 100)
returns setof notifications language sql as $$
  update notifications n set status = 'sending', claimed_at = now()
  where n.id in (
    select id from notifications
    where (status = 'pending' and next_attempt_at <= now())
       or (status = 'sending' and claimed_at < now() - interval '2 minutes')
    order by id
    limit p_limit
    for update skip locked)
  returning n.*;
$$;
