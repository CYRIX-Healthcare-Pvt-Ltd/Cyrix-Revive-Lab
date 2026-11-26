-- rl_0069: a manager who does not agree a spare is not repairable chooses where it goes next
-- (the user, 16 Nov, after RL-595: Joseph P V sent it "back for repair" with "pls send this to cochin",
-- but it went back to the engineer and waited on nobody at the desk).
--
--   Repair here                → back to the engineer, in repair, as before.
--   Send to another Revive Lab → back in repair here, and a transfer to that lab is asked for at once,
--                                exactly as the coordinator's Transfer does: another state's lab waits on
--                                the project head (Waiting on you · Approver); otherwise it is approved
--                                at once and waits on the coordinator to send it.
--
-- Returns the status it was left in: in_repair, awaiting_approval or approved.

drop function if exists public.revive_decline_not_repairable(uuid, text);

create or replace function public.revive_decline_not_repairable(p_ticket_id uuid, p_reason text, p_to_trc_id uuid default null)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  t    revive_tickets := revive_lock(p_ticket_id);
  why  text := btrim(coalesce(p_reason, ''));
  dest revive_trcs;
  a    revive_approvals;
begin
  if not revive_manages_trc(t.trc_id) then
    raise exception 'Only a manager of this Revive Lab can send it back to be repaired';
  end if;
  if t.status <> 'not_repairable' or t.nr_approved_at is not null then
    raise exception 'It is not waiting for approval as not repairable';
  end if;
  if p_to_trc_id is not null then
    select * into dest from revive_trcs where id = p_to_trc_id and is_active;
    if not found then raise exception 'Choose the Revive Lab it is going to'; end if;
    if dest.id = t.trc_id then raise exception 'It is already at that Revive Lab'; end if;
    if length(why) < 5 then raise exception 'Say why it is being sent there'; end if;
    if length(why) > 500 then raise exception 'Keep the reason under 500 characters'; end if;
  elsif length(why) < 5 then
    raise exception 'Say why it should be repaired — what to try';
  end if;

  update revive_tickets
     set status = 'in_repair', outcome = null, proposal = null,
         nr_approved_at = null, nr_approved_by = null, updated_at = now()
   where id = t.id;
  perform revive_step(t.id, 'in_repair', t.status, t.trc_id, 'status', 'nr_declined',
    left(case when dest.id is null then why else 'Send to ' || dest.name || ': ' || why end, 1000));

  if dest.id is null then
    return 'in_repair';
  end if;

  -- The transfer, as revive_request_transfer asks it (the head is filled in by revive_approval_head).
  insert into revive_approvals (ticket_id, kind, from_trc_id, asked_trc_id, to_trc_id, reason, back_to, requested_by)
  values (t.id, 'transfer', t.trc_id, dest.id, dest.id, why, 'in_repair', current_employee_id())
  returning * into a;
  if a.head_id is null then
    update revive_approvals
       set status = 'approved', decided_by = current_employee_id(), decided_at = now(), updated_at = now()
     where id = a.id;
    update revive_tickets set status = 'approved', updated_at = now() where id = t.id;
    perform revive_step(t.id, 'approved', 'in_repair', t.trc_id, 'status', 'transfer_requested', 'To ' || dest.name || ': ' || why);
    return 'approved';
  end if;
  update revive_tickets set status = 'awaiting_approval', updated_at = now() where id = t.id;
  perform revive_step(t.id, 'awaiting_approval', 'in_repair', t.trc_id, 'status', 'transfer_requested', 'To ' || dest.name || ': ' || why);
  return 'awaiting_approval';
end $function$;

revoke all on function public.revive_decline_not_repairable(uuid, text, uuid) from public, anon;
grant execute on function public.revive_decline_not_repairable(uuid, text, uuid) to authenticated;
