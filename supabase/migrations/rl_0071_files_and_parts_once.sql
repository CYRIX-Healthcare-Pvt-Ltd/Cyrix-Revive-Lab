-- =====================================================================
-- Revive Lab · rl_0071 · A ticket's files and the part requests list, without
--                        asking "can I see it?" once per row
--
-- 20 Nov: the shared database ran out of memory at the morning rush (09:41).
-- Measured after:
--  * Opening a ticket listed its folder through storage's own search, which
--    took 0.2–0.45 s and up to 21,000 blocks to find 1–4 files (175 opens in
--    35 minutes, the heaviest work on the database). revive_ticket_files(id)
--    asks the same question as the bucket's read rule (is the ticket among the
--    person's — revive_visible_ids, rl_0067) once, and reads that one folder.
--  * revive_part_request_list asked revive_can_see for each of 142 requests:
--    up to 0.64 s. It now works the person's tickets out once.
-- Who sees what is exactly as before.
-- =====================================================================

-- The files directly in a ticket's folder (no sub-folders), for whoever may see the ticket.
create or replace function public.revive_ticket_files(p_ticket_id uuid)
returns table (name text)
language sql stable security definer set search_path = public, storage as $$
  select substr(o.name, 38)
  from storage.objects o
  where p_ticket_id = any((select revive_visible_ids())::uuid[])
    and o.bucket_id = 'revive-attachments'
    and o.name collate "C" >= (p_ticket_id::text || '/') collate "C"
    and o.name collate "C" < (p_ticket_id::text || '0') collate "C"
    and position('/' in substr(o.name, 38)) = 0
    and o.archived_at is null and not coalesce(o.is_delete_marker, false)
  order by 1
$$;
revoke all on function public.revive_ticket_files(uuid) from public, anon;
grant execute on function public.revive_ticket_files(uuid) to authenticated, service_role;

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
    -- The person's tickets worked out once (rl_0071), not "can I see it?" asked per request.
    and case when r.ticket_id is not null then r.ticket_id = any((select revive_visible_ids())::uuid[]) else revive_can_see_part(r.id) end
  order by r.requested_at desc
$function$;
