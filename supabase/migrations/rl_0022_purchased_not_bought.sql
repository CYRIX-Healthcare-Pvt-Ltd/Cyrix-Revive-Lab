/*
  rl_0022 — purchased, not bought.

  The words people read — refusals and history notes — say purchase and
  purchased, as the screens now do. Written from the live definitions with
  only those phrases changed; the status 'bought' and the stock move 'buy'
  are names inside the database and stay. A Purchase hand-back now reads
  "handed back by Purchase: <reason>".
*/

CREATE OR REPLACE FUNCTION public.revive_cancel_part(p_request_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r revive_part_requests := revive_lock_part(p_request_id);
  t revive_tickets;
begin
  select * into t from revive_tickets where id = r.ticket_id;
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can cancel a request';
  end if;
  if r.status not in ('requested', 'forwarded', 'accepted') then
    raise exception 'Only a request that has not been purchased can be cancelled';
  end if;
  update revive_part_requests set status = 'cancelled', updated_at = now() where id = r.id;
  perform revive_parts_step(r.ticket_id, 'cancelled',
    concat_ws(' · ', revive_part_label(r), nullif(btrim(coalesce(p_reason, '')), '')));
end $function$;

CREATE OR REPLACE FUNCTION public.revive_complete_repair(p_ticket_id uuid, p_note text DEFAULT NULL::text, p_outcome text DEFAULT 'repaired'::text, p_proposal text DEFAULT NULL::text, p_photos text[] DEFAULT NULL::text[], p_video text DEFAULT NULL::text, p_voice text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    raise exception 'Finish the component requests before closing the repair — confirm what was purchased, or cancel what is no longer needed';
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
end $function$;

CREATE OR REPLACE FUNCTION public.revive_decline_part(p_request_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r     revive_part_requests := revive_lock_part(p_request_id);
  n     text := btrim(coalesce(p_reason, ''));
  buyer boolean := revive_buys_for(r.trc_id);
  desk  boolean := revive_runs_trc(r.trc_id);
begin
  if not (desk or buyer) then
    raise exception 'Only whoever holds this request can decline it';
  end if;
  if r.status not in ('requested', 'forwarded', 'accepted') then
    raise exception 'This request is not open';
  end if;
  if length(n) < 3 then
    raise exception 'Say why it is not being purchased';
  end if;

  -- Purchase handing it back rather than refusing it outright.
  if not desk and buyer and r.status in ('forwarded', 'accepted') then
    update revive_part_requests
       set status = 'requested', accepted_by = null, accepted_at = null, updated_at = now()
     where id = r.id;
    perform revive_parts_step(r.ticket_id, 'handed_back',
      revive_part_label(r) || ' — handed back by Purchase: ' || n);
    return;
  end if;

  update revive_part_requests
     set status = 'declined', declined_by = current_employee_id(), declined_at = now(),
         declined_reason = n, updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, 'declined', revive_part_label(r) || ' · ' || n);
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
    raise exception 'Only the Revive Lab''s coordinator or manager passes a request to Purchase';
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
    raise exception 'Only the Revive Lab''s coordinator or manager can purchase it locally';
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

CREATE OR REPLACE FUNCTION public.revive_purchase_part(p_request_id uuid, p_amount numeric, p_bill_paths text[], p_bill_no text DEFAULT NULL::text, p_vendor text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r    revive_part_requests := revive_lock_part(p_request_id);
  path text;
begin
  if not revive_handles_part(r.route, r.trc_id) then
    raise exception 'Only whoever purchases this request can attach its bill';
  end if;
  if r.status <> 'accepted' then
    raise exception 'Take the request on before purchasing it';
  end if;
  if p_amount is null or p_amount < 0 or p_amount > 10000000 then
    raise exception 'Enter the bill amount';
  end if;
  if coalesce(array_length(p_bill_paths, 1), 0) = 0 then
    raise exception 'Attach the bill';
  end if;
  if array_length(p_bill_paths, 1) > 3 then
    raise exception 'Attach at most 3 pages of the bill';
  end if;
  foreach path in array p_bill_paths loop
    if path !~ ('^' || r.ticket_id || '/parts/' || r.id || '/bill-[1-3]\.(jpg|jpeg|png|webp)$') then
      raise exception 'That is not this request''s bill';
    end if;
  end loop;

  update revive_part_requests
     set status = 'bought', purchased_by = current_employee_id(), purchased_at = now(),
         bill_amount = round(p_amount, 2), bill_paths = p_bill_paths,
         bill_no = nullif(btrim(coalesce(p_bill_no, '')), ''),
         vendor = nullif(btrim(coalesce(p_vendor, '')), ''),
         updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, 'purchased',
    revive_part_label(r) || ' · ₹' || regexp_replace(to_char(round(p_amount, 2), 'FM9999999990.00'), '\.00$', ''));
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
    raise exception 'Only the Revive Lab''s coordinator or manager keeps a local purchase up to date';
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
    raise exception 'Only a coordinator or manager of this Revive Lab can add it to stock';
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
