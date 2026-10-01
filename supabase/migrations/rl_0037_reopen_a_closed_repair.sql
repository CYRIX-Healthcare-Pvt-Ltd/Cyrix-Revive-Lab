/*
  rl_0037 — the software administrator reopens a repair the engineer closed.

  The user, 1 Oct: "they need reopen button … the ticket which trc eng
  status done, may be repaired not repaired etc, ie tickets before dispatch
  or scrap, before final decision from coordinator" — and whose it is: "we
  have delete option for swadmin, like that give for sw admin only".

  revive_reopen_repair puts a repair closed as repaired, not repairable or
  denied by the customer back in repair, with the engineer who had it, while
  the Revive Lab still has the spare: before it is dispatched or moved to
  scrap. The outcome, the proposal and a manager's approval are cleared, as
  when a manager sends a not-repairable spare back (rl_0034); the engineer
  closes it again when it is done. What was closed, and why it was reopened,
  stay in the history, as a step of its own (action 'reopened').

  The category TAT follows without a change: revive_ticket_list gives no
  repaired_at while a spare is in repair, and the latest close once it is
  closed again (rl_0030).
*/

create or replace function public.revive_reopen_repair(p_ticket_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t   revive_tickets;
  why text := btrim(coalesce(p_reason, ''));
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
  if length(why) < 5 then
    raise exception 'Say why it is reopened';
  end if;
  update revive_tickets
     set status = 'in_repair', outcome = null, proposal = null,
         nr_approved_at = null, nr_approved_by = null, updated_at = now()
   where id = t.id;
  perform revive_step(t.id, 'in_repair', t.status, t.trc_id, 'status', 'reopened', left(why, 1000));
end $fn$;

revoke all on function public.revive_reopen_repair(uuid, text) from public, anon;
grant execute on function public.revive_reopen_repair(uuid, text) to authenticated;
