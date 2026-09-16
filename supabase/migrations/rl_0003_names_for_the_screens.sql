-- =====================================================================
-- Revive Lab  ·  rl_0003  ·  Names for the screens
--
-- A ticket refers to people by id: the field engineer, whoever raised it,
-- the TRC engineer repairing it. The screens need their names, and cannot
-- get them by joining employees, because employees' own row policy shows a
-- person only themselves, their manager and their reports — a coordinator
-- would see "—" where every field engineer's name should be.
--
-- So the names come through these functions instead, and only for tickets
-- the caller can already see (revive_can_see): the policy decides WHICH
-- tickets, these only decide what each one says. Name and employee code,
-- nothing else from the employee record.
-- =====================================================================

create or replace function public.revive_ticket_list()
returns table (
  id uuid, number integer, code text, status text,
  trc_kind text, trc_id uuid, trc_name text,
  source_ticket_no text, item text, facility text, district text, state text,
  in_courier text, in_awb text, in_dispatched_on date,
  stakeholder_id uuid, stakeholder_name text, stakeholder_ecode text,
  stakeholder_manager_name text,
  raised_by uuid, raised_by_name text, raised_as text,
  engineer_id uuid, engineer_name text, engineer_ecode text,
  out_courier text, out_awb text, out_dispatched_on date,
  created_at timestamptz, updated_at timestamptz, closed_at timestamptz
)
language sql stable security definer set search_path to 'public'
as $fn$
  select t.id, t.number, t.code, t.status,
         t.trc_kind, t.trc_id, trc.name,
         t.source_ticket_no, t.item, t.facility, t.district, t.state,
         t.in_courier, t.in_awb, t.in_dispatched_on,
         t.stakeholder_id, sh.full_name, sh.ecode,
         shm.full_name,
         t.raised_by, rb.full_name, t.raised_as,
         t.engineer_id, en.full_name, en.ecode,
         t.out_courier, t.out_awb, t.out_dispatched_on,
         t.created_at, t.updated_at, t.closed_at
  from revive_tickets t
  join revive_trcs trc on trc.id = t.trc_id
  join employees sh on sh.id = t.stakeholder_id
  left join employees shm on shm.id = sh.reporting_manager_id
  join employees rb on rb.id = t.raised_by
  left join employees en on en.id = t.engineer_id
  where revive_can_see(t.id)
  order by t.number desc
$fn$;

/** One ticket's trail, oldest first, with who did each step. */
create or replace function public.revive_ticket_trail(p_ticket_id uuid)
returns table (
  id bigint, status text, from_status text, trc_id uuid, trc_name text,
  actor_name text, actor_ecode text, note text, at timestamptz
)
language sql stable security definer set search_path to 'public'
as $fn$
  select ev.id, ev.status, ev.from_status, ev.trc_id, trc.name,
         e.full_name, e.ecode, ev.note, ev.at
  from revive_ticket_events ev
  left join revive_trcs trc on trc.id = ev.trc_id
  left join employees e on e.id = ev.actor_id
  where ev.ticket_id = p_ticket_id
    and revive_can_see(p_ticket_id)
  order by ev.at, ev.id
$fn$;

/** One ticket's hops between labs, with the courier each went by. */
create or replace function public.revive_ticket_transfers(p_ticket_id uuid)
returns table (
  hop integer, from_trc_name text, to_trc_name text, from_trc_id uuid, to_trc_id uuid,
  courier text, awb text, dispatched_on date, reason text,
  transferred_by_name text, transferred_at timestamptz
)
language sql stable security definer set search_path to 'public'
as $fn$
  select x.hop, f.name, d.name, x.from_trc_id, x.to_trc_id,
         x.courier, x.awb, x.dispatched_on, x.reason,
         e.full_name, x.transferred_at
  from revive_transfers x
  join revive_trcs f on f.id = x.from_trc_id
  join revive_trcs d on d.id = x.to_trc_id
  left join employees e on e.id = x.transferred_by
  where x.ticket_id = p_ticket_id
    and revive_can_see(p_ticket_id)
  order by x.hop
$fn$;

/**
 * Every event on every ticket the caller can see, without names.
 *
 * What the dashboard's TAT figures are computed from. One call instead of
 * one per ticket, and nothing in it that the ticket list does not already
 * show.
 */
create or replace function public.revive_visible_events()
returns table (ticket_id uuid, status text, trc_id uuid, at timestamptz)
language sql stable security definer set search_path to 'public'
as $fn$
  select ev.ticket_id, ev.status, ev.trc_id, ev.at
  from revive_ticket_events ev
  where revive_can_see(ev.ticket_id)
  order by ev.ticket_id, ev.at, ev.id
$fn$;

grant execute on function
  public.revive_ticket_list(),
  public.revive_ticket_trail(uuid),
  public.revive_ticket_transfers(uuid),
  public.revive_visible_events()
to authenticated;
