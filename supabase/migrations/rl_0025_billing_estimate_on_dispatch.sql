/*
  rl_0025 — the estimated billing cost, when a Pvt spare is dispatched back.

  Under a private contract the customer can be asked to pay for what went
  into the repair, so before the coordinator dispatches a Pvt spare back
  they enter the estimated billing cost (the user, 23 Sep). It is required
  there and only there — under a BEMMP that asks Billing spare, which is
  Pvt — and it is kept on the ticket and said in the dispatch step.

  - revive_tickets.billing_estimate: rupees, two decimals.
  - revive_dispatch takes p_billing_estimate; an app without it still
    dispatches every other ticket.
  - revive_ticket_list carries it, and whether the ticket asks for it.
*/

alter table public.revive_tickets
  add column if not exists billing_estimate numeric(12, 2);

alter table public.revive_tickets
  add constraint revive_tickets_billing_estimate_check
    check (billing_estimate is null or billing_estimate between 0 and 10000000);

-- ---------------------------------------------------------------------
-- Dispatching back: a Pvt spare says what the customer is to be billed
-- ---------------------------------------------------------------------
drop function if exists public.revive_dispatch(uuid, text, text, date, text);

create function public.revive_dispatch(
  p_ticket_id uuid, p_courier text, p_awb text, p_dispatched_on date,
  p_note text default null, p_billing_estimate numeric default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t     revive_tickets := revive_lock(p_ticket_id);
  asks  boolean := coalesce((select bp.asks_billing from revive_bemmp_projects bp where bp.id = t.bemmp_id), false);
  said  text;
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator or manager of this Revive Lab can dispatch it';
  end if;
  if t.status not in ('repaired', 'not_repairable', 'service_denied') then
    raise exception 'Close the repair before dispatching it';
  end if;
  if t.status = 'not_repairable' and t.proposal = 'scrap' then
    raise exception 'The engineer proposed scrap — move it to scrap';
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
      updated_at = now()
  where id = t.id;
  perform revive_log(t.id, 'in_transit_return', t.status, t.trc_id,
    concat_ws(' · ', said, nullif(btrim(coalesce(p_note, '')), '')));
end $fn$;

revoke all on function public.revive_dispatch(uuid, text, text, date, text, numeric) from public, anon;
grant execute on function public.revive_dispatch(uuid, text, text, date, text, numeric) to authenticated;

-- ---------------------------------------------------------------------
-- The ticket list: the estimate, and whether the ticket asks for one
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
  equipment_make text, equipment_model text, done_voice text, source text, warehouse_id uuid,
  spare_category text, criticality text, contract_type text, accepted_at timestamptz, dispatched_at timestamptz,
  billing_estimate numeric, asks_billing_estimate boolean)
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
         t.equipment_make, t.equipment_model, t.done_voice,
         t.source, t.warehouse_id,
         t.spare_category, t.criticality, t.contract_type, t.accepted_at,
         -- The end of the Revive Lab's TAT: the first time it was dispatched back.
         (select min(ev.at) from revive_ticket_events ev
           where ev.ticket_id = t.id and ev.kind = 'status' and ev.status = 'in_transit_return'),
         t.billing_estimate,
         coalesce(bp.asks_billing, false)
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
