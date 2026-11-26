-- =====================================================================
-- Revive Lab · rl_0070 · The ticket list in pages;
--                        the Components rule worked out once
--
-- 20 Nov: the shared database ran out of memory at the morning rush. Measured:
--  * The app read revive_ticket_list 1,000 rows at a time, and each piece made
--    the whole list (with every ticket's extras) again: an admin's or
--    observer's 1,184 tickets were made twice per refresh.
--  * revive_components' read rule asked "is this person in this Revive Lab?"
--    once per component: 1,359 times, 0.82 s, for one Revive Lab's stock.
--    (A first draft looked every page's extras up together: inside a function
--    that planned badly, 1.4–4.7 s, so the list keeps its own body.)
-- Now revive_ticket_page(offset, limit) makes only one page and its extras;
-- revive_ticket_list() is the whole list from it, for an app not yet updated.
-- The read rules of components and their moves work out the person's Revive
-- Labs once. Who sees what, and every column, as before.
-- =====================================================================

-- The Revive Labs whose stock the person sees: every one for an admin (as revive_in_trc).
create or replace function public.revive_my_trc_ids()
returns uuid[] language sql stable security definer set search_path = public as $$
  select case when revive_is_admin() then array(select id from revive_trcs)
              else array(select mt.trc_id from revive_member_trcs mt where mt.employee_id = current_employee_id()) end
$$;
revoke all on function public.revive_my_trc_ids() from public, anon;
grant execute on function public.revive_my_trc_ids() to authenticated, service_role;

drop policy if exists revive_components_read on public.revive_components;
create policy revive_components_read on public.revive_components for select to authenticated
  using (trc_id = any ((select public.revive_my_trc_ids())::uuid[]));
drop policy if exists revive_component_moves_read on public.revive_component_moves;
create policy revive_component_moves_read on public.revive_component_moves for select to authenticated
  using (trc_id = any ((select public.revive_my_trc_ids())::uuid[]));

-- One page of the list, newest first: the list's own body, unchanged, for the page's tickets only.
drop function if exists public.revive_ticket_page(integer, integer);
create function public.revive_ticket_page(p_offset integer default 0, p_limit integer default 1000)
returns TABLE(id uuid, number integer, code text, status text, trc_kind text, trc_id uuid, trc_name text, source_ticket_no text, facility text, district text, state text, bemmp_id uuid, bemmp_code text, billing_spare boolean, equipment_name text, equipment_barcode text, spare_name text, items jsonb, issue text, return_address text, contact_number text, in_courier text, in_awb text, in_dispatched_on date, stakeholder_id uuid, stakeholder_name text, stakeholder_ecode text, stakeholder_function text, stakeholder_manager_name text, raised_by uuid, raised_by_name text, raised_by_function text, raised_as text, engineer_id uuid, engineer_name text, engineer_ecode text, out_courier text, out_awb text, out_dispatched_on date, created_at timestamp with time zone, updated_at timestamp with time zone, closed_at timestamp with time zone, outcome text, closure text, scrapped_at timestamp with time zone, scrapped_by_name text, expected_by date, parts jsonb, proposal text, trc_state text, approval jsonb, arrival_damaged boolean, arrival_photos text[], done_photos text[], done_video text, return_damaged boolean, return_photos text[], final_working boolean, received_at timestamp with time zone, stock jsonb, equipment_make text, equipment_model text, done_voice text, source text, warehouse_id uuid, spare_category text, criticality text, contract_type text, accepted_at timestamp with time zone, dispatched_at timestamp with time zone, billing_estimate numeric, asks_billing_estimate boolean, field_returns jsonb, handover jsonb, repaired_at timestamp with time zone, oem_address text, nr_approved_at timestamp with time zone, nr_approved_by_name text, item_code text, defective_returned boolean)
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
  from (
    -- Only this page's tickets, newest first (rl_0070); the extras below are looked up for these alone.
    select t0.* from revive_tickets t0
    where t0.id = any((select revive_visible_ids())::uuid[])
    order by t0.created_at desc, t0.id
    offset greatest(coalesce(p_offset, 0), 0) limit greatest(coalesce(p_limit, 1000), 0)
  ) t
  join revive_trcs trc on trc.id = t.trc_id
  left join revive_bemmp_projects bp on bp.id = t.bemmp_id
  join employees sh on sh.id = t.stakeholder_id
  left join employees shm on shm.id = sh.reporting_manager_id
  join employees rb on rb.id = t.raised_by
  left join employees en on en.id = t.engineer_id
  left join employees sc on sc.id = t.scrapped_by
  left join employees nra on nra.id = t.nr_approved_by
  -- Whom it is shown to, worked out once for the whole list (rl_0067).
  order by t.created_at desc, t.id
$fn$;
revoke all on function public.revive_ticket_page(integer, integer) from public, anon;
grant execute on function public.revive_ticket_page(integer, integer) to authenticated, service_role;

-- The whole list, for an app not yet updated: the same rows, from the page.
create or replace function public.revive_ticket_list()
returns TABLE(id uuid, number integer, code text, status text, trc_kind text, trc_id uuid, trc_name text, source_ticket_no text, facility text, district text, state text, bemmp_id uuid, bemmp_code text, billing_spare boolean, equipment_name text, equipment_barcode text, spare_name text, items jsonb, issue text, return_address text, contact_number text, in_courier text, in_awb text, in_dispatched_on date, stakeholder_id uuid, stakeholder_name text, stakeholder_ecode text, stakeholder_function text, stakeholder_manager_name text, raised_by uuid, raised_by_name text, raised_by_function text, raised_as text, engineer_id uuid, engineer_name text, engineer_ecode text, out_courier text, out_awb text, out_dispatched_on date, created_at timestamp with time zone, updated_at timestamp with time zone, closed_at timestamp with time zone, outcome text, closure text, scrapped_at timestamp with time zone, scrapped_by_name text, expected_by date, parts jsonb, proposal text, trc_state text, approval jsonb, arrival_damaged boolean, arrival_photos text[], done_photos text[], done_video text, return_damaged boolean, return_photos text[], final_working boolean, received_at timestamp with time zone, stock jsonb, equipment_make text, equipment_model text, done_voice text, source text, warehouse_id uuid, spare_category text, criticality text, contract_type text, accepted_at timestamp with time zone, dispatched_at timestamp with time zone, billing_estimate numeric, asks_billing_estimate boolean, field_returns jsonb, handover jsonb, repaired_at timestamp with time zone, oem_address text, nr_approved_at timestamp with time zone, nr_approved_by_name text, item_code text, defective_returned boolean)
language sql stable security definer set search_path to 'public'
as $fn$
  select * from revive_ticket_page(0, 2147483647)
$fn$;
revoke all on function public.revive_ticket_list() from public, anon;
grant execute on function public.revive_ticket_list() to authenticated, service_role;
