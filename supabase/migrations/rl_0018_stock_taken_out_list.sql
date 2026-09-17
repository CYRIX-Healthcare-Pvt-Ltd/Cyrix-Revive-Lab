-- =====================================================================
-- rl_0018 — what engineers have taken from stock, in one list
-- =====================================================================
--
-- Since rl_0016 the coordinator approves what comes off the stock, one
-- ticket at a time. This is the same thing read the other way round: every
-- component an engineer has taken or asked for, newest first, so the desk
-- can work through what is waiting without opening each ticket to find it.

create or replace function public.revive_stock_use_list(p_status text default null)
returns table (
  id uuid, ticket_id uuid, ticket_code text, ticket_status text, facility text,
  trc_id uuid, trc_name text,
  component_id uuid, part_no text, value text, item text, package text, in_stock integer,
  qty integer, status text, source text,
  requested_by uuid, requested_by_name text, requested_at timestamptz,
  decided_by_name text, decided_at timestamptz, decision_note text
)
language sql stable security definer set search_path to 'public'
as $fn$
  select u.id, u.ticket_id, t.code, t.status, t.facility,
         u.trc_id, trc.name,
         u.component_id, c.part_no, c.value, c.item, c.package, c.qty,
         u.qty, u.status, u.source,
         u.requested_by, rq.full_name, u.requested_at,
         dc.full_name, u.decided_at, u.decision_note
  from revive_stock_uses u
  join revive_tickets t on t.id = u.ticket_id
  join revive_trcs trc on trc.id = u.trc_id
  join revive_components c on c.id = u.component_id
  left join employees rq on rq.id = u.requested_by
  left join employees dc on dc.id = u.decided_by
  where (p_status is null or u.status = p_status)
    and revive_can_see(u.ticket_id)
  order by u.requested_at desc
$fn$;
revoke execute on function public.revive_stock_use_list(text) from public, anon;
grant execute on function public.revive_stock_use_list(text) to authenticated;
