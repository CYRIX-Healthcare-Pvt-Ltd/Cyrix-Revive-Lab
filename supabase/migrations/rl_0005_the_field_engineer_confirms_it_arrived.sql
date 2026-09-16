-- =====================================================================
-- Revive Lab  ·  rl_0005  ·  The field engineer confirms it arrived
--
-- "Received back" closes a ticket, and the Revive Lab's coordinator was
-- offered it the moment they had dispatched the spare. They sent it; they
-- cannot know it has landed. Closing it on their word would stop the TAT
-- clock at a moment nobody observed, and a spare lost in the courier would
-- read as a repair delivered.
--
-- So only the field engineer the spare belongs to confirms it — the one
-- person it was sent back to. A coordinator who is also that engineer (a
-- spare they sent in themselves) is that person, and still can.
--
-- The body is the live definition with only the check changed.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.revive_mark_received(p_ticket_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  -- The one person who can know it arrived is the one it arrived to. The
  -- Revive Lab sent it, and can only guess.
  if t.stakeholder_id is distinct from current_employee_id() then
    raise exception 'Only the field engineer it was sent back to can confirm it arrived';
  end if;
  if t.status <> 'in_transit_return' then
    raise exception 'This spare has not been dispatched back yet';
  end if;
  update revive_tickets
  set status = 'closed', closed_at = now(), updated_at = now()
  where id = t.id;
  perform revive_log(t.id, 'closed', t.status, t.trc_id, p_note);
end $function$
;
