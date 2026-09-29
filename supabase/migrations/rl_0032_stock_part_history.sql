/*
  rl_0032 — a part's history.

  The user, 29 Sep: "on click part no, we need a history, ie when added,
  who added, who edited etc, that kind of small details."

  - revive_component_log: each part added or edited — by hand or by a
    stock sheet — who, when, and each field that changed, from and to.
    Written by revive_add_component, revive_edit_component and
    revive_upload_stock, which are otherwise as rl_0031 left them.
  - revive_component_history(part): that log, and what was already on
    record — every stock count (the sheets uploaded before this log),
    every time an engineer asked for it for a ticket and what the
    coordinator said, and every purchase added into it — newest first.
    For whoever works at the part's Revive Lab, and admins.
*/

create table if not exists public.revive_component_log (
  id            bigint generated always as identity primary key,
  component_id  uuid not null references public.revive_components(id) on delete cascade,
  trc_id        uuid not null references public.revive_trcs(id) on delete cascade,
  at            timestamptz not null default now(),
  actor_id      uuid references public.employees(id) on delete set null,
  action        text not null check (action in ('added', 'edited', 'sheet_added', 'sheet_replaced')),
  -- Each field that changed: {"bin": ["B1", "B2"], "qty": [4, 6]} — from, to.
  changes       jsonb not null default '{}'::jsonb
);
create index if not exists revive_component_log_part on public.revive_component_log (component_id, at);

comment on table public.revive_component_log is
  'Each Revive Lab stock part added or edited, by hand or by a stock sheet: who, when, and each field from and to (rl_0032).';

-- Read only through revive_component_history.
alter table public.revive_component_log enable row level security;
revoke all on public.revive_component_log from public, anon, authenticated;

/** {field: [from, to]} for each field that differs; a new part is everything from null. */
create or replace function public.revive_part_changes(
  b_part text, b_val text, b_itm text, b_pkg text, b_bin text, b_loc text, b_qty integer,
  a_part text, a_val text, a_itm text, a_pkg text, a_bin text, a_loc text, a_qty integer)
returns jsonb
language sql immutable
as $fn$
  select jsonb_strip_nulls(jsonb_build_object(
    'part_no',  case when b_part is distinct from a_part then jsonb_build_array(b_part, a_part) end,
    'value',    case when b_val  is distinct from a_val  then jsonb_build_array(b_val, a_val) end,
    'item',     case when b_itm  is distinct from a_itm  then jsonb_build_array(b_itm, a_itm) end,
    'package',  case when b_pkg  is distinct from a_pkg  then jsonb_build_array(b_pkg, a_pkg) end,
    'bin',      case when b_bin  is distinct from a_bin  then jsonb_build_array(b_bin, a_bin) end,
    'location', case when b_loc  is distinct from a_loc  then jsonb_build_array(b_loc, a_loc) end,
    'qty',      case when b_qty  is distinct from a_qty  then jsonb_build_array(b_qty, a_qty) end))
$fn$;
revoke all on function public.revive_part_changes(text, text, text, text, text, text, integer, text, text, text, text, text, text, integer) from public, anon;

-- ---------------------------------------------------------------------
-- The upload, logging each part it adds or replaces
-- ---------------------------------------------------------------------
create or replace function public.revive_upload_stock(p_trc_id uuid, p_rows jsonb, p_existing text default 'replace')
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
      insert into revive_component_log (component_id, trc_id, actor_id, action, changes)
      values (cur.id, p_trc_id, me, 'sheet_added',
              revive_part_changes(null, null, null, null, null, null, null, part, val, itm, pkg, bn, loc, q));
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
        insert into revive_component_log (component_id, trc_id, actor_id, action, changes)
        values (cur.id, p_trc_id, me, 'sheet_replaced',
                revive_part_changes(cur.part_no, cur.value, cur.item, cur.package, cur.bin, cur.location, cur.qty,
                                    cur.part_no, val, itm, pkg, bn, loc, q));
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

-- ---------------------------------------------------------------------
-- One part added, or edited — logged
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
  insert into revive_component_log (component_id, trc_id, actor_id, action, changes)
  values (cur.id, p_trc_id, me, 'added',
          revive_part_changes(null, null, null, null, null, null, null,
                              cur.part_no, cur.value, cur.item, cur.package, cur.bin, cur.location, cur.qty));
  perform log_audit('revive_stock', p_trc_id, 'added',
    jsonb_build_object('component_id', cur.id, 'part_no', part, 'qty', p_qty));
  return cur.id;
end $fn$;

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
  now_  revive_components;
  taken revive_components;
  chg   jsonb;
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
   where id = cur.id
  returning * into now_;
  if cur.qty <> p_qty then
    insert into revive_component_moves (component_id, trc_id, kind, change, qty_after, actor_id)
    values (cur.id, cur.trc_id, 'count', p_qty - cur.qty, p_qty, me);
  end if;
  chg := revive_part_changes(cur.part_no, cur.value, cur.item, cur.package, cur.bin, cur.location, cur.qty,
                             now_.part_no, now_.value, now_.item, now_.package, now_.bin, now_.location, now_.qty);
  -- Saved with nothing changed says nothing.
  if chg <> '{}'::jsonb then
    insert into revive_component_log (component_id, trc_id, actor_id, action, changes)
    values (cur.id, cur.trc_id, me, 'edited', chg);
  end if;
  perform log_audit('revive_stock', cur.trc_id, 'edited',
    jsonb_build_object('component_id', cur.id,
      'before', jsonb_build_object('part_no', cur.part_no, 'value', cur.value, 'item', cur.item, 'package', cur.package,
                                   'bin', cur.bin, 'location', cur.location, 'qty', cur.qty)));
end $fn$;

-- ---------------------------------------------------------------------
-- The history
-- ---------------------------------------------------------------------
create or replace function public.revive_component_history(p_component_id uuid)
returns table (
  at timestamptz, kind text, who text, who_ecode text, ticket_code text, qty integer, qty_after integer,
  changes jsonb, note text
)
language sql stable security definer set search_path to 'public'
as $fn$
  with c as (
    select * from revive_components
     where id = p_component_id and (revive_in_trc(trc_id) or revive_is_admin())
  )
  -- Added or edited, by hand or by a sheet.
  -- Each with the person's name and E-code: "if any doubt we can see who updated it" (the user).
  select l.at, l.action, e.full_name, e.ecode, null::text, null::integer, null::integer, l.changes, null::text
    from revive_component_log l join c on c.id = l.component_id
    left join employees e on e.id = l.actor_id
  union all
  -- Counted by a sheet before the log began: the quantity it was set to.
  select m.at, 'counted', e.full_name, e.ecode, null, m.change, m.qty_after, null, null
    from revive_component_moves m join c on c.id = m.component_id
    left join employees e on e.id = m.actor_id
   where m.kind = 'count'
     and not exists (select 1 from revive_component_log l where l.component_id = m.component_id and l.at = m.at)
  union all
  -- Asked for, for a repair.
  select u.requested_at, 'requested', rq.full_name, rq.ecode, t.code, u.qty, null, null, null
    from revive_stock_uses u join c on c.id = u.component_id
    join revive_tickets t on t.id = u.ticket_id
    left join employees rq on rq.id = u.requested_by
   where u.source = 'stock'
  union all
  -- What the coordinator said, or the engineer taking it back.
  select u.decided_at, u.status, dc.full_name, dc.ecode, t.code, u.qty,
         (select m.qty_after from revive_component_moves m
           where m.component_id = u.component_id and m.kind = 'use' and m.ticket_id = u.ticket_id and m.at = u.decided_at
           limit 1),
         null, u.decision_note
    from revive_stock_uses u join c on c.id = u.component_id
    join revive_tickets t on t.id = u.ticket_id
    left join employees dc on dc.id = u.decided_by
   where u.decided_at is not null and u.status <> 'requested' and u.source = 'stock'
  union all
  -- Purchased for a repair, and put into this part.
  select r.stocked_at, 'purchased', sb.full_name, sb.ecode, t.code, r.bought_qty, null, null, null
    from revive_part_requests r join c on c.id = r.component_id
    join revive_tickets t on t.id = r.ticket_id
    left join employees sb on sb.id = r.stocked_by
   where r.stocked_at is not null
  order by 1 desc
$fn$;

revoke all on function public.revive_component_history(uuid) from public, anon;
grant execute on function public.revive_component_history(uuid) to authenticated;
