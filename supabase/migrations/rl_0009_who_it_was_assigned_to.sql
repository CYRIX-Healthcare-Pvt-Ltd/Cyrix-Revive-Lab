-- =====================================================================
-- rl_0009 — who it was assigned to, in the history
-- =====================================================================
--
-- The history said "Assigned to an engineer" and stopped there. The ticket
-- knows its engineer today, but a reassignment overwrites the one before,
-- so nothing could say who had it first. Each assignment now writes its
-- engineer onto its own event, and the trail hands the name out with it.
--
-- Assigning it again to the engineer who already has it is refused: it
-- would put a "Reassigned" in the history that changed nothing.
--
-- Additive for the screens already live: the trail gains two columns, and
-- revive_assign keeps its signature.

alter table public.revive_ticket_events
  add column if not exists engineer_id uuid references public.employees(id);

comment on column public.revive_ticket_events.engineer_id is
  'On an assigned event: the engineer it was given to at that moment.';

/** Given to one of the lab's engineers — or given again to a different one. */
create or replace function public.revive_assign(
  p_ticket_id uuid, p_engineer_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
  eid bigint;
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator or manager of this Revive Lab can assign it';
  end if;
  if t.status not in ('accepted', 'assigned') then
    raise exception 'Accept the ticket before assigning it';
  end if;
  if t.status = 'assigned' and t.engineer_id = p_engineer_id then
    raise exception 'It is already assigned to them. Choose a different engineer to reassign it';
  end if;
  if not exists (
    select 1 from revive_members m
    join revive_member_trcs mt on mt.employee_id = m.employee_id
    where m.employee_id = p_engineer_id and m.is_engineer and mt.trc_id = t.trc_id
  ) then
    raise exception 'That person is not an engineer at this Revive Lab';
  end if;
  update revive_tickets
  set status = 'assigned', engineer_id = p_engineer_id, updated_at = now()
  where id = t.id;
  eid := revive_log(t.id, 'assigned', t.status, t.trc_id, p_note);
  update revive_ticket_events set engineer_id = p_engineer_id where id = eid;
end $fn$;

/** One ticket's trail, oldest first, with who did each step and who it was given to. */
drop function if exists public.revive_ticket_trail(uuid);
create function public.revive_ticket_trail(p_ticket_id uuid)
returns table (
  id bigint, status text, from_status text, trc_id uuid, trc_name text,
  actor_name text, actor_ecode text, note text, at timestamptz,
  engineer_name text, engineer_ecode text
)
language sql stable security definer set search_path to 'public'
as $fn$
  select ev.id, ev.status, ev.from_status, ev.trc_id, trc.name,
         e.full_name, e.ecode, ev.note, ev.at,
         en.full_name, en.ecode
  from revive_ticket_events ev
  left join revive_trcs trc on trc.id = ev.trc_id
  left join employees e on e.id = ev.actor_id
  left join employees en on en.id = ev.engineer_id
  where ev.ticket_id = p_ticket_id
    and revive_can_see(p_ticket_id)
  order by ev.at, ev.id
$fn$;

grant execute on function public.revive_ticket_trail(uuid) to anon, authenticated, service_role;

/*
  The assignments already on record. Only revive_assign ever sets a
  ticket's engineer, and handing back or transferring clears it, so a
  ticket with an engineer now got them from its latest assignment. Earlier
  assignments on a reassigned ticket cannot be recovered and stay unnamed.
*/
update public.revive_ticket_events ev
set engineer_id = t.engineer_id
from public.revive_tickets t
where ev.ticket_id = t.id
  and t.engineer_id is not null
  and ev.engineer_id is null
  and ev.id = (
    select max(e2.id) from public.revive_ticket_events e2
    where e2.ticket_id = t.id and e2.status = 'assigned'
  );
