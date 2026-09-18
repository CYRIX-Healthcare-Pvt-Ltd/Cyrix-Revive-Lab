/*
  rl_0019 — make and model, a whole machine, the order Purchase places,
  where a local purchase stands, the repair's voice note, and who raises.

  - revive_tickets: equipment_make and equipment_model (the route card,
    after the equipment name); done_voice, the voice note the engineer may
    close a repair with, a minute at most.
  - A line on the card may be a Full Machine (kind full_machine), as well
    as a spare or an accessory.
  - revive_raise_ticket takes the make and model. A Revive Lab engineer or
    Purchase, without a desk of their own, does not raise tickets: the
    field engineer sends spares in, or the coordinator writes the card.
  - revive_part_requests.progress: blank, enquiry_given or order_placed —
    where the coordinator's local purchase stands (revive_set_part_progress).
  - Purchase places the order rather than attaching a bill: PO number, PO
    date, expected delivery date and vendor (revive_order_part). It then
    waits with the coordinator, who adds it to stock when it arrives.
  - Signed out, nothing: every revive_ function is revoked from anon and
    public; whoever could call one signed in still can.
*/

-- ---------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------
alter table public.revive_tickets
  add column if not exists equipment_make text,
  add column if not exists equipment_model text,
  add column if not exists done_voice text;

alter table public.revive_tickets
  add constraint revive_tickets_make_len check (equipment_make is null or length(equipment_make) <= 80),
  add constraint revive_tickets_model_len check (equipment_model is null or length(equipment_model) <= 80);

alter table public.revive_part_requests
  add column if not exists progress text,
  add column if not exists progress_by uuid references public.employees(id),
  add column if not exists progress_at timestamptz,
  add column if not exists po_number text,
  add column if not exists po_date date,
  add column if not exists edd date;

alter table public.revive_part_requests
  add constraint revive_part_requests_progress_check
    check (progress is null or progress in ('enquiry_given', 'order_placed'));

-- ---------------------------------------------------------------------
-- Files: the repair's voice note is the engineer's, like an observation's
-- ---------------------------------------------------------------------
/*
  The storage rules already let the ticket's engineer put up anything of
  the 'voice' kind, so the repair's voice note joins that kind rather than
  the rules being rewritten; revive_complete_repair checks it by its own.
*/
create or replace function public.revive_file_ok(p_ticket_id uuid, p_path text, p_kind text)
returns boolean
language sql immutable
as $fn$
  select p_path ~ ('^' || p_ticket_id || '/' || case p_kind
    when 'arrival'    then 'arrival-[12]\.(jpg|jpeg|png|webp)'
    when 'done'       then 'done-[12]\.(jpg|jpeg|png|webp)'
    when 'video'      then 'done\.(webm|mp4)'
    when 'return'     then 'return-[12]\.(jpg|jpeg|png|webp)'
    when 'voice'      then '(voice-[0-9]{1,3}|done-voice)\.(webm|ogg|m4a|mp4|mp3|aac)'
    when 'done_voice' then 'done-voice\.(webm|ogg|m4a|mp4|mp3|aac)'
    else 'never' end || '$')
$fn$;

-- ---------------------------------------------------------------------
-- Raising: make and model, a full machine, and who raises
-- ---------------------------------------------------------------------
drop function if exists public.revive_raise_ticket(
  uuid, text, text, uuid, text, text, text, text, text, text, text, text, text, text, date, uuid, jsonb, boolean, text);

create function public.revive_raise_ticket(
  p_trc_id uuid, p_hospital text, p_state text, p_bemmp_id uuid, p_district text, p_source_ticket_no text,
  p_equipment_name text, p_equipment_barcode text, p_spare_name text, p_issue text, p_return_address text,
  p_contact_number text, p_in_courier text, p_in_awb text, p_in_dispatched_on date,
  p_stakeholder_id uuid default null, p_items jsonb default null, p_billing_spare boolean default null,
  p_approval_reason text default null, p_equipment_make text default null, p_equipment_model text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  me        uuid := current_employee_id();
  trc       revive_trcs;
  bemmp     revive_bemmp_projects;
  st        text := btrim(coalesce(p_state, ''));
  why       text := btrim(coalesce(p_approval_reason, ''));
  make      text := nullif(btrim(coalesce(p_equipment_make, '')), '');
  model     text := nullif(btrim(coalesce(p_equipment_model, '')), '');
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
  -- Its engineers repair what arrives, and Purchase buys for it.
  if not is_sw_admin() and exists (
       select 1 from revive_members m
        where m.employee_id = me and (m.is_engineer or m.is_purchase)
          and not (m.is_coordinator or m.is_manager or m.is_admin)) then
    raise exception 'Tickets are raised by the field engineer or a Revive Lab coordinator — not by a Revive Lab engineer or Purchase';
  end if;

  select * into trc from revive_trcs where id = p_trc_id and is_active;
  if not found then raise exception 'Choose the Revive Lab the spare is going to'; end if;

  if length(st) < 2 then
    raise exception 'Choose the state';
  end if;
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
  if length(coalesce(make, '')) > 80 or length(coalesce(model, '')) > 80 then
    raise exception 'Keep the make and the model under 80 characters';
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

  as_co := revive_runs_trc(p_trc_id);
  holder := coalesce(p_stakeholder_id, me);

  if as_co and p_stakeholder_id is null then
    raise exception 'Name the field engineer this spare belongs to, so they and their manager can follow it';
  end if;
  if not as_co and holder <> me then
    raise exception 'Only the Revive Lab''s coordinator can raise a ticket on somebody else''s behalf';
  end if;
  if not exists (select 1 from employees where id = holder and is_active) then
    raise exception 'That field engineer is not an active employee';
  end if;

  /*
    Another state's Revive Lab. A field engineer is offered their own
    state's and the Regional ones; any other is asked for, with a reason,
    and waits for the Regional Revive Lab admins. The desk raises a spare
    that has already arrived at its own Revive Lab, wherever it came from.
  */
  far := not as_co and trc.state is not null and trc.state <> st;
  if far and length(why) < 5 then
    raise exception '% is not a Revive Lab for % — say why it should go there, and the Regional Revive Lab admins approve it first', trc.name, st;
  end if;
  if far and length(why) > 500 then
    raise exception 'Keep the reason under 500 characters';
  end if;

  insert into revive_tickets (
    status, trc_kind, trc_id, facility, state, bemmp_id, billing_spare, district, source_ticket_no,
    equipment_name, equipment_make, equipment_model, equipment_barcode, spare_name, items, issue,
    return_address, contact_number, in_courier, in_awb, in_dispatched_on,
    stakeholder_id, raised_by, raised_as)
  values (
    case when far then 'awaiting_approval' else 'pending_acceptance' end,
    trc.kind, trc.id,
    btrim(p_hospital),
    st,
    p_bemmp_id,
    case when bemmp.asks_billing then coalesce(p_billing_spare, false) end,
    btrim(p_district),
    nullif(btrim(coalesce(p_source_ticket_no, '')), ''),
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
    holder, me, case when as_co then 'coordinator' else 'engineer' end)
  returning * into t;

  if far then
    insert into revive_approvals (ticket_id, kind, asked_trc_id, to_trc_id, reason, requested_by)
    values (t.id, 'raise', trc.id, trc.id, why, me);
    perform revive_step(t.id, 'awaiting_approval', null, t.trc_id, 'status', 'lab_requested',
      'For ' || trc.name || ': ' || why);
  else
    perform revive_log(t.id, 'pending_acceptance', null, t.trc_id,
      case when as_co then 'Raised at the Revive Lab' else 'Raised from the field' end);
  end if;

  return jsonb_build_object('id', t.id, 'code', t.code, 'number', t.number, 'status', t.status);
end $fn$;

revoke all on function public.revive_raise_ticket(
  uuid, text, text, uuid, text, text, text, text, text, text, text, text, text, text, date, uuid, jsonb, boolean, text, text, text)
  from public, anon;
grant execute on function public.revive_raise_ticket(
  uuid, text, text, uuid, text, text, text, text, text, text, text, text, text, text, date, uuid, jsonb, boolean, text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------
-- Closing the repair: a voice note beside the photograph and the video
-- ---------------------------------------------------------------------
drop function if exists public.revive_complete_repair(uuid, text, text, text, text[], text);

create function public.revive_complete_repair(
  p_ticket_id uuid, p_note text default null, p_outcome text default 'repaired', p_proposal text default null,
  p_photos text[] default null, p_video text default null, p_voice text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t      revive_tickets := revive_lock(p_ticket_id);
  next   text;
  photos text[] := coalesce(p_photos, '{}');
  video  text := nullif(btrim(coalesce(p_video, '')), '');
  voice  text := nullif(btrim(coalesce(p_voice, '')), '');
  path   text;
begin
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can close the repair';
  end if;
  if t.status in ('parts_requested', 'parts_ordered', 'parts_ready') then
    raise exception 'Finish the component requests before closing the repair — confirm what was bought, or cancel what is no longer needed';
  end if;
  if t.status <> 'in_repair' then
    raise exception 'Accept the repair before closing it';
  end if;
  if coalesce(p_outcome, '') not in ('repaired', 'not_repairable', 'customer_denied') then
    raise exception 'Choose how the repair ended';
  end if;
  if p_outcome <> 'repaired' and length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'Say why';
  end if;
  -- An app from before rl_0014 proposes nothing, and the coordinator then chooses.
  if p_proposal is not null and p_outcome <> 'not_repairable' then
    raise exception 'Only a spare that cannot be repaired is proposed for scrap or return';
  end if;
  if p_proposal is not null and p_proposal not in ('scrap', 'return') then
    raise exception 'Propose scrap, or sending it back to the field engineer';
  end if;
  -- The photograph, the video and the voice note belong to a repair that worked.
  if p_outcome <> 'repaired' and (coalesce(array_length(photos, 1), 0) > 0 or video is not null or voice is not null) then
    raise exception 'The photograph, the video and the voice note are for a spare that was repaired';
  end if;
  if array_length(photos, 1) > 2 then
    raise exception 'Two photographs of the repaired spare, at most';
  end if;
  foreach path in array photos loop
    if not revive_file_ok(t.id, path, 'done') then
      raise exception 'That is not a photograph of this repair';
    end if;
  end loop;
  if video is not null and not revive_file_ok(t.id, video, 'video') then
    raise exception 'That is not this repair''s video';
  end if;
  if voice is not null and not revive_file_ok(t.id, voice, 'done_voice') then
    raise exception 'That is not this repair''s voice note';
  end if;

  next := case p_outcome
            when 'repaired' then 'repaired'
            when 'not_repairable' then 'not_repairable'
            else 'service_denied' end;
  update revive_tickets
     set status = next, outcome = p_outcome, proposal = p_proposal,
         done_photos = photos, done_video = video, done_voice = voice, updated_at = now()
   where id = t.id;
  perform revive_step(t.id, next, t.status, t.trc_id, 'status', p_outcome, p_note);
end $fn$;

revoke all on function public.revive_complete_repair(uuid, text, text, text, text[], text, text) from public, anon;
grant execute on function public.revive_complete_repair(uuid, text, text, text, text[], text, text) to authenticated;

-- ---------------------------------------------------------------------
-- The ticket list: make, model and the repair's voice note
-- ---------------------------------------------------------------------
drop function if exists public.revive_ticket_list();

create function public.revive_ticket_list()
returns table(
  id uuid, number integer, code text, status text, trc_kind text, trc_id uuid, trc_name text,
  source_ticket_no text, facility text, district text, state text, bemmp_id uuid, bemmp_code text,
  billing_spare boolean, equipment_name text, equipment_barcode text, spare_name text, items jsonb,
  issue text, return_address text, contact_number text, in_courier text, in_awb text, in_dispatched_on date,
  stakeholder_id uuid, stakeholder_name text, stakeholder_ecode text, stakeholder_function text,
  stakeholder_manager_name text, raised_by uuid, raised_by_name text, raised_by_function text, raised_as text,
  engineer_id uuid, engineer_name text, engineer_ecode text, out_courier text, out_awb text,
  out_dispatched_on date, created_at timestamptz, updated_at timestamptz, closed_at timestamptz,
  outcome text, closure text, scrapped_at timestamptz, scrapped_by_name text, expected_by date,
  parts jsonb, proposal text, trc_state text, approval jsonb, arrival_damaged boolean,
  arrival_photos text[], done_photos text[], done_video text, return_damaged boolean,
  return_photos text[], final_working boolean, received_at timestamptz, stock jsonb,
  equipment_make text, equipment_model text, done_voice text)
language sql stable security definer set search_path to 'public'
as $fn$
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
                   'decision_note', a.decision_note)
            from revive_approvals a
            left join revive_trcs f on f.id = a.from_trc_id
            join revive_trcs ak on ak.id = a.asked_trc_id
            join revive_trcs d on d.id = a.to_trc_id
            join employees rq on rq.id = a.requested_by
            left join employees dc on dc.id = a.decided_by
           where a.ticket_id = t.id
           order by a.requested_at desc
           limit 1),
         t.arrival_damaged, t.arrival_photos, t.done_photos, t.done_video,
         t.return_damaged, t.return_photos, t.final_working, t.received_at,
         -- What the engineer has taken from stock, and where each stands (rl_0016).
         coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'status', u.status) order by u.requested_at)
                   from revive_stock_uses u where u.ticket_id = t.id), '[]'::jsonb),
         t.equipment_make, t.equipment_model, t.done_voice
  from revive_tickets t
  join revive_trcs trc on trc.id = t.trc_id
  left join revive_bemmp_projects bp on bp.id = t.bemmp_id
  join employees sh on sh.id = t.stakeholder_id
  left join employees shm on shm.id = sh.reporting_manager_id
  join employees rb on rb.id = t.raised_by
  left join employees en on en.id = t.engineer_id
  left join employees sc on sc.id = t.scrapped_by
  where revive_can_see(t.id)
  order by t.number desc
$fn$;

revoke all on function public.revive_ticket_list() from public, anon;
grant execute on function public.revive_ticket_list() to authenticated;

-- ---------------------------------------------------------------------
-- A local purchase: where the coordinator has got to
-- ---------------------------------------------------------------------
create function public.revive_set_part_progress(p_request_id uuid, p_progress text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  r    revive_part_requests := revive_lock_part(p_request_id);
  next text := nullif(btrim(coalesce(p_progress, '')), '');
begin
  if not revive_runs_trc(r.trc_id) then
    raise exception 'Only the Revive Lab''s coordinator or manager keeps a local purchase up to date';
  end if;
  if r.route <> 'local' or r.status <> 'accepted' then
    raise exception 'Only a local purchase that is being bought has this status';
  end if;
  if next is not null and next not in ('enquiry_given', 'order_placed') then
    raise exception 'Choose Enquiry given or Order placed';
  end if;
  if next is not distinct from r.progress then return; end if;

  update revive_part_requests
     set progress = next, progress_by = current_employee_id(), progress_at = now(), updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, coalesce(next, 'progress_cleared'), revive_part_label(r));
end $fn$;

revoke all on function public.revive_set_part_progress(uuid, text) from public, anon;
grant execute on function public.revive_set_part_progress(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Purchase places the order; the coordinator stocks it when it arrives
-- ---------------------------------------------------------------------
create function public.revive_order_part(
  p_request_id uuid, p_po_number text, p_po_date date, p_edd date, p_vendor text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  r   revive_part_requests := revive_lock_part(p_request_id);
  po  text := btrim(coalesce(p_po_number, ''));
  who text := btrim(coalesce(p_vendor, ''));
begin
  if r.route <> 'purchase' or not revive_buys_for(r.trc_id) then
    raise exception 'Only Purchase places the order for a purchase request';
  end if;
  if r.status not in ('forwarded', 'accepted') then
    raise exception 'This request is not waiting for an order';
  end if;
  if length(po) < 1 then raise exception 'Enter the PO number'; end if;
  if length(po) > 60 then raise exception 'A PO number is at most 60 characters'; end if;
  if p_po_date is null then raise exception 'Enter the PO date'; end if;
  if p_po_date > current_date + 1 then raise exception 'The PO date cannot be in the future'; end if;
  if p_edd is null then raise exception 'Enter the expected delivery date'; end if;
  if p_edd < p_po_date then raise exception 'The expected delivery date cannot be before the PO date'; end if;
  if length(who) < 2 then raise exception 'Enter the vendor''s name'; end if;
  if length(who) > 120 then raise exception 'Keep the vendor''s name under 120 characters'; end if;

  update revive_part_requests
     set status = 'bought',
         accepted_by = coalesce(accepted_by, current_employee_id()),
         accepted_at = coalesce(accepted_at, now()),
         purchased_by = current_employee_id(), purchased_at = now(),
         po_number = po, po_date = p_po_date, edd = p_edd, vendor = who,
         updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, 'ordered',
    revive_part_label(r) || ' · PO ' || po || ' · ' || who || ' · due ' || to_char(p_edd, 'DD Mon YYYY'));
end $fn$;

revoke all on function public.revive_order_part(uuid, text, date, date, text) from public, anon;
grant execute on function public.revive_order_part(uuid, text, date, date, text) to authenticated;

-- The stock entry waits for the bill, or for Purchase's order.
create or replace function public.revive_stock_part(
  p_request_id uuid, p_value text, p_item text, p_package text,
  p_part_no text default null, p_qty integer default null, p_use_qty integer default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
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
    raise exception 'Only a coordinator or manager of this Revive Lab can add it to stock';
  end if;
  if r.status <> 'bought' then
    raise exception 'It is not bought yet — the bill, or Purchase''s order, comes first';
  end if;
  if val is null then raise exception 'Enter the value — what is printed on the part'; end if;
  if length(val) > 160 or length(coalesce(itm, '')) > 80 or length(coalesce(pkg, '')) > 40 then
    raise exception 'Keep the value, item and type short';
  end if;
  if bought is null or bought < 1 or bought > 100000 then
    raise exception 'Enter how many were bought';
  end if;
  if used is null or used < 0 or used > bought then
    raise exception 'The repair cannot take more than was bought';
  end if;
  part := coalesce(part, revive_part_no_for(r.trc_id, val, itm));
  if length(part) > 40 then raise exception 'A part number is at most 40 characters'; end if;

  select * into c from revive_components
   where trc_id = r.trc_id and lower(btrim(part_no)) = lower(part) for update;
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
end $fn$;

-- ---------------------------------------------------------------------
-- The request list: progress and the order
-- ---------------------------------------------------------------------
drop function if exists public.revive_part_request_list(uuid);

create function public.revive_part_request_list(p_ticket_id uuid default null)
returns table(
  id uuid, ticket_id uuid, ticket_code text, ticket_status text, facility text, trc_id uuid, trc_name text,
  route text, name text, qty integer, note text, link text, photo_path text, status text,
  bill_amount numeric, bill_no text, vendor text, bill_paths text[], requested_by uuid,
  requested_by_name text, requested_at timestamptz, accepted_by_name text, accepted_at timestamptz,
  declined_by_name text, declined_at timestamptz, declined_reason text, purchased_by_name text,
  purchased_at timestamptz, received_by_name text, received_at timestamptz, component_id uuid,
  part_no text, value text, item text, package text, bought_qty integer, stocked_by_name text,
  stocked_at timestamptz, progress text, progress_by_name text, progress_at timestamptz,
  po_number text, po_date date, edd date)
language sql stable security definer set search_path to 'public'
as $fn$
  select r.id, r.ticket_id, t.code, t.status, t.facility,
         r.trc_id, trc.name, r.route, r.name, r.qty, r.note, r.link, r.photo_path,
         r.status, r.bill_amount, r.bill_no, r.vendor, r.bill_paths,
         r.requested_by, rq.full_name, r.requested_at,
         ac.full_name, r.accepted_at,
         dc.full_name, r.declined_at, r.declined_reason,
         pu.full_name, r.purchased_at,
         rc.full_name, r.received_at,
         r.component_id, c.part_no, c.value, c.item, c.package,
         r.bought_qty, st.full_name, r.stocked_at,
         r.progress, pg.full_name, r.progress_at,
         r.po_number, r.po_date, r.edd
  from revive_part_requests r
  join revive_tickets t on t.id = r.ticket_id
  join revive_trcs trc on trc.id = r.trc_id
  left join revive_components c on c.id = r.component_id
  left join employees rq on rq.id = r.requested_by
  left join employees ac on ac.id = r.accepted_by
  left join employees dc on dc.id = r.declined_by
  left join employees pu on pu.id = r.purchased_by
  left join employees rc on rc.id = r.received_by
  left join employees st on st.id = r.stocked_by
  left join employees pg on pg.id = r.progress_by
  where (p_ticket_id is null or r.ticket_id = p_ticket_id)
    and revive_can_see(r.ticket_id)
  order by r.requested_at desc
$fn$;

revoke all on function public.revive_part_request_list(uuid) from public, anon;
grant execute on function public.revive_part_request_list(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Signed out, nothing
-- ---------------------------------------------------------------------
/*
  Supabase's default privileges gave every function to anon, and the
  earlier revive_ functions kept that. Each checks who is calling, so a
  signed-out call was refused anyway — but with a message about roles,
  which is what a person whose session had lapsed was shown. Whoever held
  a function signed in keeps it.
*/
do $do$
declare
  f     record;
  authd boolean;
  svc   boolean;
begin
  for f in
    select p.oid, p.oid::regprocedure as sig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname like 'revive\_%'
  loop
    authd := has_function_privilege('authenticated', f.oid, 'execute');
    svc := has_function_privilege('service_role', f.oid, 'execute');
    execute format('revoke execute on function %s from public, anon', f.sig);
    if authd then execute format('grant execute on function %s to authenticated', f.sig); end if;
    if svc then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
end $do$;
