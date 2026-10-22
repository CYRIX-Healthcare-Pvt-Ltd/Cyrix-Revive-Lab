-- Revive Lab · rl_0056 · the order carries an item code
-- The user, 22 Oct: Purchase entering the order gives the item code too, required, before the vendor's name.
-- The order it went into is shown with it. The old five-argument revive_order_part stays for the app already live
-- until this one is deployed.

alter table public.revive_part_requests add column if not exists item_code text
  check (item_code is null or length(item_code) <= 60);

CREATE OR REPLACE FUNCTION public.revive_order_part(p_request_id uuid, p_po_number text, p_po_date date, p_edd date, p_vendor text, p_item_code text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r   revive_part_requests := revive_lock_part(p_request_id);
  po  text := btrim(coalesce(p_po_number, ''));
  who text := btrim(coalesce(p_vendor, ''));
  ic  text := btrim(coalesce(p_item_code, ''));
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
  if length(ic) < 1 then raise exception 'Enter the item code'; end if;
  if length(ic) > 60 then raise exception 'An item code is at most 60 characters'; end if;
  if length(who) < 2 then raise exception 'Enter the vendor''s name'; end if;
  if length(who) > 120 then raise exception 'Keep the vendor''s name under 120 characters'; end if;

  update revive_part_requests
     set status = 'bought',
         accepted_by = coalesce(accepted_by, current_employee_id()),
         accepted_at = coalesce(accepted_at, now()),
         purchased_by = current_employee_id(), purchased_at = now(),
         po_number = po, po_date = p_po_date, edd = p_edd, item_code = ic, vendor = who,
         updated_at = now()
   where id = r.id;
  perform revive_part_step(r, 'ordered',
    revive_part_label(r) || ' · PO ' || po || ' · item ' || ic || ' · ' || who || ' · due ' || to_char(p_edd, 'DD Mon YYYY'));
end $function$
;
revoke all on function public.revive_order_part(uuid, text, date, date, text, text) from public, anon;
grant execute on function public.revive_order_part(uuid, text, date, date, text, text) to authenticated;

drop function public.revive_part_request_list(uuid);
CREATE OR REPLACE FUNCTION public.revive_part_request_list(p_ticket_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, ticket_id uuid, ticket_code text, ticket_status text, facility text, trc_id uuid, trc_name text, route text, name text, qty integer, note text, link text, photo_path text, status text, bill_amount numeric, bill_no text, vendor text, bill_paths text[], requested_by uuid, requested_by_name text, requested_at timestamp with time zone, accepted_by_name text, accepted_at timestamp with time zone, declined_by_name text, declined_at timestamp with time zone, declined_reason text, purchased_by_name text, purchased_at timestamp with time zone, received_by_name text, received_at timestamp with time zone, component_id uuid, part_no text, value text, item text, package text, bought_qty integer, stocked_by_name text, stocked_at timestamp with time zone, progress text, progress_by_name text, progress_at timestamp with time zone, po_number text, po_date date, edd date, number integer, code text, events jsonb, item_code text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
         r.po_number, r.po_date, r.edd,
         r.number, r.code,
         -- What the columns do not hold for a request without a ticket: passed on, handed back, cancelled, and why.
         case when r.ticket_id is null then coalesce((
           select jsonb_agg(jsonb_build_object('action', ev.action, 'at', ev.at, 'who', ev_e.full_name, 'note', ev.note) order by ev.at, ev.id)
             from revive_part_events ev left join employees ev_e on ev_e.id = ev.actor_id
            where ev.request_id = r.id), '[]'::jsonb) else '[]'::jsonb end,
         r.item_code
  from revive_part_requests r
  left join revive_tickets t on t.id = r.ticket_id
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
    and case when r.ticket_id is not null then revive_can_see(r.ticket_id) else revive_can_see_part(r.id) end
  order by r.requested_at desc
$function$
;
revoke all on function public.revive_part_request_list(uuid) from public, anon;
grant execute on function public.revive_part_request_list(uuid) to authenticated;
