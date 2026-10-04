-- Manual target order (Settings → Targets: drag or ▲▼). Order is per location.
-- Run once in the Supabase SQL editor after 0003_external_device.sql.

alter table targets add column if not exists sort_order int not null default 0;

-- keep the current order (creation time) as the starting point
update targets t set sort_order = x.rn
from (select id, row_number() over (partition by agent_id order by created_at) as rn from targets) x
where t.id = x.id and t.sort_order = 0;

-- Applies a new order in one statement: position in the array = sort_order.
create or replace function reorder_targets(p_ids uuid[])
returns void language sql as $$
  update targets t set sort_order = o.pos
  from unnest(p_ids) with ordinality as o(id, pos)
  where t.id = o.id;
$$;
