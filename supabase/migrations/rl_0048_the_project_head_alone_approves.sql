-- =====================================================================
-- Revive Lab · rl_0048 · The project head alone approves another state
--
-- The user, 8 Oct: "regional trc approval not needed for interstate
-- transfer, ie project manager to coordinator". A move to another state's
-- Revive Lab whose BEMMP has a head is approved by that head and goes on;
-- the Regional Revive Lab admins approve only where there is no head.
-- A head who asks themselves still approves it as a separate step.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.revive_approve(p_ticket_id uuid, p_to_trc_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t     revive_tickets := revive_lock(p_ticket_id);
  a     revive_approvals;
  dest  revive_trcs;
  asked text;
  n     text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into a from revive_approvals where ticket_id = t.id and status = 'pending' for update;
  if not found or t.status <> 'awaiting_approval' then
    raise exception 'This ticket is not waiting for approval';
  end if;
  -- Another state's Revive Lab: the BEMMP's project head approves it, alone (rl_0048).
  -- No head on that BEMMP: the Regional Revive Lab admins, as before.
  if a.head_id is not null then
    if current_employee_id() is distinct from a.head_id and not is_sw_admin() then
      raise exception 'Only the project head, %, approves this one',
        (select full_name from employees where id = a.head_id);
    end if;
    update revive_approvals
       set head_decided_at = now(), head_decided_by = current_employee_id(), head_note = n
     where id = a.id;
  elsif not revive_approves() then
    raise exception 'Only the Regional Revive Lab admins approve where a spare goes';
  end if;
  select * into dest from revive_trcs where id = coalesce(p_to_trc_id, a.to_trc_id) and is_active;
  if not found then raise exception 'Choose a Revive Lab that is taking tickets'; end if;
  if a.kind = 'transfer' and dest.id = a.from_trc_id then
    raise exception 'It is already at that Revive Lab — decline the transfer instead';
  end if;
  if length(n) > 500 then raise exception 'Keep the note under 500 characters'; end if;
  select name into asked from revive_trcs where id = a.asked_trc_id;

  update revive_approvals
     set status = 'approved', to_trc_id = dest.id, decided_by = current_employee_id(),
         decided_at = now(), decision_note = n, updated_at = now()
   where id = a.id;
  -- A raise is for the approved Revive Lab from now on. A transfer stays
  -- where the spare is until the coordinator sends it.
  update revive_tickets
     set status = case when a.kind = 'return' then a.back_to else 'approved' end,
         trc_id = case when a.kind = 'raise' then dest.id else trc_id end,
         trc_kind = case when a.kind = 'raise' then dest.kind else trc_kind end,
         updated_at = now()
   where id = t.id;
  perform revive_step(t.id, case when a.kind = 'return' then a.back_to else 'approved' end, t.status,
    case when a.kind = 'raise' then dest.id else t.trc_id end, 'status', 'approved',
    concat_ws(' · ',
      'For ' || dest.name || case when dest.id <> a.asked_trc_id then ' instead of ' || asked else '' end,
      n));
end $function$
;

CREATE OR REPLACE FUNCTION public.revive_decline_approval(p_ticket_id uuid, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t     revive_tickets := revive_lock(p_ticket_id);
  a     revive_approvals;
  asked text;
  n     text := btrim(coalesce(p_note, ''));
begin
  select * into a from revive_approvals where ticket_id = t.id and status = 'pending' for update;
  if not found or t.status <> 'awaiting_approval' then
    raise exception 'This ticket is not waiting for approval';
  end if;
  -- The project head may decline while it waits on them (rl_0047); the Regional admins at any time.
  -- The project head declines where there is one (rl_0048); the Regional admins otherwise.
  if (case when a.head_id is not null then current_employee_id() is distinct from a.head_id and not is_sw_admin()
           else not revive_approves() end) then
    raise exception 'Only the project head or the Regional Revive Lab admins approve where a spare goes';
  end if;
  if length(n) < 3 then raise exception 'Say why it is not approved'; end if;
  if length(n) > 500 then raise exception 'Keep the reason under 500 characters'; end if;
  select name into asked from revive_trcs where id = a.to_trc_id;

  update revive_approvals
     set status = 'declined', decided_by = current_employee_id(), decided_at = now(),
         decision_note = n, updated_at = now()
   where id = a.id;
  if a.kind = 'raise' then
    -- Back to the field engineer: their own state's or a Regional Revive Lab, or discard it.
    update revive_tickets set status = 'not_approved', updated_at = now() where id = t.id;
    perform revive_step(t.id, 'not_approved', t.status, t.trc_id, 'status', 'declined',
      'For ' || asked || ': ' || n);
  else
    update revive_tickets set status = a.back_to, updated_at = now() where id = t.id;
    perform revive_step(t.id, a.back_to, t.status, t.trc_id, 'status', 'declined',
      'Transfer to ' || asked || ': ' || n);
  end if;
end $function$
;

CREATE OR REPLACE FUNCTION public.revive_approval_head()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  select bp.head_id into new.head_id
    from revive_tickets t
    join revive_bemmp_projects bp on bp.id = t.bemmp_id
    join revive_trcs d on d.id = new.asked_trc_id
   where t.id = new.ticket_id
     and d.state is not null and d.state is distinct from t.state
     and bp.head_id is not null;
  return new;
end $function$
;

notify pgrst, 'reload schema';
