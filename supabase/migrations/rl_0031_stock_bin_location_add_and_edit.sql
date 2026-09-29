/*
  rl_0031 — stock: BIN and Location, one part added or edited at a time,
  and an upload that asks before it replaces.

  The user, 29 Sep, with the Revive Lab's own counting sheet (Cyrix- Part
  No, Value, Item, Type, BIN, Location, Qty): "the main thing we added is
  bin and location, so while trc eng request this data should also be
  shown and when coordinator also receives it, this data should be shown,
  so the coordinator can easily go and get the component requested."

  - revive_components.bin and .location, on the stock and on what an
    engineer takes from it — both lists the coordinator approves from.
  - revive_add_component: one part, its number suggested on the screen
    and changeable (the series has gaps). A number already there is
    refused, naming what it is.
  - revive_edit_component: any of it, the part number too while no other
    part has it; a changed quantity is a move, as an upload's is.
  - revive_upload_stock takes p_existing: 'replace' brings a part already
    in stock to the sheet, 'skip' leaves it and adds only the new ones.
    The screen asks which, listing them. BIN and Location are written only
    from a sheet that has them, so an older sheet leaves them alone.
*/

alter table public.revive_components
  add column if not exists bin text check (bin is null or length(bin) <= 40),
  add column if not exists location text check (location is null or length(location) <= 40);

comment on column public.revive_components.bin is 'The bin the part is kept in (the counting sheet''s BIN).';
comment on column public.revive_components.location is 'Where in the bin, or the rack (the counting sheet''s Location).';

-- ---------------------------------------------------------------------
-- The upload: replace what is already there, or skip it
-- ---------------------------------------------------------------------
drop function if exists public.revive_upload_stock(uuid, jsonb);

create function public.revive_upload_stock(p_trc_id uuid, p_rows jsonb, p_existing text default 'replace')
returns jsonb
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  me       uuid := current_employee_id();
  row_     jsonb;
  part     text;
  val      text;
  itm      text;
  pkg      text;
  bn       text;
  loc      text;
  q        integer;
  cur      revive_components;
  added    integer := 0;
  changed  integer := 0;
  same     integer := 0;
  skipped  integer := 0;
  seen     text[] := '{}';
begin
  if not (revive_runs_trc(p_trc_id) or revive_is_admin()) then
    raise exception 'Only a coordinator or manager of this Revive Lab can upload its stock';
  end if;
  if not exists (select 1 from revive_trcs where id = p_trc_id) then
    raise exception 'That Revive Lab does not exist';
  end if;
  if coalesce(p_existing, '') not in ('replace', 'skip') then
    raise exception 'Say whether parts already in stock are replaced or skipped';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The sheet has no parts in it';
  end if;
  if jsonb_array_length(p_rows) > 20000 then
    raise exception 'That is more than 20,000 parts — split the sheet';
  end if;

  for row_ in select value from jsonb_array_elements(p_rows) loop
    part := btrim(coalesce(row_->>'part_no', ''));
    continue when part = '';
    if length(part) > 40 then
      raise exception 'Part number % is longer than 40 characters', left(part, 40);
    end if;
    if lower(part) = any (seen) then
      raise exception 'Part % is in the sheet twice', part;
    end if;
    seen := seen || lower(part);
    val := left(nullif(btrim(coalesce(row_->>'value', '')), ''), 160);
    itm := left(nullif(btrim(coalesce(row_->>'item', '')), ''), 80);
    pkg := left(nullif(btrim(coalesce(row_->>'package', '')), ''), 40);
    bn  := left(nullif(btrim(coalesce(row_->>'bin', '')), ''), 40);
    loc := left(nullif(btrim(coalesce(row_->>'location', '')), ''), 40);
    begin
      q := (row_->>'qty')::integer;
    exception when others then
      raise exception 'Part % has a quantity that is not a whole number', part;
    end;
    if q is null or q < 0 then
      raise exception 'Part % has no usable quantity', part;
    end if;

    select * into cur from revive_components
     where trc_id = p_trc_id and lower(btrim(part_no)) = lower(part)
     for update;
    if not found then
      insert into revive_components (trc_id, part_no, value, item, package, bin, location, qty, updated_by)
      values (p_trc_id, part, val, itm, pkg, bn, loc, q, me)
      returning * into cur;
      insert into revive_component_moves (component_id, trc_id, kind, change, qty_after, actor_id)
      values (cur.id, p_trc_id, 'count', q, q, me);
      added := added + 1;
    else
      -- A sheet without the columns leaves them as they are.
      if not (row_ ? 'bin') then bn := cur.bin; end if;
      if not (row_ ? 'location') then loc := cur.location; end if;
      if cur.value is not distinct from val and cur.item is not distinct from itm
         and cur.package is not distinct from pkg and cur.bin is not distinct from bn
         and cur.location is not distinct from loc and cur.qty = q then
        same := same + 1;
      elsif p_existing = 'skip' then
        skipped := skipped + 1;
      else
        update revive_components
           set value = val, item = itm, package = pkg, bin = bn, location = loc, qty = q,
               updated_at = now(), updated_by = me
         where id = cur.id;
        if cur.qty <> q then
          insert into revive_component_moves (component_id, trc_id, kind, change, qty_after, actor_id)
          values (cur.id, p_trc_id, 'count', q - cur.qty, q, me);
        end if;
        changed := changed + 1;
      end if;
    end if;
  end loop;

  perform log_audit('revive_stock', p_trc_id, 'uploaded',
    jsonb_build_object('added', added, 'changed', changed, 'same', same, 'skipped', skipped, 'existing', p_existing));

  return jsonb_build_object(
    'added', added, 'changed', changed, 'same', same, 'skipped', skipped,
    'not_in_sheet', (select count(*) from revive_components
                     where trc_id = p_trc_id and lower(btrim(part_no)) <> all (seen)));
end $fn$;

revoke all on function public.revive_upload_stock(uuid, jsonb, text) from public, anon;
grant execute on function public.revive_upload_stock(uuid, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------
-- One part at a time: added, or edited
-- ---------------------------------------------------------------------
create or replace function public.revive_add_component(
  p_trc_id uuid, p_part_no text, p_value text, p_item text, p_package text,
  p_bin text, p_location text, p_qty integer)
returns uuid
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  me    uuid := current_employee_id();
  part  text := btrim(coalesce(p_part_no, ''));
  val   text := nullif(btrim(coalesce(p_value, '')), '');
  itm   text := nullif(btrim(coalesce(p_item, '')), '');
  taken revive_components;
  cur   revive_components;
begin
  if not (revive_runs_trc(p_trc_id) or revive_is_admin()) then
    raise exception 'Only a coordinator or manager of this Revive Lab can add to its stock';
  end if;
  if part = '' then raise exception 'Enter the part number'; end if;
  if length(part) > 40 then raise exception 'A part number is at most 40 characters'; end if;
  if val is null and itm is null then raise exception 'Enter the value or the item'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'Enter how many there are — 0 or more'; end if;
  select * into taken from revive_components
   where trc_id = p_trc_id and lower(btrim(part_no)) = lower(part);
  if found then
    raise exception 'Part number % already exists — it is %', taken.part_no,
      coalesce(concat_ws(' · ', taken.value, taken.item), 'another part');
  end if;

  insert into revive_components (trc_id, part_no, value, item, package, bin, location, qty, updated_by)
  values (p_trc_id, part, left(val, 160), left(itm, 80),
          left(nullif(btrim(coalesce(p_package, '')), ''), 40),
          left(nullif(btrim(coalesce(p_bin, '')), ''), 40),
          left(nullif(btrim(coalesce(p_location, '')), ''), 40),
          p_qty, me)
  returning * into cur;
  insert into revive_component_moves (component_id, trc_id, kind, change, qty_after, actor_id)
  values (cur.id, p_trc_id, 'count', p_qty, p_qty, me);
  perform log_audit('revive_stock', p_trc_id, 'added',
    jsonb_build_object('component_id', cur.id, 'part_no', part, 'qty', p_qty));
  return cur.id;
end $fn$;

revoke all on function public.revive_add_component(uuid, text, text, text, text, text, text, integer) from public, anon;
grant execute on function public.revive_add_component(uuid, text, text, text, text, text, text, integer) to authenticated;

create or replace function public.revive_edit_component(
  p_component_id uuid, p_part_no text, p_value text, p_item text, p_package text,
  p_bin text, p_location text, p_qty integer)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  me    uuid := current_employee_id();
  part  text := btrim(coalesce(p_part_no, ''));
  val   text := nullif(btrim(coalesce(p_value, '')), '');
  itm   text := nullif(btrim(coalesce(p_item, '')), '');
  cur   revive_components;
  taken revive_components;
begin
  select * into cur from revive_components where id = p_component_id for update;
  if not found then raise exception 'That part is no longer in the stock'; end if;
  if not (revive_runs_trc(cur.trc_id) or revive_is_admin()) then
    raise exception 'Only a coordinator or manager of this Revive Lab can change its stock';
  end if;
  if part = '' then raise exception 'Enter the part number'; end if;
  if length(part) > 40 then raise exception 'A part number is at most 40 characters'; end if;
  if val is null and itm is null then raise exception 'Enter the value or the item'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'Enter how many there are — 0 or more'; end if;
  select * into taken from revive_components
   where trc_id = cur.trc_id and lower(btrim(part_no)) = lower(part) and id <> cur.id;
  if found then
    raise exception 'Part number % already exists — it is %', taken.part_no,
      coalesce(concat_ws(' · ', taken.value, taken.item), 'another part');
  end if;

  update revive_components
     set part_no = part, value = left(val, 160), item = left(itm, 80),
         package = left(nullif(btrim(coalesce(p_package, '')), ''), 40),
         bin = left(nullif(btrim(coalesce(p_bin, '')), ''), 40),
         location = left(nullif(btrim(coalesce(p_location, '')), ''), 40),
         qty = p_qty, updated_at = now(), updated_by = me
   where id = cur.id;
  if cur.qty <> p_qty then
    insert into revive_component_moves (component_id, trc_id, kind, change, qty_after, actor_id)
    values (cur.id, cur.trc_id, 'count', p_qty - cur.qty, p_qty, me);
  end if;
  perform log_audit('revive_stock', cur.trc_id, 'edited',
    jsonb_build_object('component_id', cur.id,
      'before', jsonb_build_object('part_no', cur.part_no, 'value', cur.value, 'item', cur.item, 'package', cur.package,
                                   'bin', cur.bin, 'location', cur.location, 'qty', cur.qty)));
end $fn$;

revoke all on function public.revive_edit_component(uuid, text, text, text, text, text, text, integer) from public, anon;
grant execute on function public.revive_edit_component(uuid, text, text, text, text, text, text, integer) to authenticated;

-- ---------------------------------------------------------------------
-- Where it is, on what an engineer took: the ticket's list and the desk's
-- ---------------------------------------------------------------------
drop function if exists public.revive_component_uses(uuid);
create function public.revive_component_uses(p_ticket_id uuid)
returns table (
  id uuid, component_id uuid, part_no text, value text, item text, package text, qty integer,
  status text, source text, in_stock integer,
  requested_by uuid, requested_by_name text, requested_at timestamptz,
  decided_by_name text, decided_at timestamptz, decision_note text,
  bin text, location text
)
language sql stable security definer set search_path to 'public'
as $fn$
  select u.id, u.component_id, c.part_no, c.value, c.item, c.package, u.qty,
         u.status, u.source, c.qty,
         u.requested_by, rq.full_name, u.requested_at,
         dc.full_name, u.decided_at, u.decision_note,
         c.bin, c.location
  from revive_stock_uses u
  join revive_components c on c.id = u.component_id
  left join employees rq on rq.id = u.requested_by
  left join employees dc on dc.id = u.decided_by
  where u.ticket_id = p_ticket_id and revive_can_see(p_ticket_id)
  order by u.requested_at
$fn$;
revoke execute on function public.revive_component_uses(uuid) from public, anon;
grant execute on function public.revive_component_uses(uuid) to authenticated;

drop function if exists public.revive_stock_use_list(text);
create function public.revive_stock_use_list(p_status text default null)
returns table (
  id uuid, ticket_id uuid, ticket_code text, ticket_status text, facility text,
  trc_id uuid, trc_name text,
  component_id uuid, part_no text, value text, item text, package text, in_stock integer,
  qty integer, status text, source text,
  requested_by uuid, requested_by_name text, requested_at timestamptz,
  decided_by_name text, decided_at timestamptz, decision_note text,
  bin text, location text
)
language sql stable security definer set search_path to 'public'
as $fn$
  select u.id, u.ticket_id, t.code, t.status, t.facility,
         u.trc_id, trc.name,
         u.component_id, c.part_no, c.value, c.item, c.package, c.qty,
         u.qty, u.status, u.source,
         u.requested_by, rq.full_name, u.requested_at,
         dc.full_name, u.decided_at, u.decision_note,
         c.bin, c.location
  from revive_stock_uses u
  join revive_tickets t on t.id = u.ticket_id
  join revive_trcs trc on trc.id = u.trc_id
  join revive_components c on c.id = u.component_id
  left join employees rq on rq.id = u.requested_by
  left join employees dc on dc.id = u.decided_by
  where (p_status is null or u.status = p_status)
    and revive_can_see(u.ticket_id)
  order by u.requested_at desc
$fn$;
revoke execute on function public.revive_stock_use_list(text) from public, anon;
grant execute on function public.revive_stock_use_list(text) to authenticated;
