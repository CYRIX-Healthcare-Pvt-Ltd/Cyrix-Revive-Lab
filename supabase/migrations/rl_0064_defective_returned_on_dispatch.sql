-- Revive Lab · rl_0064 · defective returned, on dispatch, when a PI was asked for
-- The user, 31 Oct: "whichever tickets pi is requested, so for that tickets, on dispatch, we need a field ie defective
-- returned (mandatory) yes/ no, default blank". Kept on the ticket and said in the dispatch step of the history.

alter table public.revive_tickets add column if not exists defective_returned boolean;

drop function if exists public.revive_dispatch(uuid, text, text, date, text, numeric, text);
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
  -- A PI was asked for on it: whether the defective went back is said on dispatch (rl_0064).
  pi     boolean := exists (select 1 from revive_ticket_events e where e.ticket_id = t.id and e.status = 'pi_requested');
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
  if pi and p_defective_returned is null then
    raise exception 'Choose whether the defective was returned';
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
      defective_returned = case when pi then p_defective_returned else defective_returned end,
      updated_at = now()
  where id = t.id;
  perform revive_log(t.id, 'in_transit_return', t.status, t.trc_id,
    concat_ws(' · ', case when to_oem then 'To the OEM: ' || oem end, said,
      case when pi then 'Defective returned: ' || case when p_defective_returned then 'Yes' else 'No' end end,
      nullif(btrim(coalesce(p_note, '')), '')));
end $function$;
revoke all on function public.revive_dispatch(uuid, text, text, date, text, numeric, text, boolean) from public, anon;
grant execute on function public.revive_dispatch(uuid, text, text, date, text, numeric, text, boolean) to authenticated, service_role;
