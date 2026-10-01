/*
  rl_0038 — reopening a repair asks only for the ticket.

  rl_0037 was built with a button on the ticket and a reason to give. The
  user, 1 Oct: "not needed in ticket wise, like delete in admin panel, just
  need a field to enter ticket id thats it". The software administrator
  reopens a repair from People & Revive Labs by its number, the way a
  ticket is deleted there, so revive_reopen_repair no longer needs a reason.
  It still takes one, and writes it on the history step when it is given.
  Everything else is as rl_0037 left it.
*/

create or replace function public.revive_reopen_repair(p_ticket_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets;
begin
  -- Before the row is locked, as deleting a ticket does: nobody else gets as far as holding it.
  if not is_sw_admin() then
    raise exception 'Only the software administrator can reopen a repair';
  end if;
  t := revive_lock(p_ticket_id);
  if t.status not in ('repaired', 'not_repairable', 'service_denied') then
    raise exception 'Only a repair the engineer has closed, and that has not been dispatched or moved to scrap, can be reopened';
  end if;
  if t.engineer_id is null then
    raise exception 'It has no engineer to go back to';
  end if;
  update revive_tickets
     set status = 'in_repair', outcome = null, proposal = null,
         nr_approved_at = null, nr_approved_by = null, updated_at = now()
   where id = t.id;
  perform revive_step(t.id, 'in_repair', t.status, t.trc_id, 'status', 'reopened', left(btrim(coalesce(p_reason, '')), 1000));
end $fn$;
