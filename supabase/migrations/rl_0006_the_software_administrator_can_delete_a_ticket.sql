-- =====================================================================
-- Revive Lab  ·  rl_0006  ·  The software administrator can delete a ticket
--
-- The first live trial raises tickets that are not real — RL-05 went to a
-- field engineer as a test — and nothing could take one away again. So the
-- software administrator, and only them, can now delete a ticket outright.
--
-- Its trail goes with it: events, transfers and any mail still queued are
-- all ON DELETE CASCADE from the ticket. What stays is one audit line,
-- written before the row goes, saying what the ticket was, how far it had
-- got, and who removed it — a deleted ticket should not also be a ticket
-- nobody can account for.
--
-- Numbering. A sequence never gives a number back, and rehearsing the
-- migrations spent RL-01 to RL-04 before anybody had raised anything, which
-- is why the first real ticket was RL-05. When a delete leaves no tickets at
-- all, numbering restarts at RL-01: clearing out a test run is a clean start
-- rather than a gap nobody can explain. While any ticket remains, a deleted
-- number is never handed out again.
-- =====================================================================

create or replace function public.revive_delete_ticket(p_ticket_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t         revive_tickets;
  n_events  integer;
  n_hops    integer;
  remaining integer;
begin
  if not is_sw_admin() then
    raise exception 'Only the software administrator can delete a ticket';
  end if;

  select * into t from revive_tickets where id = p_ticket_id for update;
  if not found then
    raise exception 'That ticket does not exist';
  end if;

  select count(*) into n_events from revive_ticket_events where ticket_id = t.id;
  select count(*) into n_hops from revive_transfers where ticket_id = t.id;

  perform log_audit('revive_ticket', t.id, 'deleted', jsonb_build_object(
    'code', t.code,
    'status', t.status,
    'facility', t.facility,
    'source_ticket_no', t.source_ticket_no,
    'item', t.item,
    'trc_id', t.trc_id,
    'stakeholder_id', t.stakeholder_id,
    'raised_by', t.raised_by,
    'created_at', t.created_at,
    'events', n_events,
    'transfers', n_hops));

  delete from revive_tickets where id = t.id;

  select count(*) into remaining from revive_tickets;
  if remaining = 0 then
    perform setval('public.revive_ticket_number', 1, false);
  end if;

  return jsonb_build_object('code', t.code, 'numbering_restarted', remaining = 0);
end $fn$;

grant execute on function public.revive_delete_ticket(uuid) to authenticated;
