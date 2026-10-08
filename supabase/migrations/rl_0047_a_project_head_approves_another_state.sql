-- =====================================================================
-- Revive Lab · rl_0047 · A BEMMP's project head approves a move to another state
--
-- The user, 8 Oct: "in bemmp we need to add project head id also, ie if kl,
-- i need to select who is head, but not mandatory ... if anyone transfer or
-- raise to other state trc it should go to project head approval and after
-- his approval only to resp coordinator it will receive."
-- Decided with the user: the ticket's own BEMMP (from the route card) names
-- the head; the head approves first, then the Regional Revive Lab admins as
-- today; and it covers raise, transfer, and a return after repair.
--
-- No head on that BEMMP, or a move inside the state: as before. The head is
-- copied onto the request when it is made, so changing a BEMMP's head later
-- does not move a request already waiting. A head who asks themselves is
-- taken as having approved.
-- =====================================================================

alter table public.revive_bemmp_projects
  add column if not exists head_id uuid references public.employees(id) on delete set null;

alter table public.revive_approvals
  add column if not exists head_id uuid references public.employees(id) on delete set null,
  add column if not exists head_decided_at timestamptz,
  add column if not exists head_decided_by uuid references public.employees(id) on delete set null,
  add column if not exists head_note text check (head_note is null or length(head_note) <= 500);

-- A return after repair is a third kind: the field engineer asks, from received_back.
alter table public.revive_approvals drop constraint if exists revive_approvals_kind_check;
alter table public.revive_approvals add constraint revive_approvals_kind_check
  check (kind = any (array['raise', 'transfer', 'return']));
do $$
declare cn text;
begin
  select conname into cn from pg_constraint
   where conrelid = 'public.revive_approvals'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%from_trc_id IS NOT NULL%';
  if cn is not null then execute format('alter table public.revive_approvals drop constraint %I', cn); end if;
end $$;
alter table public.revive_approvals add constraint revive_approvals_from_check
  check ((kind in ('transfer', 'return')) = (from_trc_id is not null and back_to is not null));

-- Who heads it, copied onto each request as it is made.
create or replace function public.revive_approval_head()
returns trigger language plpgsql security definer set search_path to 'public' as $f$
begin
  select bp.head_id into new.head_id
    from revive_tickets t
    join revive_bemmp_projects bp on bp.id = t.bemmp_id
    join revive_trcs d on d.id = new.asked_trc_id
   where t.id = new.ticket_id
     and d.state is not null and d.state is distinct from t.state
     and bp.head_id is not null;
  if new.head_id is not null and new.head_id = new.requested_by then
    new.head_decided_at := now();
    new.head_decided_by := new.requested_by;
  end if;
  return new;
end $f$;
drop trigger if exists revive_approval_head on public.revive_approvals;
create trigger revive_approval_head before insert on public.revive_approvals
  for each row execute function public.revive_approval_head();

-- Set or clear a BEMMP's head, by E-code. They are given Revive Lab on the portal.
create or replace function public.revive_set_bemmp_head(p_id uuid, p_ecode text)
returns void language plpgsql security definer set search_path to 'public' as $f$
declare
  code text := nullif(upper(btrim(coalesce(p_ecode, ''))), '');
  who  uuid;
begin
  if not revive_is_admin() then
    raise exception 'Only a Revive Lab admin can change the BEMMP list';
  end if;
  if not exists (select 1 from revive_bemmp_projects where id = p_id) then
    raise exception 'No such BEMMP';
  end if;
  if code is not null then
    select id into who from employees where upper(ecode) = code and is_active;
    if who is null then raise exception 'No active employee has the code %', code; end if;
    insert into employee_modules (employee_id, module_code) values (who, 'revive')
      on conflict do nothing;
  end if;
  update revive_bemmp_projects set head_id = who where id = p_id;
end $f$;
revoke all on function public.revive_set_bemmp_head(uuid, text) from public, anon;
grant execute on function public.revive_set_bemmp_head(uuid, text) to authenticated;

-- Still not working, and it should go to another state's Revive Lab: asked for first.
create or replace function public.revive_request_return(p_ticket_id uuid, p_to_trc_id uuid, p_reason text)
returns void language plpgsql security definer set search_path to 'public' as $f$
declare
  t    revive_tickets := revive_lock(p_ticket_id);
  dest revive_trcs;
  why  text := btrim(coalesce(p_reason, ''));
begin
  if t.stakeholder_id is distinct from current_employee_id() then
    raise exception 'Only the field engineer it was sent back to can return it';
  end if;
  if t.status <> 'received_back' then
    raise exception 'Confirm the spare arrived before sending it back';
  end if;
  select * into dest from revive_trcs where id = p_to_trc_id and is_active;
  if not found then raise exception 'Choose the Revive Lab it is going to'; end if;
  if dest.state is null or dest.state is not distinct from t.state or dest.id = t.trc_id then
    raise exception '% needs no approval — return it there directly', dest.name;
  end if;
  if length(why) < 5 then raise exception 'Say why it should go there'; end if;
  if length(why) > 500 then raise exception 'Keep the reason under 500 characters'; end if;
  update revive_approvals set status = 'cancelled', updated_at = now()
   where ticket_id = t.id and kind = 'return' and status = 'approved';

  insert into revive_approvals (ticket_id, kind, from_trc_id, asked_trc_id, to_trc_id, reason, back_to, requested_by)
  values (t.id, 'return', t.trc_id, dest.id, dest.id, why, t.status, current_employee_id());
  update revive_tickets set status = 'awaiting_approval', updated_at = now() where id = t.id;
  perform revive_step(t.id, 'awaiting_approval', t.status, t.trc_id, 'status', 'return_requested',
    'To ' || dest.name || ': ' || why);
end $f$;
revoke all on function public.revive_request_return(uuid, uuid, text) from public, anon;
grant execute on function public.revive_request_return(uuid, uuid, text) to authenticated;

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
  -- Another state's Revive Lab: the BEMMP's project head approves first (rl_0047).
  if a.head_id is not null and a.head_decided_at is null then
    if current_employee_id() is distinct from a.head_id and not is_sw_admin() then
      raise exception 'Waiting for the project head, %, to approve first',
        (select full_name from employees where id = a.head_id);
    end if;
    if length(n) > 500 then raise exception 'Keep the note under 500 characters'; end if;
    update revive_approvals
       set head_decided_at = now(), head_decided_by = current_employee_id(), head_note = n, updated_at = now()
     where id = a.id;
    perform revive_step(t.id, t.status, t.status, t.trc_id, 'status', 'head_approved',
      concat_ws(' · ', 'Project head approved', n));
    return;
  end if;
  if not revive_approves() then
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
  if not revive_approves()
     and not (a.head_id = current_employee_id() and a.head_decided_at is null) then
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

CREATE OR REPLACE FUNCTION public.revive_cancel_transfer(p_ticket_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t revive_tickets := revive_lock(p_ticket_id);
  a revive_approvals;
  n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into a from revive_approvals
   where ticket_id = t.id and kind in ('transfer', 'return') and status in ('pending', 'approved') for update;
  if not found or t.status not in ('awaiting_approval', 'approved', 'received_back') then
    raise exception 'There is no transfer to cancel';
  end if;
  -- A return is the field engineer's to take back (rl_0047); a transfer, the desk's.
  if a.kind = 'return' and t.stakeholder_id is distinct from current_employee_id() then
    raise exception 'Only the field engineer who asked can cancel it';
  end if;
  if a.kind = 'transfer' and not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator of this Revive Lab can cancel the transfer';
  end if;
  if length(n) > 300 then raise exception 'Keep the note under 300 characters'; end if;

  update revive_approvals set status = 'cancelled', updated_at = now() where id = a.id;
  update revive_tickets set status = a.back_to, updated_at = now() where id = t.id;
  perform revive_step(t.id, a.back_to, t.status, t.trc_id, 'status', 'transfer_cancelled',
    concat_ws(' · ', 'Transfer to ' || (select name from revive_trcs where id = a.to_trc_id) || ' cancelled', n));
end $function$
;

CREATE OR REPLACE FUNCTION public.revive_can_see(p_ticket_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from revive_tickets t
    where t.id = p_ticket_id
      and (
        -- Whoever it belongs to: the field engineer, whoever wrote the card,
        -- the engineer repairing it, and the field engineer's managers.
        t.stakeholder_id = current_employee_id()
        or t.raised_by = current_employee_id()
        or t.engineer_id = current_employee_id()
        or is_in_my_downline(t.stakeholder_id)
        -- The managers of anyone who held it before a transfer (rl_0029):
        -- following only the one holding it now lost it for the first team.
        or exists (
          select 1 from revive_handovers h
          where h.ticket_id = t.id and h.status = 'accepted' and is_in_my_downline(h.from_id))
        -- The project head asked to approve it going to another state (rl_0047).
        or exists (select 1 from revive_approvals a where a.ticket_id = t.id and a.head_id = current_employee_id())
        -- Every Revive Lab admin, and the software administrator.
        or revive_is_admin()
        -- A Regional Revive Lab's manager sees every Revive Lab's work.
        or exists (
          select 1 from revive_members m
          join revive_member_trcs mt on mt.employee_id = m.employee_id
          join revive_trcs l on l.id = mt.trc_id
          where m.employee_id = current_employee_id() and m.is_manager and l.state is null)
        -- The desk of the Revive Lab that has it, or that sent it on — its manager and its observers too (rl_0039).
        or exists (
          select 1 from revive_members m
          join revive_member_trcs mt on mt.employee_id = m.employee_id
          where m.employee_id = current_employee_id()
            and (m.is_coordinator or m.is_manager or m.is_observer)
            and (mt.trc_id = t.trc_id
                 or mt.trc_id in (select x.from_trc_id from revive_transfers x where x.ticket_id = t.id)))
        -- Purchase, where a purchase request brought it to them.
        or exists (
          select 1 from revive_part_requests r
          join revive_member_trcs mt on mt.trc_id = r.trc_id
          join revive_members m on m.employee_id = mt.employee_id
          where r.ticket_id = t.id and r.route = 'purchase'
            and m.employee_id = current_employee_id() and m.is_purchase)
        -- The field engineer asked to take it over, while they decide (rl_0028).
        or exists (
          select 1 from revive_handovers h
          where h.ticket_id = t.id and h.status = 'pending' and h.to_id = current_employee_id())
      )
  )
$function$
;

CREATE OR REPLACE FUNCTION public.revive_has_access()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select is_sw_admin()
      or exists (select 1 from revive_members m where m.employee_id = current_employee_id())
      -- A BEMMP's project head (rl_0047).
      or exists (select 1 from revive_bemmp_projects b where b.head_id = current_employee_id())
      or exists (select 1 from employee_modules em
                 where em.employee_id = current_employee_id() and em.module_code = 'revive')
$function$
;

CREATE OR REPLACE FUNCTION public.revive_ticket_list()
 RETURNS TABLE(id uuid, number integer, code text, status text, trc_kind text, trc_id uuid, trc_name text, source_ticket_no text, facility text, district text, state text, bemmp_id uuid, bemmp_code text, billing_spare boolean, equipment_name text, equipment_barcode text, spare_name text, items jsonb, issue text, return_address text, contact_number text, in_courier text, in_awb text, in_dispatched_on date, stakeholder_id uuid, stakeholder_name text, stakeholder_ecode text, stakeholder_function text, stakeholder_manager_name text, raised_by uuid, raised_by_name text, raised_by_function text, raised_as text, engineer_id uuid, engineer_name text, engineer_ecode text, out_courier text, out_awb text, out_dispatched_on date, created_at timestamp with time zone, updated_at timestamp with time zone, closed_at timestamp with time zone, outcome text, closure text, scrapped_at timestamp with time zone, scrapped_by_name text, expected_by date, parts jsonb, proposal text, trc_state text, approval jsonb, arrival_damaged boolean, arrival_photos text[], done_photos text[], done_video text, return_damaged boolean, return_photos text[], final_working boolean, received_at timestamp with time zone, stock jsonb, equipment_make text, equipment_model text, done_voice text, source text, warehouse_id uuid, spare_category text, criticality text, contract_type text, accepted_at timestamp with time zone, dispatched_at timestamp with time zone, billing_estimate numeric, asks_billing_estimate boolean, field_returns jsonb, handover jsonb, repaired_at timestamp with time zone, oem_address text, nr_approved_at timestamp with time zone, nr_approved_by_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select t.id, t.number, t.code, t.status,
         t.trc_kind, t.trc_id, trc.name,
         t.source_ticket_no, t.facility, t.district, t.state,
         t.bemmp_id, bp.code, t.billing_spare,
         t.equipment_name, t.equipment_barcode, t.spare_name, t.items,
         t.issue, t.return_address, t.contact_number,
         t.in_courier, t.in_awb, t.in_dispatched_on,
         t.stakeholder_id, sh.full_name, sh.ecode,
         sh.function_name,
         shm.full_name,
         t.raised_by, rb.full_name, rb.function_name, t.raised_as,
         t.engineer_id, en.full_name, en.ecode,
         t.out_courier, t.out_awb, t.out_dispatched_on,
         t.created_at, t.updated_at, t.closed_at,
         t.outcome, t.closure, t.scrapped_at, sc.full_name,
         t.expected_by,
         coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'route', r.route, 'status', r.status)
                                    order by r.requested_at)
                   from revive_part_requests r where r.ticket_id = t.id), '[]'::jsonb),
         t.proposal,
         trc.state,
         -- The latest approval asked for on this ticket, whatever became of it.
         (select jsonb_build_object(
                   'id', a.id, 'kind', a.kind, 'status', a.status,
                   'from_trc_id', a.from_trc_id, 'from_trc_name', f.name,
                   'asked_trc_id', a.asked_trc_id, 'asked_trc_name', ak.name,
                   'to_trc_id', a.to_trc_id, 'to_trc_name', d.name, 'to_trc_state', d.state,
                   'reason', a.reason, 'back_to', a.back_to,
                   'requested_by_name', rq.full_name, 'requested_at', a.requested_at,
                   'decided_by_name', dc.full_name, 'decided_at', a.decided_at,
                   'decision_note', a.decision_note,
                   -- The project head, first, for another state's Revive Lab (rl_0047).
                   'head_id', a.head_id, 'head_name', hd.full_name,
                   'head_decided_at', a.head_decided_at, 'head_note', a.head_note)
            from revive_approvals a
            left join revive_trcs f on f.id = a.from_trc_id
            join revive_trcs ak on ak.id = a.asked_trc_id
            join revive_trcs d on d.id = a.to_trc_id
            join employees rq on rq.id = a.requested_by
            left join employees dc on dc.id = a.decided_by
            left join employees hd on hd.id = a.head_id
           where a.ticket_id = t.id
           order by a.requested_at desc
           limit 1),
         t.arrival_damaged, t.arrival_photos, t.done_photos, t.done_video,
         t.return_damaged, t.return_photos, t.final_working, t.received_at,
         -- What the engineer has taken from stock, and where each stands (rl_0016).
         coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'status', u.status) order by u.requested_at)
                   from revive_stock_uses u where u.ticket_id = t.id), '[]'::jsonb),
         t.equipment_make, t.equipment_model, t.done_voice,
         t.source, t.warehouse_id,
         t.spare_category, t.criticality, t.contract_type, t.accepted_at,
         -- The first dispatch back since it was accepted — this round's, once
         -- the field has sent it back (rl_0027).
         (select min(ev.at) from revive_ticket_events ev
           where ev.ticket_id = t.id and ev.kind = 'status' and ev.status = 'in_transit_return'
             and (t.accepted_at is null or ev.at >= t.accepted_at)),
         t.billing_estimate,
         coalesce(bp.asks_billing, false),
         t.field_returns,
         -- Its latest transfer to another field engineer, whatever became of it (rl_0028).
         (select jsonb_build_object(
                   'id', h.id, 'status', h.status,
                   'from_id', h.from_id, 'from_name', fe.full_name, 'from_ecode', fe.ecode,
                   'to_id', h.to_id, 'to_name', te.full_name, 'to_ecode', te.ecode,
                   'phone', h.phone, 'requested_at', h.requested_at, 'decided_at', h.decided_at)
            from revive_handovers h
            join employees fe on fe.id = h.from_id
            join employees te on te.id = h.to_id
           where h.ticket_id = t.id
           order by h.requested_at desc, (h.status = 'pending') desc, (h.status = 'accepted') desc
           limit 1),
         -- The end of the category TAT (rl_0030): this round's close of the
         -- repair, once it has left repair — a spare sent on to another
         -- Revive Lab after "not repairable" is being repaired again.
         case when t.status in ('repaired', 'not_repairable', 'service_denied', 'in_transit_return', 'received_back', 'closed')
              then (select max(ev.at) from revive_ticket_events ev
                     where ev.ticket_id = t.id and ev.kind = 'status'
                       and ev.status in ('repaired', 'not_repairable', 'service_denied')
                       and (t.accepted_at is null or ev.at >= t.accepted_at))
         end,
         -- Where it went, when it went to the OEM (rl_0033).
         t.oem_address,
         -- Not repairable, approved by a Revive Lab manager (rl_0034).
         t.nr_approved_at, nra.full_name
  from revive_tickets t
  join revive_trcs trc on trc.id = t.trc_id
  left join revive_bemmp_projects bp on bp.id = t.bemmp_id
  join employees sh on sh.id = t.stakeholder_id
  left join employees shm on shm.id = sh.reporting_manager_id
  join employees rb on rb.id = t.raised_by
  left join employees en on en.id = t.engineer_id
  left join employees sc on sc.id = t.scrapped_by
  left join employees nra on nra.id = t.nr_approved_by
  where revive_can_see(t.id)
  order by t.number desc
$function$
;

CREATE OR REPLACE FUNCTION public.revive_return_to_lab(p_ticket_id uuid, p_reason text, p_courier text, p_awb text, p_dispatched_on date, p_photos text[] DEFAULT NULL::text[], p_video text DEFAULT NULL::text, p_voice text DEFAULT NULL::text, p_trc_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t     revive_tickets := revive_lock(p_ticket_id);
  lab   revive_trcs;
  who   text;
  why   text := btrim(coalesce(p_reason, ''));
  c     text := nullif(btrim(coalesce(p_courier, '')), '');
  w     text := nullif(btrim(coalesce(p_awb, '')), '');
  shots text[] := coalesce(p_photos, '{}');
  vid   text := nullif(btrim(coalesce(p_video, '')), '');
  voc   text := nullif(btrim(coalesce(p_voice, '')), '');
  -- The round this return starts: its files carry it, resend-1-r2 and so on.
  nxt   text := '-r' || (jsonb_array_length(t.field_returns) + 2) || '\.[a-z0-9]+$';
  path  text;
begin
  if t.stakeholder_id is distinct from current_employee_id() then
    raise exception 'Only the field engineer it was sent back to can return it';
  end if;
  if t.status <> 'received_back' then
    raise exception 'Confirm the spare arrived before sending it back';
  end if;
  if length(why) < 5 then
    raise exception 'Say why it is going back — what is not working';
  end if;
  if length(why) > 500 then
    raise exception 'Keep the reason under 500 characters';
  end if;
  -- As when it was first sent: a photograph of it at least (rl_0030).
  if coalesce(array_length(shots, 1), 0) = 0 then
    raise exception 'Add a photo of the spare — one at least';
  end if;
  if array_length(shots, 1) > 2 then
    raise exception 'Two photographs, at most';
  end if;
  foreach path in array shots loop
    if not revive_file_ok(t.id, path, 'resend') or path !~ nxt then
      raise exception 'That is not a photograph of this spare going back';
    end if;
  end loop;
  if vid is not null and (not revive_file_ok(t.id, vid, 'resend_video') or vid !~ nxt) then
    raise exception 'That is not a video of this spare going back';
  end if;
  if voc is not null and (not revive_file_ok(t.id, voc, 'resend_voice') or voc !~ nxt) then
    raise exception 'That is not a voice note on this spare going back';
  end if;
  if c is null then raise exception 'Enter the courier it is going back with'; end if;
  if w is null then raise exception 'Enter the tracking / AWB number'; end if;
  if p_dispatched_on is null then raise exception 'Enter the date of dispatch'; end if;
  if length(c) > 80 or length(w) > 80 then
    raise exception 'Keep the courier and the tracking number under 80 characters';
  end if;
  -- A day's grace: current_date is the database's, and India is ahead of it.
  if p_dispatched_on > current_date + 1 then
    raise exception 'The date of dispatch cannot be in the future';
  end if;
  -- The same Revive Lab, or another one (rl_0046): the state's own and the Regional
  -- ones, as on the route card. Back to where it was is always allowed.
  select * into lab from revive_trcs where id = coalesce(p_trc_id, t.trc_id);
  if lab.id is null then raise exception 'Choose the Revive Lab it is going to'; end if;
  if not lab.is_active then
    raise exception '% is no longer taking tickets — choose another Revive Lab', lab.name;
  end if;
  -- Another state's Revive Lab once it is approved (rl_0047).
  if lab.id <> t.trc_id and lab.state is not null and lab.state is distinct from t.state
     and not exists (select 1 from revive_approvals a where a.ticket_id = t.id and a.kind = 'return'
                       and a.status = 'approved' and a.to_trc_id = lab.id) then
    raise exception '% is in another state — ask for approval to send it there first', lab.name;
  end if;
  select full_name into who from employees where id = t.stakeholder_id;

  update revive_tickets
     set field_returns = field_returns || jsonb_build_array(jsonb_build_object(
           'at', now(), 'by', t.stakeholder_id, 'by_name', who, 'trc_name', lab.name,
           'reason', why, 'courier', c, 'awb', w, 'dispatched_on', p_dispatched_on,
           -- What it looked like going back (rl_0030).
           'photos', to_jsonb(shots), 'video', vid, 'voice', voc,
           -- The round that ended, all of it: the ticket's own fields start the next one.
           'before', jsonb_build_object(
             'in_courier', t.in_courier, 'in_awb', t.in_awb, 'in_dispatched_on', t.in_dispatched_on,
             'accepted_at', t.accepted_at, 'trc_id', t.trc_id,
             'trc_name_before', (select x.name from revive_trcs x where x.id = t.trc_id),
             'spare_category', t.spare_category, 'criticality', t.criticality,
             'arrival_damaged', t.arrival_damaged, 'arrival_photos', to_jsonb(t.arrival_photos),
             'engineer_id', t.engineer_id,
             'engineer_name', (select e.full_name from employees e where e.id = t.engineer_id),
             'engineer_ecode', (select e.ecode from employees e where e.id = t.engineer_id),
             'expected_by', t.expected_by,
             'outcome', t.outcome, 'proposal', t.proposal,
             'done_photos', to_jsonb(t.done_photos), 'done_video', t.done_video, 'done_voice', t.done_voice,
             'out_courier', t.out_courier, 'out_awb', t.out_awb, 'out_dispatched_on', t.out_dispatched_on,
             -- When the repair was closed: that round's category TAT ended there (rl_0030).
             'repaired_at', (select max(ev.at) from revive_ticket_events ev
                              where ev.ticket_id = t.id and ev.kind = 'status'
                                and ev.status in ('repaired', 'not_repairable', 'service_denied')
                                and (t.accepted_at is null or ev.at >= t.accepted_at)),
             -- When it went back.
             'dispatched_at', (select min(ev.at) from revive_ticket_events ev
                                where ev.ticket_id = t.id and ev.kind = 'status' and ev.status = 'in_transit_return'
                                  and (t.accepted_at is null or ev.at >= t.accepted_at)),
             'billing_estimate', t.billing_estimate,
             'received_at', t.received_at, 'return_damaged', t.return_damaged,
             'return_photos', to_jsonb(t.return_photos)))),
         status = 'pending_acceptance',
         trc_id = lab.id, trc_kind = lab.kind,
         in_courier = c, in_awb = w, in_dispatched_on = p_dispatched_on,
         -- A new round: its TAT starts when it is accepted again, any engineer may have it.
         accepted_at = null, engineer_id = null, expected_by = null,
         outcome = null, proposal = null, closure = null,
         arrival_damaged = false, arrival_photos = '{}',
         done_photos = '{}', done_video = null, done_voice = null,
         out_courier = null, out_awb = null, out_dispatched_on = null,
         billing_estimate = null,
         received_at = null, return_damaged = false, return_photos = '{}',
         updated_at = now()
   where id = t.id;
  update revive_approvals
     set status = case when to_trc_id = lab.id then 'sent' else 'cancelled' end, updated_at = now()
   where ticket_id = t.id and kind = 'return' and status = 'approved';
  perform revive_step(t.id, 'pending_acceptance', t.status, lab.id, 'status', 'field_return',
    case when lab.id <> t.trc_id then 'To ' || lab.name || E'\n' else '' end || why || E'\n' || concat_ws(' · ', c, 'AWB ' || w, 'dispatched ' || to_char(p_dispatched_on, 'FMDD Mon YYYY')));
end $function$
;

notify pgrst, 'reload schema';
