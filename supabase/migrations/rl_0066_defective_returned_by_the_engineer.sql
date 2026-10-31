-- Revive Lab · rl_0066 · defective returned, said by the Revive Lab engineer on closing the repair
-- The user, 31 Oct: "only revive lab eng knws about it. so move it to revive lab eng, ie if pi tickets need to enter
-- this field then only trc eng can close it". A ticket that had a PI asked for is closed only with Yes or No; the
-- coordinator's dispatch no longer asks (rl_0064), and its p_defective_returned is kept for an app still open from
-- before, and ignored. The ticket list carries it, for the Excel ("so when downloading excel this defective returned
-- y/n will be there isnt?").

drop function if exists public.revive_complete_repair(uuid, text, text, text, text[], text, text);
CREATE OR REPLACE FUNCTION public.revive_complete_repair(p_ticket_id uuid, p_note text DEFAULT NULL::text, p_outcome text DEFAULT 'repaired'::text, p_proposal text DEFAULT NULL::text, p_photos text[] DEFAULT NULL::text[], p_video text DEFAULT NULL::text, p_voice text DEFAULT NULL::text, p_defective_returned boolean DEFAULT NULL::boolean)
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
  -- A PI was asked for on it: whether the defective went back is said on closing (rl_0066).
  pi     boolean := exists (select 1 from revive_ticket_events e where e.ticket_id = t.id and e.status = 'pi_requested');
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
  if pi and p_defective_returned is null then
    raise exception 'Choose whether the defective was returned';
  end if;
  if p_outcome <> 'repaired' and length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'Say why';
  end if;
  -- An app from before rl_0014 proposes nothing, and the coordinator then chooses.
  if p_proposal is not null and p_outcome <> 'not_repairable' then
    raise exception 'Only a spare that cannot be repaired is proposed for scrap or return';
  end if;
  if p_proposal is not null and p_proposal not in ('scrap', 'return', 'oem') then
    raise exception 'Propose scrap, sending it back to the field engineer, or sending it to the OEM';
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
         nr_approved_at = null, nr_approved_by = null,
         done_photos = photos, done_video = video, done_voice = voice,
         defective_returned = case when pi then p_defective_returned else defective_returned end,
         updated_at = now()
   where id = t.id;
  perform revive_step(t.id, next, t.status, t.trc_id, 'status', p_outcome,
    concat_ws(' · ', nullif(btrim(coalesce(p_note, '')), ''),
      case when pi then 'Defective returned: ' || case when p_defective_returned then 'Yes' else 'No' end end));
end $function$;
revoke all on function public.revive_complete_repair(uuid, text, text, text, text[], text, text, boolean) from public, anon;
grant execute on function public.revive_complete_repair(uuid, text, text, text, text[], text, text, boolean) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.revive_dispatch(p_ticket_id uuid, p_courier text, p_awb text, p_dispatched_on date, p_note text DEFAULT NULL::text, p_billing_estimate numeric DEFAULT NULL::numeric, p_oem_address text DEFAULT NULL::text, p_defective_returned boolean DEFAULT NULL::boolean)
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

-- The ticket list, with whether the defective went back (for the Excel).
drop function if exists public.revive_ticket_list();
CREATE OR REPLACE FUNCTION public.revive_ticket_list()
 RETURNS TABLE(id uuid, number integer, code text, status text, trc_kind text, trc_id uuid, trc_name text, source_ticket_no text, facility text, district text, state text, bemmp_id uuid, bemmp_code text, billing_spare boolean, equipment_name text, equipment_barcode text, spare_name text, items jsonb, issue text, return_address text, contact_number text, in_courier text, in_awb text, in_dispatched_on date, stakeholder_id uuid, stakeholder_name text, stakeholder_ecode text, stakeholder_function text, stakeholder_manager_name text, raised_by uuid, raised_by_name text, raised_by_function text, raised_as text, engineer_id uuid, engineer_name text, engineer_ecode text, out_courier text, out_awb text, out_dispatched_on date, created_at timestamp with time zone, updated_at timestamp with time zone, closed_at timestamp with time zone, outcome text, closure text, scrapped_at timestamp with time zone, scrapped_by_name text, expected_by date, parts jsonb, proposal text, trc_state text, approval jsonb, arrival_damaged boolean, arrival_photos text[], done_photos text[], done_video text, return_damaged boolean, return_photos text[], final_working boolean, received_at timestamp with time zone, stock jsonb, equipment_make text, equipment_model text, done_voice text, source text, warehouse_id uuid, spare_category text, criticality text, contract_type text, accepted_at timestamp with time zone, dispatched_at timestamp with time zone, billing_estimate numeric, asks_billing_estimate boolean, field_returns jsonb, handover jsonb, repaired_at timestamp with time zone, oem_address text, nr_approved_at timestamp with time zone, nr_approved_by_name text, item_code text, defective_returned boolean)
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
         t.nr_approved_at, nra.full_name, t.item_code,
         -- A PI was asked for on it: whether the defective went back (rl_0064, rl_0066).
         t.defective_returned
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
  order by t.created_at desc
$function$;
revoke all on function public.revive_ticket_list() from public, anon;
grant execute on function public.revive_ticket_list() to authenticated, service_role;
