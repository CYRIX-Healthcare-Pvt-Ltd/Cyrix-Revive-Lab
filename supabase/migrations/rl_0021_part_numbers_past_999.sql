/*
  rl_0021 — part numbers past C-999, and one part per number.

  revive_part_no_for padded the next number with lpad(n, 3, '0'), and lpad
  also cuts a longer string down to three: Cochin's stock runs to C-1328,
  so the next number, 1329, came out as C-132 — a MOSFET already on the
  shelf. revive_stock_part then added what was bought to that part.

  - The next number is padded to three digits and never cut: C-007, C-999,
    C-1329.
  - revive_stock_part refuses to add a part to a number that is already a
    different part: the value must be that part's (spaces and case aside).
    Adding more of the same part under its number is what the number is for.
*/

create or replace function public.revive_part_no_for(p_trc_id uuid, p_value text, p_item text)
returns text
language sql stable security definer set search_path to 'public'
as $fn$
  select coalesce(
    (select c.part_no from revive_components c
      where c.trc_id = p_trc_id
        and lower(btrim(coalesce(c.value, ''))) = lower(btrim(coalesce(p_value, '')))
        and lower(btrim(coalesce(c.item, ''))) = lower(btrim(coalesce(p_item, '')))
        and btrim(coalesce(p_value, '')) <> ''
      order by c.part_no limit 1),
    (select 'C-' || case when n < 1000 then lpad(n::text, 3, '0') else n::text end
       from (select coalesce(max((regexp_replace(c.part_no, '\D', '', 'g'))::bigint), 0) + 1 as n
               from revive_components c
              where c.trc_id = p_trc_id and c.part_no ~ '^[A-Za-z]*-?[0-9]+$') next))
$fn$;

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
end $fn$;
