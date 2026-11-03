/*
  rl_0067 — the Tickets list came back empty for Henry (E9999, Revive Lab admin and coordinator; the user, 3 Nov: "why no
  tickets"). revive_ticket_list ran revive_can_see on each of 781 tickets, every rule each time, and its slowest calls reached
  7.98 s against the 8 s limit; a call cut off showed as "All 0". An admin is now answered before the rules: 2.1 s → 0.25 s.
  The same rules, worked out once: revive_visible_ids() for the Tickets list and the dashboard's events, which ran them
  per ticket (is_in_my_downline rebuilt the whole team each time, about 4 ms a ticket, 3 s for anyone). revive_can_see
  stays for one ticket at a time; a rule changed there is changed in revive_visible_ids too.
*/
CREATE OR REPLACE FUNCTION public.revive_can_see(p_ticket_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- An admin first, once: every rule below on every ticket took 2 s for 781 and the list hit the 8 s limit (rl_0067).
  select revive_is_admin() or exists (
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
          where r.ticket_id = t.id and revive_passed_to_purchase(r.route, r.status, r.declined_by, r.trc_id)
            and m.employee_id = current_employee_id() and m.is_purchase)
        -- The field engineer asked to take it over, while they decide (rl_0028).
        or exists (
          select 1 from revive_handovers h
          where h.ticket_id = t.id and h.status = 'pending' and h.to_id = current_employee_id())
      )
  )
$function$;

create or replace function public.revive_visible_ids()
returns uuid[] language plpgsql stable security definer set search_path to 'public' as $$
declare
  me uuid := current_employee_id();
  team uuid[];
  desks uuid[];
begin
  if me is null then return '{}'; end if;
  -- Every Revive Lab admin and the software administrator; a Regional Revive Lab's manager sees every Revive Lab's work.
  if revive_is_admin() or exists (
       select 1 from revive_members m join revive_member_trcs mt on mt.employee_id = m.employee_id join revive_trcs l on l.id = mt.trc_id
        where m.employee_id = me and m.is_manager and l.state is null) then
    return array(select id from revive_tickets);
  end if;
  team := array(select downline_of(me));
  -- The desks of the Revive Labs the person is coordinator, manager or observer of (rl_0039).
  desks := array(select mt.trc_id from revive_members m join revive_member_trcs mt on mt.employee_id = m.employee_id
                  where m.employee_id = me and (m.is_coordinator or m.is_manager or m.is_observer));
  return array(
    select t.id from revive_tickets t
    where t.stakeholder_id = me or t.raised_by = me or t.engineer_id = me
       or t.stakeholder_id = any(team)
       or exists (select 1 from revive_handovers h where h.ticket_id = t.id and h.status = 'accepted' and h.from_id = any(team))
       or exists (select 1 from revive_approvals a where a.ticket_id = t.id and a.head_id = me)
       or t.trc_id = any(desks)
       or exists (select 1 from revive_transfers x where x.ticket_id = t.id and x.from_trc_id = any(desks))
       or exists (
            select 1 from revive_part_requests r
            join revive_member_trcs mt on mt.trc_id = r.trc_id
            join revive_members m on m.employee_id = mt.employee_id
            where r.ticket_id = t.id and revive_passed_to_purchase(r.route, r.status, r.declined_by, r.trc_id)
              and m.employee_id = me and m.is_purchase)
       or exists (select 1 from revive_handovers h where h.ticket_id = t.id and h.status = 'pending' and h.to_id = me));
end $$;
revoke all on function public.revive_visible_ids() from public, anon;
grant execute on function public.revive_visible_ids() to authenticated;

create or replace function public.revive_visible_events()
 returns table(ticket_id uuid, status text, trc_id uuid, at timestamp with time zone)
 language sql stable security definer set search_path to 'public' as $$
  select ev.ticket_id, ev.status, ev.trc_id, ev.at
  from revive_ticket_events ev
  where ev.kind = 'status' and ev.ticket_id = any((select revive_visible_ids())::uuid[])
  order by ev.ticket_id, ev.at, ev.id
$$;

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
  -- Whom it is shown to, worked out once for the whole list (rl_0067).
  where t.id = any((select revive_visible_ids())::uuid[])
  order by t.created_at desc
$function$;
