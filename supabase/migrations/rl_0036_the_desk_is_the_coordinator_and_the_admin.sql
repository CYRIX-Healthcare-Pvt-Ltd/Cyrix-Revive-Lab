/*
  rl_0036 — the desk is the coordinator and the admin; a manager approves.

  The user, 1 Oct, of Joseph P V — Revive Lab Engineer and Manager, not
  Coordinator — on a not-repairable spare he had approved: "why after
  approving manager has dispatch option? only coordinator should have it,
  after approval it should pass to coordinator". Asked whether the desk's
  other moves should leave the manager too — accepting a spare, assigning
  an engineer, a transfer, the category, the components: "yes coordinator
  and admin only".

  revive_runs_trc was "a coordinator or a manager of that Revive Lab". It
  is now "a coordinator of that Revive Lab, or a Revive Lab admin" — as
  adding to the stock already allowed an admin. Every function that asks it
  follows: accept, assign, transfer, send, dispatch, scrap, category and
  criticality, component requests, stock uses and the stock itself, and the
  arrival photographs' storage policy.

  A manager approves a spare as not repairable, or sends it back to be
  repaired (revive_manages_trc, rl_0034), and still sees the Revive Lab's
  tickets (revive_can_see is as it was). Somebody who is to do both is
  ticked Coordinator as well as Manager.

  Raising a ticket at the Revive Lab is the desk's too: a manager, like an
  engineer and Purchase, raises one only with a desk role.

  The functions below are as they were, word for word, but for the refusal
  that named "a coordinator or manager" — and, in revive_raise_ticket, who
  is refused.
*/

/** The desk of this Revive Lab: one of its coordinators, or a Revive Lab admin. */
create or replace function public.revive_runs_trc(p_trc_id uuid)
returns boolean
language sql stable security definer set search_path to 'public'
as $fn$
  select revive_is_admin() or exists (
    select 1 from revive_members m
    join revive_member_trcs mt on mt.employee_id = m.employee_id
    where m.employee_id = current_employee_id()
      and mt.trc_id = p_trc_id
      and m.is_coordinator
  )
$fn$;

CREATE OR REPLACE FUNCTION public.revive_accept(p_ticket_id uuid, p_note text DEFAULT NULL::text, p_damaged boolean DEFAULT false, p_photos text[] DEFAULT NULL::text[], p_courier text DEFAULT NULL::text, p_awb text DEFAULT NULL::text, p_dispatched_on date DEFAULT NULL::date, p_category text DEFAULT NULL::text, p_criticality text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t      revive_tickets := revive_lock(p_ticket_id);
  photos text[] := coalesce(p_photos, '{}');
  path   text;
  c      text := coalesce(nullif(btrim(coalesce(p_courier, '')), ''), t.in_courier);
  w      text := coalesce(nullif(btrim(coalesce(p_awb, '')), ''), t.in_awb);
  d      date := coalesce(p_dispatched_on, t.in_dispatched_on);
  cat    text := coalesce(upper(nullif(btrim(coalesce(p_category, '')), '')), t.spare_category);
  crit   text := coalesce(nullif(btrim(coalesce(p_criticality, '')), ''), t.criticality);
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator of this Revive Lab can accept it';
  end if;
  if t.status not in ('pending_acceptance', 'transferred') then
    raise exception 'This ticket is not waiting to be accepted';
  end if;
  if array_length(photos, 1) > 2 then
    raise exception 'Two photographs of the spare as it arrived, at most';
  end if;
  foreach path in array photos loop
    if not revive_file_ok(t.id, path, 'arrival') then
      raise exception 'That is not a photograph of this spare arriving';
    end if;
  end loop;
  -- The one thing a damaged spare needs is the picture of it.
  if coalesce(p_damaged, false) and coalesce(array_length(photos, 1), 0) = 0 then
    raise exception 'Photograph the damage — it is the only proof there will be';
  end if;

  -- How it came, from the consignment note in the coordinator's hand. A
  -- transfer's courier was recorded when the other Revive Lab sent it.
  if t.status = 'pending_acceptance' then
    if c is null then raise exception 'Enter the courier it came with'; end if;
    if w is null then raise exception 'Enter the tracking / AWB number'; end if;
    if d is null then raise exception 'Enter the date of dispatch'; end if;
  end if;
  if length(c) > 80 or length(w) > 80 then
    raise exception 'Keep the courier and the tracking number under 80 characters';
  end if;
  if d > current_date + 1 then
    raise exception 'The date of dispatch cannot be in the future';
  end if;

  -- What it is: the category sets its TAT, and a CAMC spare is critical.
  if cat is null or cat not in ('A', 'B', 'C') then
    raise exception 'Choose the spare category — A, B or C';
  end if;
  if t.contract_type = 'CAMC' then
    if p_criticality = 'non_critical' then
      raise exception 'A CAMC spare is always critical';
    end if;
    crit := 'critical';
  end if;
  if crit is null or crit not in ('critical', 'non_critical') then
    raise exception 'Choose whether the spare is critical or non-critical';
  end if;

  update revive_tickets
     set status = 'accepted',
         arrival_damaged = coalesce(p_damaged, false),
         arrival_photos = photos,
         in_courier = c,
         in_awb = w,
         in_dispatched_on = d,
         spare_category = cat,
         criticality = crit,
         accepted_at = coalesce(accepted_at, now()),
         updated_at = now()
   where id = t.id;
  perform revive_step(t.id, 'accepted', t.status, t.trc_id, 'status',
    case when coalesce(p_damaged, false) then 'damaged' end,
    concat_ws(' · ',
      'Category ' || cat,
      revive_crit_label(crit),
      case when coalesce(p_damaged, false) then 'Damaged in transit' end,
      nullif(btrim(coalesce(p_note, '')), '')));
end $function$;

CREATE OR REPLACE FUNCTION public.revive_add_component(p_trc_id uuid, p_part_no text, p_value text, p_item text, p_package text, p_bin text, p_location text, p_qty integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me    uuid := current_employee_id();
  part  text := btrim(coalesce(p_part_no, ''));
  val   text := nullif(btrim(coalesce(p_value, '')), '');
  itm   text := nullif(btrim(coalesce(p_item, '')), '');
  taken revive_components;
  cur   revive_components;
begin
  if not (revive_runs_trc(p_trc_id) or revive_is_admin()) then
    raise exception 'Only a coordinator of this Revive Lab can add to its stock';
  end if;
  if part = '' then raise exception 'Enter the part number'; end if;
  if length(part) > 40 then raise exception 'A part number is at most 40 characters'; end if;
  if val is null and itm is null then raise exception 'Enter the value or the item'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'Enter how many there are — 0 or more'; end if;
  select * into taken from revive_components
   where trc_id = p_trc_id and lower(btrim(part_no)) = lower(part);
  if found then
    raise exception 'Part number % already exists — it is %', taken.part_no,
      coalesce(concat_ws(' · ', taken.value, taken.item), 'another part');
  end if;

  insert into revive_components (trc_id, part_no, value, item, package, bin, location, qty, updated_by)
  values (p_trc_id, part, left(val, 160), left(itm, 80),
          left(nullif(btrim(coalesce(p_package, '')), ''), 40),
          left(nullif(btrim(coalesce(p_bin, '')), ''), 40),
          left(nullif(btrim(coalesce(p_location, '')), ''), 40),
          p_qty, me)
  returning * into cur;
  insert into revive_component_moves (component_id, trc_id, kind, change, qty_after, actor_id)
  values (cur.id, p_trc_id, 'count', p_qty, p_qty, me);
  insert into revive_component_log (component_id, trc_id, actor_id, action, changes)
  values (cur.id, p_trc_id, me, 'added',
          revive_part_changes(null, null, null, null, null, null, null,
                              cur.part_no, cur.value, cur.item, cur.package, cur.bin, cur.location, cur.qty));
  perform log_audit('revive_stock', p_trc_id, 'added',
    jsonb_build_object('component_id', cur.id, 'part_no', part, 'qty', p_qty));
  return cur.id;
end $function$;

CREATE OR REPLACE FUNCTION public.revive_approve_use(p_use_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  u revive_stock_uses := revive_lock_use(p_use_id);
  c revive_components;
begin
  if not revive_runs_trc(u.trc_id) then
    raise exception 'Only a coordinator of this Revive Lab can approve what comes off its stock';
  end if;
  if u.status <> 'requested' then
    raise exception 'That has already been decided';
  end if;
  select * into c from revive_components where id = u.component_id for update;
  if u.qty > c.qty then
    raise exception 'Only % of % left in stock', c.qty, c.part_no;
  end if;

  update revive_components set qty = qty - u.qty, updated_at = now(), updated_by = current_employee_id()
   where id = c.id;
  insert into revive_component_moves (component_id, trc_id, ticket_id, kind, change, qty_after, actor_id)
  values (c.id, c.trc_id, u.ticket_id, 'use', -u.qty, c.qty - u.qty, current_employee_id());
  update revive_stock_uses
     set status = 'approved', decided_by = current_employee_id(), decided_at = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
   where id = u.id;
  perform revive_parts_step(u.ticket_id, 'stock_used',
    u.qty || ' × ' || coalesce(c.value, c.item, c.part_no) || ' (' || c.part_no || ')');
end $function$;

CREATE OR REPLACE FUNCTION public.revive_assign(p_ticket_id uuid, p_engineer_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t revive_tickets := revive_lock(p_ticket_id);
  eid bigint;
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator of this Revive Lab can assign it';
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
end $function$;

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
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator of this Revive Lab can cancel the transfer';
  end if;
  select * into a from revive_approvals
   where ticket_id = t.id and kind = 'transfer' and status in ('pending', 'approved') for update;
  if not found or t.status not in ('awaiting_approval', 'approved') then
    raise exception 'There is no transfer to cancel';
  end if;
  if length(n) > 300 then raise exception 'Keep the note under 300 characters'; end if;

  update revive_approvals set status = 'cancelled', updated_at = now() where id = a.id;
  update revive_tickets set status = a.back_to, updated_at = now() where id = t.id;
  perform revive_step(t.id, a.back_to, t.status, t.trc_id, 'status', 'transfer_cancelled',
    concat_ws(' · ', 'Transfer to ' || (select name from revive_trcs where id = a.to_trc_id) || ' cancelled', n));
end $function$;

CREATE OR REPLACE FUNCTION public.revive_decline_use(p_use_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  u revive_stock_uses := revive_lock_use(p_use_id);
  c revive_components;
  n text := btrim(coalesce(p_reason, ''));
begin
  if not revive_runs_trc(u.trc_id) then
    raise exception 'Only a coordinator of this Revive Lab can decide what comes off its stock';
  end if;
  if u.status <> 'requested' then
    raise exception 'That has already been decided';
  end if;
  if length(n) < 3 then raise exception 'Say why it is not approved'; end if;
  select * into c from revive_components where id = u.component_id;

  update revive_stock_uses
     set status = 'declined', decided_by = current_employee_id(), decided_at = now(),
         decision_note = n, updated_at = now()
   where id = u.id;
  perform revive_parts_step(u.ticket_id, 'stock_declined',
    u.qty || ' × ' || c.part_no || ' · ' || n);
end $function$;

CREATE OR REPLACE FUNCTION public.revive_dispatch(p_ticket_id uuid, p_courier text, p_awb text, p_dispatched_on date, p_note text DEFAULT NULL::text, p_billing_estimate numeric DEFAULT NULL::numeric, p_oem_address text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t     revive_tickets := revive_lock(p_ticket_id);
  asks  boolean := coalesce((select bp.asks_billing from revive_bemmp_projects bp where bp.id = t.bemmp_id), false);
  said  text;
  -- Not repairable, and the engineer proposed the OEM: it goes to the OEM's address (rl_0033).
  to_oem boolean := t.status = 'not_repairable' and t.proposal = 'oem';
  oem    text := nullif(btrim(coalesce(p_oem_address, '')), '');
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator of this Revive Lab can dispatch it';
  end if;
  if t.status not in ('repaired', 'not_repairable', 'service_denied') then
    raise exception 'Close the repair before dispatching it';
  end if;
  -- Not repairable waits for a Revive Lab manager's approval first (rl_0034).
  if t.status = 'not_repairable' and t.nr_approved_at is null then
    raise exception 'A Revive Lab manager has to approve it as not repairable first';
  end if;
  if t.status = 'not_repairable' and t.proposal = 'scrap' then
    raise exception 'The engineer proposed scrap — move it to scrap';
  end if;
  if to_oem and (oem is null or length(oem) < 5) then
    raise exception 'Enter the OEM''s name and address — where it is going';
  end if;
  if to_oem and length(oem) > 500 then
    raise exception 'Keep the OEM''s address under 500 characters';
  end if;
  if length(btrim(coalesce(p_courier, ''))) < 2 then
    raise exception 'Enter the courier it is going back with';
  end if;
  if asks then
    if p_billing_estimate is null then
      raise exception 'Enter the estimated billing cost — under Pvt the customer can be asked to pay it';
    end if;
    if p_billing_estimate < 0 or p_billing_estimate > 10000000 then
      raise exception 'The estimated billing cost should be between ₹0 and ₹1,00,00,000';
    end if;
    said := 'Estimated billing ₹' || regexp_replace(to_char(round(p_billing_estimate, 2), 'FM9999999990.00'), '\.00$', '');
  end if;

  update revive_tickets
  set status = 'in_transit_return',
      closure = 'returned',
      out_courier = btrim(p_courier),
      out_awb = nullif(btrim(coalesce(p_awb, '')), ''),
      out_dispatched_on = coalesce(p_dispatched_on, current_date),
      billing_estimate = case when asks then round(p_billing_estimate, 2) else billing_estimate end,
      oem_address = case when to_oem then oem else oem_address end,
      updated_at = now()
  where id = t.id;
  perform revive_log(t.id, 'in_transit_return', t.status, t.trc_id,
    concat_ws(' · ', case when to_oem then 'To the OEM: ' || oem end, said, nullif(btrim(coalesce(p_note, '')), '')));
end $function$;

CREATE OR REPLACE FUNCTION public.revive_edit_component(p_component_id uuid, p_part_no text, p_value text, p_item text, p_package text, p_bin text, p_location text, p_qty integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me    uuid := current_employee_id();
  part  text := btrim(coalesce(p_part_no, ''));
  val   text := nullif(btrim(coalesce(p_value, '')), '');
  itm   text := nullif(btrim(coalesce(p_item, '')), '');
  cur   revive_components;
  now_  revive_components;
  taken revive_components;
  chg   jsonb;
begin
  select * into cur from revive_components where id = p_component_id for update;
  if not found then raise exception 'That part is no longer in the stock'; end if;
  if not (revive_runs_trc(cur.trc_id) or revive_is_admin()) then
    raise exception 'Only a coordinator of this Revive Lab can change its stock';
  end if;
  if part = '' then raise exception 'Enter the part number'; end if;
  if length(part) > 40 then raise exception 'A part number is at most 40 characters'; end if;
  if val is null and itm is null then raise exception 'Enter the value or the item'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'Enter how many there are — 0 or more'; end if;
  select * into taken from revive_components
   where trc_id = cur.trc_id and lower(btrim(part_no)) = lower(part) and id <> cur.id;
  if found then
    raise exception 'Part number % already exists — it is %', taken.part_no,
      coalesce(concat_ws(' · ', taken.value, taken.item), 'another part');
  end if;

  update revive_components
     set part_no = part, value = left(val, 160), item = left(itm, 80),
         package = left(nullif(btrim(coalesce(p_package, '')), ''), 40),
         bin = left(nullif(btrim(coalesce(p_bin, '')), ''), 40),
         location = left(nullif(btrim(coalesce(p_location, '')), ''), 40),
         qty = p_qty, updated_at = now(), updated_by = me
   where id = cur.id
  returning * into now_;
  if cur.qty <> p_qty then
    insert into revive_component_moves (component_id, trc_id, kind, change, qty_after, actor_id)
    values (cur.id, cur.trc_id, 'count', p_qty - cur.qty, p_qty, me);
  end if;
  chg := revive_part_changes(cur.part_no, cur.value, cur.item, cur.package, cur.bin, cur.location, cur.qty,
                             now_.part_no, now_.value, now_.item, now_.package, now_.bin, now_.location, now_.qty);
  -- Saved with nothing changed says nothing.
  if chg <> '{}'::jsonb then
    insert into revive_component_log (component_id, trc_id, actor_id, action, changes)
    values (cur.id, cur.trc_id, me, 'edited', chg);
  end if;
  perform log_audit('revive_stock', cur.trc_id, 'edited',
    jsonb_build_object('component_id', cur.id,
      'before', jsonb_build_object('part_no', cur.part_no, 'value', cur.value, 'item', cur.item, 'package', cur.package,
                                   'bin', cur.bin, 'location', cur.location, 'qty', cur.qty)));
end $function$;

CREATE OR REPLACE FUNCTION public.revive_forward_part(p_request_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r revive_part_requests := revive_lock_part(p_request_id);
begin
  if not revive_runs_trc(r.trc_id) then
    raise exception 'Only the Revive Lab''s coordinator passes a request to Purchase';
  end if;
  if r.status <> 'requested' then
    raise exception 'This request is not with you';
  end if;
  if not exists (
    select 1 from revive_members m join revive_member_trcs mt on mt.employee_id = m.employee_id
    where m.is_purchase and mt.trc_id = r.trc_id) then
    raise exception 'Nobody holds Purchase for this Revive Lab yet — ask an admin, or purchase it locally';
  end if;

  update revive_part_requests
     set route = 'purchase', status = 'forwarded', updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, 'forwarded',
    concat_ws(' · ', revive_part_label(r) || ' — passed to Purchase', nullif(btrim(coalesce(p_note, '')), '')));
end $function$;

CREATE OR REPLACE FUNCTION public.revive_make_local(p_request_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r revive_part_requests := revive_lock_part(p_request_id);
begin
  if not revive_runs_trc(r.trc_id) then
    raise exception 'Only the Revive Lab''s coordinator can purchase it locally';
  end if;
  if r.status not in ('requested', 'forwarded') then
    raise exception 'It is already being purchased';
  end if;

  update revive_part_requests
     set route = 'local', status = 'accepted', accepted_by = current_employee_id(),
         accepted_at = now(), updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, 'made_local',
    concat_ws(' · ', revive_part_label(r) || ' — purchased locally', nullif(btrim(coalesce(p_note, '')), '')));
end $function$;

CREATE OR REPLACE FUNCTION public.revive_raise_ticket(p_trc_id uuid, p_hospital text, p_state text, p_bemmp_id uuid, p_district text, p_source_ticket_no text, p_equipment_name text, p_equipment_barcode text, p_spare_name text, p_issue text, p_return_address text, p_contact_number text, p_in_courier text, p_in_awb text, p_in_dispatched_on date, p_stakeholder_id uuid DEFAULT NULL::uuid, p_items jsonb DEFAULT NULL::jsonb, p_billing_spare boolean DEFAULT NULL::boolean, p_approval_reason text DEFAULT NULL::text, p_equipment_make text DEFAULT NULL::text, p_equipment_model text DEFAULT NULL::text, p_source text DEFAULT 'hospital'::text, p_warehouse_id uuid DEFAULT NULL::uuid, p_contract_type text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_criticality text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me        uuid := current_employee_id();
  trc       revive_trcs;
  bemmp     revive_bemmp_projects;
  wh        revive_warehouses;
  src       text := coalesce(nullif(btrim(coalesce(p_source, '')), ''), 'hospital');
  st        text := btrim(coalesce(p_state, ''));
  why       text := btrim(coalesce(p_approval_reason, ''));
  make      text := nullif(btrim(coalesce(p_equipment_make, '')), '');
  model     text := nullif(btrim(coalesce(p_equipment_model, '')), '');
  contract  text := upper(nullif(btrim(coalesce(p_contract_type, '')), ''));
  cat       text := upper(nullif(btrim(coalesce(p_category, '')), ''));
  crit      text := nullif(btrim(coalesce(p_criticality, '')), '');
  as_co     boolean;
  far       boolean;
  holder    uuid;
  t         revive_tickets;
  clean     text;
  entries   jsonb := '[]'::jsonb;
  entry     jsonb;
  item_kind text;
  item_name text;
begin
  if me is null then raise exception 'Only a signed-in employee can raise a ticket'; end if;
  if not revive_has_access() then
    raise exception 'Revive Lab has not been given to you yet — ask the software administrator';
  end if;
  -- Whoever sends spares in raises them: the field, or a Revive Lab's desk.
  -- Its engineers repair what arrives, its manager approves, and Purchase buys for it (rl_0019, rl_0036).
  if not is_sw_admin() and exists (
       select 1 from revive_members m
        where m.employee_id = me and (m.is_engineer or m.is_purchase or m.is_manager)
          and not (m.is_coordinator or m.is_admin)) then
    raise exception 'Tickets are raised by the field engineer or a Revive Lab coordinator — not by a Revive Lab engineer, manager or Purchase';
  end if;
  if src not in ('hospital', 'warehouse') then
    raise exception 'A spare comes from a hospital or a warehouse';
  end if;

  select * into trc from revive_trcs where id = p_trc_id and is_active;
  if not found then raise exception 'Choose the Revive Lab the spare is going to'; end if;
  as_co := revive_runs_trc(p_trc_id);

  if length(st) < 2 then
    raise exception 'Choose the state';
  end if;
  -- The desk raises at a Revive Lab of its own for that state: the state's own, or a Regional one.
  if as_co and trc.state is not null and trc.state <> st then
    raise exception '% serves %, not % — choose a Revive Lab for %, or a Regional one', trc.name, trc.state, st, st;
  end if;

  if src = 'warehouse' then
    -- A warehouse's defective spare arrives at the Revive Lab; its desk writes the card.
    if not as_co then
      raise exception 'Only a Revive Lab coordinator raises a ticket for a spare from a warehouse';
    end if;
    select * into wh from revive_warehouses where id = p_warehouse_id and is_active;
    if not found then raise exception 'Choose the warehouse'; end if;
    if wh.state is not null and wh.state <> st then
      raise exception '% is in %, not %', wh.name, wh.state, st;
    end if;
    contract := null;
  else
    select * into bemmp from revive_bemmp_projects where id = p_bemmp_id and is_active;
    if not found then
      raise exception 'Choose the BEMMP';
    end if;
    if bemmp.state is not null and bemmp.state <> st then
      raise exception 'BEMMP % is for % — choose a BEMMP for %', bemmp.code, bemmp.state, st;
    end if;
    if length(btrim(coalesce(p_district, ''))) < 2 then
      raise exception 'Choose the district';
    end if;
    if length(btrim(coalesce(p_hospital, ''))) < 2 then
      raise exception 'Enter the hospital the spare came from';
    end if;
    -- A private contract says which: AMC, or CAMC (rl_0024).
    if bemmp.asks_contract then
      if contract is null or contract not in ('AMC', 'CAMC') then
        raise exception 'Choose the contract type — AMC or CAMC';
      end if;
    else
      contract := null;
    end if;
  end if;
  if length(coalesce(make, '')) > 80 or length(coalesce(model, '')) > 80 then
    raise exception 'Keep the make and the model under 80 characters';
  end if;

  -- A CAMC spare is critical, whoever raises it.
  if contract = 'CAMC' then
    if crit = 'non_critical' then
      raise exception 'A CAMC spare is always critical';
    end if;
    crit := 'critical';
  end if;
  -- The desk's raise is its acceptance (rl_0023), so it says what the spare is now.
  if as_co then
    if cat is null or cat not in ('A', 'B', 'C') then
      raise exception 'Choose the spare category — A, B or C';
    end if;
    if crit is null or crit not in ('critical', 'non_critical') then
      raise exception 'Choose whether the spare is critical or non-critical';
    end if;
  else
    -- The field does not classify it: the Revive Lab does, on arrival.
    cat := null;
    if contract is distinct from 'CAMC' then crit := null; end if;
  end if;

  /*
    The list. Without one — an app from before rl_0011 — the spare name is
    the whole list. A line left blank is skipped rather than refused: it is
    an empty row, not a mistake.
  */
  if p_items is null then
    if length(btrim(coalesce(p_spare_name, ''))) < 2 then
      raise exception 'Enter the spare''s name';
    end if;
    entries := jsonb_build_array(jsonb_build_object('kind', 'spare', 'name', btrim(p_spare_name)));
  else
    if jsonb_typeof(p_items) <> 'array' then
      raise exception 'List the spares and accessories';
    end if;
    for entry in select value from jsonb_array_elements(p_items) loop
      item_kind := entry->>'kind';
      item_name := btrim(coalesce(entry->>'name', ''));
      continue when item_name = '';
      if item_kind is null or item_kind not in ('spare', 'accessory', 'full_machine') then
        raise exception 'Each line is a spare, an accessory or a full machine';
      end if;
      if length(item_name) < 2 then
        raise exception 'Enter the name of each spare and accessory';
      end if;
      if length(item_name) > 120 then
        raise exception 'Keep each name under 120 characters';
      end if;
      entries := entries || jsonb_build_array(jsonb_build_object('kind', item_kind, 'name', item_name));
    end loop;
    if jsonb_array_length(entries) = 0 then
      raise exception 'Enter the spare''s name';
    end if;
    if jsonb_array_length(entries) > 10 then
      raise exception 'A ticket carries at most 10 spares and accessories';
    end if;
  end if;

  if length(btrim(coalesce(p_issue, ''))) < 3 then
    raise exception 'Describe the issue identified';
  end if;
  if length(btrim(coalesce(p_return_address, ''))) < 5 then
    raise exception 'Enter the address the spare should be returned to';
  end if;
  clean := nullif(regexp_replace(coalesce(p_contact_number, ''), '[^0-9+]', '', 'g'), '');
  if clean is not null and length(clean) not between 7 and 15 then
    raise exception 'That contact number does not look right';
  end if;

  holder := coalesce(p_stakeholder_id, me);

  if as_co and p_stakeholder_id is null then
    raise exception '%', case when src = 'warehouse'
      then 'Name the warehouse in-charge this spare belongs to, so they and their manager can follow it'
      else 'Name the field engineer this spare belongs to, so they and their manager can follow it' end;
  end if;
  if not as_co and holder <> me then
    raise exception 'Only the Revive Lab''s coordinator can raise a ticket on somebody else''s behalf';
  end if;
  if not exists (select 1 from employees where id = holder and is_active) then
    raise exception '%', case when src = 'warehouse'
      then 'That warehouse in-charge is not an active employee'
      else 'That field engineer is not an active employee' end;
  end if;

  /*
    Another state's Revive Lab. A field engineer is offered their own
    state's and the Regional ones; any other is asked for, with a reason,
    and waits for the Regional Revive Lab admins.
  */
  far := not as_co and trc.state is not null and trc.state <> st;
  if far and length(why) < 5 then
    raise exception '% is not a Revive Lab for % — say why it should go there, and the Regional Revive Lab admins approve it first', trc.name, st;
  end if;
  if far and length(why) > 500 then
    raise exception 'Keep the reason under 500 characters';
  end if;

  insert into revive_tickets (
    status, trc_kind, trc_id, source, warehouse_id, facility, state, bemmp_id, billing_spare, district,
    source_ticket_no, equipment_name, equipment_make, equipment_model, equipment_barcode, spare_name, items,
    issue, return_address, contact_number, in_courier, in_awb, in_dispatched_on,
    stakeholder_id, raised_by, raised_as, contract_type, spare_category, criticality, accepted_at)
  values (
    case when far then 'awaiting_approval' when as_co then 'accepted' else 'pending_acceptance' end,
    trc.kind, trc.id,
    src,
    case when src = 'warehouse' then wh.id end,
    case when src = 'warehouse' then wh.name else btrim(p_hospital) end,
    st,
    case when src = 'hospital' then p_bemmp_id end,
    case when src = 'hospital' and bemmp.asks_billing then coalesce(p_billing_spare, false) end,
    case when src = 'hospital' then btrim(p_district) end,
    case when src = 'hospital' then nullif(btrim(coalesce(p_source_ticket_no, '')), '') end,
    nullif(btrim(coalesce(p_equipment_name, '')), ''),
    make,
    model,
    nullif(btrim(coalesce(p_equipment_barcode, '')), ''),
    entries->0->>'name',
    entries,
    btrim(p_issue),
    btrim(p_return_address),
    clean,
    nullif(btrim(coalesce(p_in_courier, '')), ''),
    nullif(btrim(coalesce(p_in_awb, '')), ''),
    p_in_dispatched_on,
    holder, me, case when as_co then 'coordinator' else 'engineer' end,
    contract, cat, crit,
    case when as_co then now() end)
  returning * into t;

  if far then
    insert into revive_approvals (ticket_id, kind, asked_trc_id, to_trc_id, reason, requested_by)
    values (t.id, 'raise', trc.id, trc.id, why, me);
    perform revive_step(t.id, 'awaiting_approval', null, t.trc_id, 'status', 'lab_requested',
      'For ' || trc.name || ': ' || why);
  else
    perform revive_log(t.id, 'pending_acceptance', null, t.trc_id,
      case when src = 'warehouse' then 'Raised at the Revive Lab — from ' || wh.name
           when as_co then 'Raised at the Revive Lab'
           else 'Raised from the field' end);
    -- Raised at the desk, the spare is already there: accepted as it is raised (rl_0023).
    if as_co then
      perform revive_log(t.id, 'accepted', 'pending_acceptance', t.trc_id,
        concat_ws(' · ', 'Accepted on arrival — raised at the Revive Lab', 'Category ' || cat, revive_crit_label(crit)));
    end if;
  end if;

  return jsonb_build_object('id', t.id, 'code', t.code, 'number', t.number, 'status', t.status);
end $function$;

CREATE OR REPLACE FUNCTION public.revive_request_transfer(p_ticket_id uuid, p_to_trc_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t    revive_tickets := revive_lock(p_ticket_id);
  dest revive_trcs;
  why  text := btrim(coalesce(p_reason, ''));
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator of this Revive Lab can transfer it';
  end if;
  if t.status not in ('accepted', 'assigned', 'in_repair') then
    raise exception 'Accept the ticket before transferring it, and transfer it before it is repaired';
  end if;
  select * into dest from revive_trcs where id = p_to_trc_id and is_active;
  if not found then raise exception 'Choose the Revive Lab it is going to'; end if;
  if dest.id = t.trc_id then raise exception 'It is already at that Revive Lab'; end if;
  if length(why) < 5 then raise exception 'Say why it is being transferred'; end if;
  if length(why) > 500 then raise exception 'Keep the reason under 500 characters'; end if;

  insert into revive_approvals (ticket_id, kind, from_trc_id, asked_trc_id, to_trc_id, reason, back_to, requested_by)
  values (t.id, 'transfer', t.trc_id, dest.id, dest.id, why, t.status, current_employee_id());
  -- The engineer keeps it: a transfer that is not approved carries on with them.
  update revive_tickets set status = 'awaiting_approval', updated_at = now() where id = t.id;
  perform revive_step(t.id, 'awaiting_approval', t.status, t.trc_id, 'status', 'transfer_requested',
    'To ' || dest.name || ': ' || why);
end $function$;

CREATE OR REPLACE FUNCTION public.revive_scrap(p_ticket_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator of this Revive Lab can move it to scrap';
  end if;
  if t.status <> 'not_repairable' then
    raise exception 'Only a spare closed as not repairable can be moved to scrap';
  end if;
  -- Not repairable waits for a Revive Lab manager's approval first (rl_0034).
  if t.status = 'not_repairable' and t.nr_approved_at is null then
    raise exception 'A Revive Lab manager has to approve it as not repairable first';
  end if;
  if t.proposal = 'return' then
    raise exception 'The engineer proposed sending it back to the field engineer — dispatch it back';
  end if;
  if t.proposal = 'oem' then
    raise exception 'The engineer proposed sending it to the OEM — dispatch it to the OEM';
  end if;
  update revive_tickets
     set status = 'closed', closure = 'scrapped', closed_at = now(),
         scrapped_at = now(), scrapped_by = current_employee_id(), updated_at = now()
   where id = t.id;
  perform revive_step(t.id, 'closed', t.status, t.trc_id, 'status', 'scrapped', p_note);
end $function$;

CREATE OR REPLACE FUNCTION public.revive_send(p_ticket_id uuid, p_courier text DEFAULT NULL::text, p_awb text DEFAULT NULL::text, p_dispatched_on date DEFAULT NULL::date, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t    revive_tickets := revive_lock(p_ticket_id);
  me   uuid := current_employee_id();
  a    revive_approvals;
  dest revive_trcs;
  c    text := nullif(btrim(coalesce(p_courier, '')), '');
  w    text := nullif(btrim(coalesce(p_awb, '')), '');
  n    text := nullif(btrim(coalesce(p_note, '')), '');
  hop  integer;
begin
  select * into a from revive_approvals where ticket_id = t.id and status = 'approved' for update;
  if not found or t.status <> 'approved' then
    raise exception 'This ticket has no approval waiting to be sent';
  end if;
  if a.kind = 'raise' and (me is null or (t.raised_by <> me and t.stakeholder_id <> me)) then
    raise exception 'Only whoever raised it can send it';
  end if;
  if a.kind = 'transfer' and not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator of this Revive Lab can send it';
  end if;
  select * into dest from revive_trcs where id = a.to_trc_id;
  if not dest.is_active then
    raise exception '% is no longer taking tickets — %', dest.name,
      case a.kind when 'raise' then 'discard this ticket and raise it again' else 'cancel the transfer and ask again' end;
  end if;
  if length(c) > 80 or length(w) > 80 then
    raise exception 'Keep the courier and the tracking number under 80 characters';
  end if;
  -- A day's grace: current_date is the database's, and India is ahead of it.
  if p_dispatched_on > current_date + 1 then
    raise exception 'The date of dispatch cannot be in the future';
  end if;
  if length(n) > 300 then raise exception 'Keep the note under 300 characters'; end if;

  if a.kind = 'raise' then
    update revive_tickets
       set status = 'pending_acceptance',
           in_courier = coalesce(c, in_courier),
           in_awb = coalesce(w, in_awb),
           in_dispatched_on = coalesce(p_dispatched_on, in_dispatched_on),
           updated_at = now()
     where id = t.id;
    update revive_approvals set status = 'sent', updated_at = now() where id = a.id;
    perform revive_step(t.id, 'pending_acceptance', t.status, t.trc_id, 'status', 'sent',
      concat_ws(' · ', 'Sent to ' || dest.name, n));
  else
    select coalesce(max(x.hop), 0) + 1 into hop from revive_transfers x where x.ticket_id = t.id;
    insert into revive_transfers (
      ticket_id, hop, from_trc_id, to_trc_id, courier, awb, dispatched_on, reason, transferred_by)
    values (t.id, hop, t.trc_id, dest.id, c, w, coalesce(p_dispatched_on, current_date), a.reason, me);
    -- Logged against the Revive Lab it is leaving: that is where this leg ends.
    perform revive_step(t.id, 'transferred', t.status, t.trc_id, 'status', 'sent',
      concat_ws(' · ', 'To ' || dest.name || ': ' || a.reason, n));
    update revive_tickets
       set status = 'transferred', trc_id = dest.id, trc_kind = dest.kind,
           engineer_id = null, updated_at = now()
     where id = t.id;
    update revive_approvals set status = 'sent', updated_at = now() where id = a.id;
  end if;
end $function$;

CREATE OR REPLACE FUNCTION public.revive_set_classification(p_ticket_id uuid, p_category text, p_criticality text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t    revive_tickets := revive_lock(p_ticket_id);
  cat  text := upper(nullif(btrim(coalesce(p_category, '')), ''));
  crit text := nullif(btrim(coalesce(p_criticality, '')), '');
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator of this Revive Lab can change the category and criticality';
  end if;
  if t.accepted_at is null or t.status not in (
       'accepted', 'assigned', 'in_repair', 'parts_requested', 'parts_ordered', 'parts_ready',
       'repaired', 'not_repairable', 'service_denied', 'awaiting_approval', 'approved') then
    raise exception 'The category and criticality can be changed from acceptance until it is dispatched back';
  end if;
  if cat is null or cat not in ('A', 'B', 'C') then
    raise exception 'Choose the spare category — A, B or C';
  end if;
  if crit is null or crit not in ('critical', 'non_critical') then
    raise exception 'Choose whether the spare is critical or non-critical';
  end if;
  if t.contract_type = 'CAMC' and crit <> 'critical' then
    raise exception 'A CAMC spare is always critical';
  end if;
  if cat is not distinct from t.spare_category and crit is not distinct from t.criticality then
    raise exception 'Nothing has changed';
  end if;

  update revive_tickets
     set spare_category = cat, criticality = crit, updated_at = now()
   where id = t.id;
  perform revive_step(t.id, t.status, t.status, t.trc_id, 'classify', null,
    concat_ws(' · ',
      case when cat is distinct from t.spare_category then
        case when t.spare_category is null then 'Category ' || cat
             else 'Category ' || t.spare_category || ' → ' || cat end end,
      case when crit is distinct from t.criticality then
        case when t.criticality is null then revive_crit_label(crit)
             else revive_crit_label(t.criticality) || ' → ' || revive_crit_label(crit) end end));
end $function$;

CREATE OR REPLACE FUNCTION public.revive_set_part_progress(p_request_id uuid, p_progress text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r    revive_part_requests := revive_lock_part(p_request_id);
  next text := nullif(btrim(coalesce(p_progress, '')), '');
begin
  if not revive_runs_trc(r.trc_id) then
    raise exception 'Only the Revive Lab''s coordinator keeps a local purchase up to date';
  end if;
  if r.route <> 'local' or r.status <> 'accepted' then
    raise exception 'Only a local purchase under way has this status';
  end if;
  if next is not null and next not in ('enquiry_given', 'order_placed') then
    raise exception 'Choose Enquiry given or Order placed';
  end if;
  if next is not distinct from r.progress then return; end if;

  update revive_part_requests
     set progress = next, progress_by = current_employee_id(), progress_at = now(), updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, coalesce(next, 'progress_cleared'), revive_part_label(r));
end $function$;

CREATE OR REPLACE FUNCTION public.revive_stock_part(p_request_id uuid, p_value text, p_item text, p_package text, p_part_no text DEFAULT NULL::text, p_qty integer DEFAULT NULL::integer, p_use_qty integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r       revive_part_requests := revive_lock_part(p_request_id);
  val     text := nullif(btrim(coalesce(p_value, '')), '');
  itm     text := nullif(btrim(coalesce(p_item, '')), '');
  pkg     text := nullif(btrim(coalesce(p_package, '')), '');
  part    text := nullif(btrim(coalesce(p_part_no, '')), '');
  bought  integer := coalesce(p_qty, r.qty);
  used    integer := coalesce(p_use_qty, r.qty);
  c       revive_components;
begin
  if not revive_runs_trc(r.trc_id) then
    raise exception 'Only a coordinator of this Revive Lab can add it to stock';
  end if;
  if r.status <> 'bought' then
    raise exception 'It is not purchased yet — the bill, or Purchase''s order, comes first';
  end if;
  if val is null then raise exception 'Enter the value — what is printed on the part'; end if;
  if length(val) > 160 or length(coalesce(itm, '')) > 80 or length(coalesce(pkg, '')) > 40 then
    raise exception 'Keep the value, item and type short';
  end if;
  if bought is null or bought < 1 or bought > 100000 then
    raise exception 'Enter how many were purchased';
  end if;
  if used is null or used < 0 or used > bought then
    raise exception 'The repair cannot take more than was purchased';
  end if;
  part := coalesce(part, revive_part_no_for(r.trc_id, val, itm));
  if length(part) > 40 then raise exception 'A part number is at most 40 characters'; end if;

  select * into c from revive_components
   where trc_id = r.trc_id and lower(btrim(part_no)) = lower(part) for update;
  -- A number that is already another part is not this one's.
  if found and c.value is not null
     and lower(regexp_replace(c.value, '\s', '', 'g')) <> lower(regexp_replace(val, '\s', '', 'g')) then
    raise exception '% is already % in this Revive Lab''s stock — leave the part number empty for a new one, or enter % to add to it',
      c.part_no, concat_ws(' · ', c.value, c.item), c.value;
  end if;
  if not found then
    insert into revive_components (trc_id, part_no, value, item, package, qty, updated_by)
    values (r.trc_id, part, val, itm, pkg, bought, current_employee_id())
    returning * into c;
  else
    update revive_components
       set qty = qty + bought,
           value = coalesce(c.value, val), item = coalesce(c.item, itm), package = coalesce(c.package, pkg),
           updated_at = now(), updated_by = current_employee_id()
     where id = c.id
    returning * into c;
  end if;
  insert into revive_component_moves (component_id, trc_id, ticket_id, kind, change, qty_after, actor_id)
  values (c.id, c.trc_id, r.ticket_id, 'buy', bought, c.qty, current_employee_id());

  -- What this repair asked for comes off it now; the coordinator wrote it, so it needs no second approval.
  if used > 0 then
    update revive_components set qty = qty - used, updated_at = now(), updated_by = current_employee_id()
     where id = c.id
    returning * into c;
    insert into revive_component_moves (component_id, trc_id, ticket_id, kind, change, qty_after, actor_id)
    values (c.id, c.trc_id, r.ticket_id, 'use', -used, c.qty, current_employee_id());
    insert into revive_stock_uses (
      ticket_id, component_id, trc_id, qty, status, source, requested_by, decided_by, decided_at)
    values (r.ticket_id, c.id, c.trc_id, used, 'approved', 'bought', r.requested_by,
            current_employee_id(), now());
  end if;

  update revive_part_requests
     set status = 'sent', component_id = c.id, bought_qty = bought,
         stocked_by = current_employee_id(), stocked_at = now(), updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, 'stocked',
    revive_part_label(r) || ' · ' || bought || ' into stock as ' || c.part_no
      || case when used > 0 then ', ' || used || ' for this repair' else '' end);
end $function$;

CREATE OR REPLACE FUNCTION public.revive_take_part(p_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r revive_part_requests := revive_lock_part(p_request_id);
begin
  if r.route = 'local' then
    if r.status <> 'requested' then raise exception 'This request is not waiting to be taken on'; end if;
    if not revive_runs_trc(r.trc_id) then
      raise exception 'Only the Revive Lab''s coordinator takes on a local purchase';
    end if;
  else
    if r.status <> 'forwarded' then
      raise exception '%', case r.status when 'requested'
        then 'The coordinator passes a purchase on before Purchase can take it'
        else 'This request is not waiting to be taken on' end;
    end if;
    if not revive_buys_for(r.trc_id) then
      raise exception 'Only Purchase takes on a purchase request';
    end if;
  end if;

  update revive_part_requests
     set status = 'accepted', accepted_by = current_employee_id(), accepted_at = now(), updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, 'accepted', revive_part_label(r));
end $function$;

CREATE OR REPLACE FUNCTION public.revive_upload_stock(p_trc_id uuid, p_rows jsonb, p_existing text DEFAULT 'replace'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me       uuid := current_employee_id();
  row_     jsonb;
  part     text;
  val      text;
  itm      text;
  pkg      text;
  bn       text;
  loc      text;
  q        integer;
  cur      revive_components;
  added    integer := 0;
  changed  integer := 0;
  same     integer := 0;
  skipped  integer := 0;
  seen     text[] := '{}';
begin
  if not (revive_runs_trc(p_trc_id) or revive_is_admin()) then
    raise exception 'Only a coordinator of this Revive Lab can upload its stock';
  end if;
  if not exists (select 1 from revive_trcs where id = p_trc_id) then
    raise exception 'That Revive Lab does not exist';
  end if;
  if coalesce(p_existing, '') not in ('replace', 'skip') then
    raise exception 'Say whether parts already in stock are replaced or skipped';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The sheet has no parts in it';
  end if;
  if jsonb_array_length(p_rows) > 20000 then
    raise exception 'That is more than 20,000 parts — split the sheet';
  end if;

  for row_ in select value from jsonb_array_elements(p_rows) loop
    part := btrim(coalesce(row_->>'part_no', ''));
    continue when part = '';
    if length(part) > 40 then
      raise exception 'Part number % is longer than 40 characters', left(part, 40);
    end if;
    if lower(part) = any (seen) then
      raise exception 'Part % is in the sheet twice', part;
    end if;
    seen := seen || lower(part);
    val := left(nullif(btrim(coalesce(row_->>'value', '')), ''), 160);
    itm := left(nullif(btrim(coalesce(row_->>'item', '')), ''), 80);
    pkg := left(nullif(btrim(coalesce(row_->>'package', '')), ''), 40);
    bn  := left(nullif(btrim(coalesce(row_->>'bin', '')), ''), 40);
    loc := left(nullif(btrim(coalesce(row_->>'location', '')), ''), 40);
    begin
      q := (row_->>'qty')::integer;
    exception when others then
      raise exception 'Part % has a quantity that is not a whole number', part;
    end;
    if q is null or q < 0 then
      raise exception 'Part % has no usable quantity', part;
    end if;

    select * into cur from revive_components
     where trc_id = p_trc_id and lower(btrim(part_no)) = lower(part)
     for update;
    if not found then
      insert into revive_components (trc_id, part_no, value, item, package, bin, location, qty, updated_by)
      values (p_trc_id, part, val, itm, pkg, bn, loc, q, me)
      returning * into cur;
      insert into revive_component_moves (component_id, trc_id, kind, change, qty_after, actor_id)
      values (cur.id, p_trc_id, 'count', q, q, me);
      insert into revive_component_log (component_id, trc_id, actor_id, action, changes)
      values (cur.id, p_trc_id, me, 'sheet_added',
              revive_part_changes(null, null, null, null, null, null, null, part, val, itm, pkg, bn, loc, q));
      added := added + 1;
    else
      -- A sheet without the columns leaves them as they are.
      if not (row_ ? 'bin') then bn := cur.bin; end if;
      if not (row_ ? 'location') then loc := cur.location; end if;
      if cur.value is not distinct from val and cur.item is not distinct from itm
         and cur.package is not distinct from pkg and cur.bin is not distinct from bn
         and cur.location is not distinct from loc and cur.qty = q then
        same := same + 1;
      elsif p_existing = 'skip' then
        skipped := skipped + 1;
      else
        update revive_components
           set value = val, item = itm, package = pkg, bin = bn, location = loc, qty = q,
               updated_at = now(), updated_by = me
         where id = cur.id;
        if cur.qty <> q then
          insert into revive_component_moves (component_id, trc_id, kind, change, qty_after, actor_id)
          values (cur.id, p_trc_id, 'count', q - cur.qty, q, me);
        end if;
        insert into revive_component_log (component_id, trc_id, actor_id, action, changes)
        values (cur.id, p_trc_id, me, 'sheet_replaced',
                revive_part_changes(cur.part_no, cur.value, cur.item, cur.package, cur.bin, cur.location, cur.qty,
                                    cur.part_no, val, itm, pkg, bn, loc, q));
        changed := changed + 1;
      end if;
    end if;
  end loop;

  perform log_audit('revive_stock', p_trc_id, 'uploaded',
    jsonb_build_object('added', added, 'changed', changed, 'same', same, 'skipped', skipped, 'existing', p_existing));

  return jsonb_build_object(
    'added', added, 'changed', changed, 'same', same, 'skipped', skipped,
    'not_in_sheet', (select count(*) from revive_components
                     where trc_id = p_trc_id and lower(btrim(part_no)) <> all (seen)));
end $function$;
