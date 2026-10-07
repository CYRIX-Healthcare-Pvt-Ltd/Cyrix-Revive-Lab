-- =====================================================================
-- Revive Lab · rl_0045 · BIN and Location when a purchase goes into stock
--
-- The user, 7 Oct, at Add PR-01 to stock: "while adding to stock, where is
-- the bin, location field?". Adding to stock from a purchase predates
-- BIN and Location (rl_0031), on a ticket's request and a PR's alike.
--
-- A new part takes the BIN and Location typed. A part already in stock
-- keeps its own unless the coordinator changes them — and a change moves
-- the part, written into its history as an edit would be. Both stay
-- optional, as on Add stock, and are cut at 40 characters as there.
--
-- Two parameters at the end, with defaults, so a call without them goes
-- on as before; the old signature is dropped so the two cannot be
-- confused. The function is the live one with the change swapped in
-- (make_rl0045.mjs).
-- =====================================================================

drop function if exists public.revive_stock_part(uuid, text, text, text, text, integer, integer);

CREATE OR REPLACE FUNCTION public.revive_stock_part(p_request_id uuid, p_value text, p_item text, p_package text, p_part_no text DEFAULT NULL::text, p_qty integer DEFAULT NULL::integer, p_use_qty integer DEFAULT NULL::integer, p_bin text DEFAULT NULL::text, p_location text DEFAULT NULL::text)
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
  -- Without a ticket there is no repair to take any (rl_0044): all of it stays in stock.
  used    integer := case when r.ticket_id is null then 0 else coalesce(p_use_qty, r.qty) end;
  c       revive_components;
  -- Where it is kept (rl_0045): typed for a new part; for one already in stock, its own unless changed.
  new_bin text := left(nullif(btrim(coalesce(p_bin, '')), ''), 40);
  new_loc text := left(nullif(btrim(coalesce(p_location, '')), ''), 40);
  chg     jsonb;
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
    insert into revive_components (trc_id, part_no, value, item, package, bin, location, qty, updated_by)
    values (r.trc_id, part, val, itm, pkg, new_bin, new_loc, bought, current_employee_id())
    returning * into c;
  else
    -- A BIN or Location changed here moves the part: it goes into its history as an edit would.
    chg := revive_part_changes(c.part_no, c.value, c.item, c.package, c.bin, c.location, c.qty,
                               c.part_no, c.value, c.item, c.package, coalesce(new_bin, c.bin), coalesce(new_loc, c.location), c.qty);
    update revive_components
       set qty = qty + bought,
           value = coalesce(c.value, val), item = coalesce(c.item, itm), package = coalesce(c.package, pkg),
           bin = coalesce(new_bin, c.bin), location = coalesce(new_loc, c.location),
           updated_at = now(), updated_by = current_employee_id()
     where id = c.id
    returning * into c;
    if chg <> '{}'::jsonb then
      insert into revive_component_log (component_id, trc_id, actor_id, action, changes)
      values (c.id, c.trc_id, current_employee_id(), 'edited', chg);
    end if;
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
     set status = case when r.ticket_id is null then 'stocked' else 'sent' end, component_id = c.id, bought_qty = bought,
         stocked_by = current_employee_id(), stocked_at = now(), updated_at = now()
   where id = r.id;
  perform revive_part_step(r, 'stocked',
    revive_part_label(r) || ' · ' || bought || ' into stock as ' || c.part_no
      || case when used > 0 then ', ' || used || ' for this repair' else '' end);
end $function$;

revoke execute on function public.revive_stock_part(uuid, text, text, text, text, integer, integer, text, text) from public, anon;
grant execute on function public.revive_stock_part(uuid, text, text, text, text, integer, integer, text, text) to authenticated;
