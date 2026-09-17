-- =====================================================================
-- rl_0013 — components, purchase, how a repair ends, the expected date
-- =====================================================================
--
-- Components. Each Revive Lab keeps a stock of components, uploaded by its
-- coordinator from the stock sheet. An engineer repairing a spare takes
-- what they need from that stock, and it comes off. What is not in stock
-- they request: a local purchase goes to the Revive Lab's coordinator, a
-- purchase to whoever holds the new Purchase role for that Revive Lab.
-- That person accepts it, buys it, attaches the bill and its amount, and
-- sends it to the engineer, who confirms the purchase and carries on.
-- While anything is being bought the ticket says so — Component requested,
-- Purchasing, Component ready — and it goes back to In repair once the
-- engineer has confirmed everything that was bought. Every step is in the
-- history, so the field engineer can see where it stands without asking.
--
-- How a repair ends. The engineer closes it as Repaired, Not repairable or
-- Customer denied service. A spare that cannot be repaired waits for the
-- coordinator, who either moves it to scrap — which closes the ticket —
-- or dispatches it back as usual; the other two are dispatched back.
--
-- And the expected date. When the engineer accepts a repair they say when
-- they expect it done, and can move the date later; the field engineer
-- waits for that date instead of chasing.

-- ---------------------------------------------------------------------
-- The Purchase role
-- ---------------------------------------------------------------------
alter table public.revive_members
  add column if not exists is_purchase boolean not null default false;

drop function if exists public.revive_me();
create function public.revive_me()
returns table (
  employee_id uuid, is_engineer boolean, is_coordinator boolean,
  is_manager boolean, is_admin boolean, is_sw_admin boolean, trc_ids uuid[],
  is_purchase boolean
)
language sql stable security definer set search_path to 'public'
as $fn$
  select
    e.id,
    coalesce(m.is_engineer, false),
    coalesce(m.is_coordinator, false),
    coalesce(m.is_manager, false),
    coalesce(m.is_admin, false) or is_sw_admin(),
    is_sw_admin(),
    coalesce((select array_agg(mt.trc_id) from revive_member_trcs mt
              where mt.employee_id = e.id), '{}'),
    coalesce(m.is_purchase, false)
  from employees e
  left join revive_members m on m.employee_id = e.id
  where e.id = current_employee_id()
$fn$;
grant execute on function public.revive_me() to authenticated;

drop function if exists public.revive_member_list();
create function public.revive_member_list()
returns table (
  employee_id uuid, ecode text, full_name text, designation text,
  is_engineer boolean, is_coordinator boolean, is_manager boolean, is_admin boolean,
  trc_ids uuid[], updated_at timestamptz, updated_by_name text, is_purchase boolean
)
language sql stable security definer set search_path to 'public'
as $fn$
  select m.employee_id, e.ecode, e.full_name, e.designation,
         m.is_engineer, m.is_coordinator, m.is_manager, m.is_admin,
         coalesce((select array_agg(mt.trc_id order by mt.trc_id) from revive_member_trcs mt
                   where mt.employee_id = m.employee_id), '{}'),
         m.updated_at, u.full_name, m.is_purchase
  from revive_members m
  join employees e on e.id = m.employee_id
  left join employees u on u.id = m.updated_by
  where revive_has_access()
  order by e.full_name
$fn$;
grant execute on function public.revive_member_list() to authenticated;

/*
  One person's boxes and labs. p_purchase comes last and may be left out —
  a screen from before the Purchase role keeps whatever the person has.
*/
drop function if exists public.revive_save_member(uuid, boolean, boolean, boolean, boolean, uuid[]);
create function public.revive_save_member(
  p_employee_id uuid,
  p_engineer boolean, p_coordinator boolean, p_manager boolean, p_admin boolean,
  p_trc_ids uuid[],
  p_purchase boolean default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  me       uuid := current_employee_id();
  purchase boolean := coalesce(p_purchase,
                        (select m.is_purchase from revive_members m where m.employee_id = p_employee_id),
                        false);
begin
  if not revive_is_admin() then
    raise exception 'Only a Revive Lab admin can change who does what';
  end if;
  if not exists (select 1 from employees where id = p_employee_id) then
    raise exception 'That employee does not exist';
  end if;
  if p_employee_id = me and not is_sw_admin() and not coalesce(p_admin, false) then
    raise exception 'You cannot remove your own admin box — ask another admin';
  end if;
  if exists (select 1 from unnest(coalesce(p_trc_ids, '{}')) x
             where x not in (select id from revive_trcs)) then
    raise exception 'One of those Revive Labs does not exist';
  end if;

  if not (p_engineer or p_coordinator or p_manager or p_admin or purchase)
     and coalesce(array_length(p_trc_ids, 1), 0) = 0 then
    delete from revive_members where employee_id = p_employee_id;
    perform log_audit('revive_member', p_employee_id, 'removed', '{}'::jsonb);
    return;
  end if;

  insert into revive_members (employee_id, is_engineer, is_coordinator, is_manager, is_admin, is_purchase, updated_at, updated_by)
  values (p_employee_id, p_engineer, p_coordinator, p_manager, p_admin, purchase, now(), me)
  on conflict (employee_id) do update
  set is_engineer = excluded.is_engineer,
      is_coordinator = excluded.is_coordinator,
      is_manager = excluded.is_manager,
      is_admin = excluded.is_admin,
      is_purchase = excluded.is_purchase,
      updated_at = now(),
      updated_by = me;

  delete from revive_member_trcs
  where employee_id = p_employee_id
    and trc_id <> all (coalesce(p_trc_ids, '{}'));
  insert into revive_member_trcs (employee_id, trc_id)
  select p_employee_id, x from unnest(coalesce(p_trc_ids, '{}')) x
  on conflict do nothing;

  if exists (select 1 from app_modules where code = 'revive') then
    insert into employee_modules (employee_id, module_code, granted_by)
    values (p_employee_id, 'revive', me)
    on conflict do nothing;
  end if;

  perform log_audit('revive_member', p_employee_id, 'saved', jsonb_build_object(
    'engineer', p_engineer, 'coordinator', p_coordinator, 'manager', p_manager,
    'admin', p_admin, 'purchase', purchase, 'trcs', to_jsonb(coalesce(p_trc_ids, '{}'))));
end $fn$;
grant execute on function public.revive_save_member(uuid, boolean, boolean, boolean, boolean, uuid[], boolean) to authenticated;

/** Buys for a Revive Lab: the Purchase box and that Revive Lab ticked. */
create or replace function public.revive_buys_for(p_trc_id uuid)
returns boolean
language sql stable security definer set search_path to 'public'
as $fn$
  select exists (
    select 1 from revive_members m
    join revive_member_trcs mt on mt.employee_id = m.employee_id
    where m.employee_id = current_employee_id()
      and mt.trc_id = p_trc_id
      and m.is_purchase
  )
$fn$;
grant execute on function public.revive_buys_for(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- The ticket: new statuses, how it ended, the expected date
-- ---------------------------------------------------------------------
alter table public.revive_tickets drop constraint if exists revive_tickets_status_check;
alter table public.revive_tickets add constraint revive_tickets_status_check check (status in (
  'pending_acceptance', 'accepted', 'assigned', 'in_repair',
  'parts_requested',    -- a component was requested; nobody has taken it on yet
  'parts_ordered',      -- accepted, being bought
  'parts_ready',        -- bought and sent to the engineer, who has not confirmed it yet
  'repaired',           -- closed as repaired, waiting to be dispatched
  'not_repairable',     -- closed as not repairable: scrap or dispatch back
  'service_denied',     -- the customer denied service: dispatch back
  'in_transit_return', 'closed', 'transferred'
));

alter table public.revive_tickets
  add column if not exists outcome text check (outcome in ('repaired', 'not_repairable', 'customer_denied')),
  add column if not exists closure text check (closure in ('returned', 'scrapped')),
  add column if not exists scrapped_at timestamptz,
  add column if not exists scrapped_by uuid references public.employees(id) on delete set null,
  add column if not exists expected_by date;

comment on column public.revive_tickets.outcome is 'How the engineer closed the repair.';
comment on column public.revive_tickets.closure is 'returned: dispatched back to the field. scrapped: moved to scrap by the Revive Lab, which closed it.';
comment on column public.revive_tickets.expected_by is 'When the Revive Lab engineer expects the repair done. Set on accepting the repair; the engineer can move it.';

-- ---------------------------------------------------------------------
-- The history: which button made a step
-- ---------------------------------------------------------------------
alter table public.revive_ticket_events
  add column if not exists action text;

alter table public.revive_ticket_events
  drop constraint if exists revive_ticket_events_kind_check;
alter table public.revive_ticket_events
  add constraint revive_ticket_events_kind_check
  check (kind in ('status', 'observation', 'courier', 'component', 'eta'));

comment on column public.revive_ticket_events.action is
  'What was done, where the status alone does not say: used, requested, accepted, declined, purchased, confirmed, cancelled, repaired, not_repairable, customer_denied, scrapped, expected.';

/** One step in the history, with the button that made it. Internal. */
create or replace function public.revive_step(
  p_ticket_id uuid, p_status text, p_from text, p_trc_id uuid,
  p_kind text, p_action text, p_note text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
begin
  insert into revive_ticket_events (ticket_id, status, from_status, trc_id, actor_id, note, kind, action)
  values (p_ticket_id, p_status, p_from, p_trc_id, current_employee_id(),
          nullif(btrim(coalesce(p_note, '')), ''), p_kind, p_action);
end $fn$;
revoke all on function public.revive_step(uuid, text, text, uuid, text, text, text) from public;

-- ---------------------------------------------------------------------
-- Accepting a repair, with the date it is expected
-- ---------------------------------------------------------------------
drop function if exists public.revive_start_repair(uuid, text);
create function public.revive_start_repair(
  p_ticket_id uuid, p_note text default null, p_expected_by date default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer it is assigned to can accept this repair';
  end if;
  if t.status <> 'assigned' then
    raise exception 'This repair is not waiting for you to accept it';
  end if;
  -- A day's grace either side: current_date is the database's, and India is ahead of it.
  if p_expected_by is not null and (p_expected_by < current_date - 1 or p_expected_by > current_date + 366) then
    raise exception 'Choose an expected date from today, within a year';
  end if;
  update revive_tickets
     set status = 'in_repair', expected_by = coalesce(p_expected_by, expected_by), updated_at = now()
   where id = t.id;
  perform revive_step(t.id, 'in_repair', t.status, t.trc_id, 'status', null,
    concat_ws(' · ',
      case when p_expected_by is not null then 'Expected by ' || to_char(p_expected_by, 'FMDD Mon YYYY') end,
      nullif(btrim(coalesce(p_note, '')), '')));
end $fn$;
grant execute on function public.revive_start_repair(uuid, text, date) to authenticated;

/** Moves the expected date, while the repair is still going. */
create or replace function public.revive_set_expected_date(
  p_ticket_id uuid, p_expected_by date, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can change the expected date';
  end if;
  if t.status not in ('in_repair', 'parts_requested', 'parts_ordered', 'parts_ready') then
    raise exception 'The expected date can be changed while it is in repair';
  end if;
  if p_expected_by is null or p_expected_by < current_date - 1 or p_expected_by > current_date + 366 then
    raise exception 'Choose an expected date from today, within a year';
  end if;
  if p_expected_by = t.expected_by then
    raise exception 'That is already the expected date';
  end if;
  update revive_tickets set expected_by = p_expected_by, updated_at = now() where id = t.id;
  perform revive_step(t.id, t.status, t.status, t.trc_id, 'eta', 'expected',
    concat_ws(' · ', 'Expected by ' || to_char(p_expected_by, 'FMDD Mon YYYY'), nullif(btrim(coalesce(p_note, '')), '')));
end $fn$;
grant execute on function public.revive_set_expected_date(uuid, date, text) to authenticated;

-- Observations go on while components are being bought, too.
create or replace function public.revive_add_observation(p_ticket_id uuid, p_note text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
  n text := btrim(coalesce(p_note, ''));
begin
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can add an observation';
  end if;
  if t.status not in ('in_repair', 'parts_requested', 'parts_ordered', 'parts_ready') then
    raise exception 'Observations are added while it is in repair';
  end if;
  if length(n) < 3 then
    raise exception 'Write what was found';
  end if;
  if length(n) > 1000 then
    raise exception 'Keep an observation under 1000 characters';
  end if;
  insert into revive_ticket_events (ticket_id, status, from_status, trc_id, actor_id, note, kind)
  values (t.id, t.status, t.status, t.trc_id, current_employee_id(), n, 'observation');
  update revive_tickets set updated_at = now() where id = t.id;
end $fn$;

-- ---------------------------------------------------------------------
-- How a repair ends
-- ---------------------------------------------------------------------
drop function if exists public.revive_complete_repair(uuid, text);
create function public.revive_complete_repair(
  p_ticket_id uuid, p_note text default null, p_outcome text default 'repaired')
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t    revive_tickets := revive_lock(p_ticket_id);
  next text;
begin
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can close the repair';
  end if;
  if t.status in ('parts_requested', 'parts_ordered', 'parts_ready') then
    raise exception 'Finish the component requests before closing the repair — confirm what was bought, or cancel what is no longer needed';
  end if;
  if t.status <> 'in_repair' then
    raise exception 'Accept the repair before closing it';
  end if;
  if coalesce(p_outcome, '') not in ('repaired', 'not_repairable', 'customer_denied') then
    raise exception 'Choose how the repair ended';
  end if;
  if p_outcome <> 'repaired' and length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'Say why';
  end if;
  next := case p_outcome
            when 'repaired' then 'repaired'
            when 'not_repairable' then 'not_repairable'
            else 'service_denied' end;
  update revive_tickets set status = next, outcome = p_outcome, updated_at = now() where id = t.id;
  perform revive_step(t.id, next, t.status, t.trc_id, 'status', p_outcome, p_note);
end $fn$;
grant execute on function public.revive_complete_repair(uuid, text, text) to authenticated;

/** Sent back to the field — repaired, not repairable, or the customer said no. */
create or replace function public.revive_dispatch(
  p_ticket_id uuid, p_courier text, p_awb text, p_dispatched_on date, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator or manager of this Revive Lab can dispatch it';
  end if;
  if t.status not in ('repaired', 'not_repairable', 'service_denied') then
    raise exception 'Close the repair before dispatching it';
  end if;
  if length(btrim(coalesce(p_courier, ''))) < 2 then
    raise exception 'Enter the courier it is going back with';
  end if;
  update revive_tickets
  set status = 'in_transit_return',
      closure = 'returned',
      out_courier = btrim(p_courier),
      out_awb = nullif(btrim(coalesce(p_awb, '')), ''),
      out_dispatched_on = coalesce(p_dispatched_on, current_date),
      updated_at = now()
  where id = t.id;
  perform revive_log(t.id, 'in_transit_return', t.status, t.trc_id, p_note);
end $fn$;

/** Not repairable, and not worth sending back: scrap, which closes the ticket. */
create or replace function public.revive_scrap(p_ticket_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator or manager of this Revive Lab can move it to scrap';
  end if;
  if t.status <> 'not_repairable' then
    raise exception 'Only a spare closed as not repairable can be moved to scrap';
  end if;
  update revive_tickets
     set status = 'closed', closure = 'scrapped', closed_at = now(),
         scrapped_at = now(), scrapped_by = current_employee_id(), updated_at = now()
   where id = t.id;
  perform revive_step(t.id, 'closed', t.status, t.trc_id, 'status', 'scrapped', p_note);
end $fn$;
grant execute on function public.revive_scrap(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Component stock, per Revive Lab
-- ---------------------------------------------------------------------
create table if not exists public.revive_components (
  id          uuid primary key default gen_random_uuid(),
  trc_id      uuid not null references public.revive_trcs(id) on delete cascade,
  part_no     text not null check (length(btrim(part_no)) between 1 and 40),   -- Cyrix part no, C-001
  value       text check (value is null or length(value) <= 160),              -- Mfr part no or value
  item        text check (item is null or length(item) <= 80),                 -- IC, MOSFET, RESISTOR …
  package     text check (package is null or length(package) <= 40),          -- TH, SMD …
  qty         integer not null default 0 check (qty >= 0),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.employees(id) on delete set null
);
create unique index if not exists revive_components_part on public.revive_components (trc_id, lower(btrim(part_no)));

create table if not exists public.revive_component_moves (
  id            bigint generated always as identity primary key,
  component_id  uuid not null references public.revive_components(id) on delete cascade,
  trc_id        uuid not null references public.revive_trcs(id) on delete cascade,
  ticket_id     uuid references public.revive_tickets(id) on delete set null,
  kind          text not null check (kind in ('count', 'use')),   -- count: a stock sheet uploaded; use: taken for a repair
  change        integer not null,
  qty_after     integer not null,
  actor_id      uuid references public.employees(id) on delete set null,
  at            timestamptz not null default now()
);
create index if not exists revive_component_moves_ticket on public.revive_component_moves (ticket_id) where ticket_id is not null;
create index if not exists revive_component_moves_component on public.revive_component_moves (component_id);

alter table public.revive_components enable row level security;
alter table public.revive_component_moves enable row level security;

/** Anybody in the Revive Lab — every role — or an admin. */
create or replace function public.revive_in_trc(p_trc_id uuid)
returns boolean
language sql stable security definer set search_path to 'public'
as $fn$
  select revive_is_admin() or exists (
    select 1 from revive_member_trcs mt
    where mt.employee_id = current_employee_id() and mt.trc_id = p_trc_id
  )
$fn$;
grant execute on function public.revive_in_trc(uuid) to authenticated;

drop policy if exists revive_components_read on public.revive_components;
create policy revive_components_read on public.revive_components
  for select to authenticated using (revive_in_trc(trc_id));
drop policy if exists revive_component_moves_read on public.revive_component_moves;
create policy revive_component_moves_read on public.revive_component_moves
  for select to authenticated using (revive_in_trc(trc_id));
grant select on public.revive_components, public.revive_component_moves to authenticated;

/**
 * A stock sheet, uploaded: every part in it added or brought up to date,
 * its quantity set to the count in the sheet. Parts the sheet leaves out
 * are left as they are. Each quantity that changes is a move, so what an
 * upload did can be read back.
 */
create or replace function public.revive_upload_stock(p_trc_id uuid, p_rows jsonb)
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
  q        integer;
  cur      revive_components;
  added    integer := 0;
  changed  integer := 0;
  same     integer := 0;
  seen     text[] := '{}';
begin
  if not (revive_runs_trc(p_trc_id) or revive_is_admin()) then
    raise exception 'Only a coordinator or manager of this Revive Lab can upload its stock';
  end if;
  if not exists (select 1 from revive_trcs where id = p_trc_id) then
    raise exception 'That Revive Lab does not exist';
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
      insert into revive_components (trc_id, part_no, value, item, package, qty, updated_by)
      values (p_trc_id, part, val, itm, pkg, q, me)
      returning * into cur;
      insert into revive_component_moves (component_id, trc_id, kind, change, qty_after, actor_id)
      values (cur.id, p_trc_id, 'count', q, q, me);
      added := added + 1;
    elsif cur.value is distinct from val or cur.item is distinct from itm
       or cur.package is distinct from pkg or cur.qty <> q then
      update revive_components
         set value = val, item = itm, package = pkg, qty = q, updated_at = now(), updated_by = me
       where id = cur.id;
      if cur.qty <> q then
        insert into revive_component_moves (component_id, trc_id, kind, change, qty_after, actor_id)
        values (cur.id, p_trc_id, 'count', q - cur.qty, q, me);
      end if;
      changed := changed + 1;
    else
      same := same + 1;
    end if;
  end loop;

  perform log_audit('revive_stock', p_trc_id, 'uploaded',
    jsonb_build_object('added', added, 'changed', changed, 'same', same));

  return jsonb_build_object(
    'added', added, 'changed', changed, 'same', same,
    'not_in_sheet', (select count(*) from revive_components
                     where trc_id = p_trc_id and lower(btrim(part_no)) <> all (seen)));
end $fn$;
grant execute on function public.revive_upload_stock(uuid, jsonb) to authenticated;

/** Taken from stock for a repair. It comes off at once, and the ticket says what. */
create or replace function public.revive_use_component(p_ticket_id uuid, p_component_id uuid, p_qty integer)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
  c revive_components;
begin
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can use components for it';
  end if;
  if t.status not in ('in_repair', 'parts_requested', 'parts_ordered', 'parts_ready') then
    raise exception 'Components are used while it is in repair';
  end if;
  select * into c from revive_components where id = p_component_id for update;
  if not found or c.trc_id <> t.trc_id then
    raise exception 'That component is not in this Revive Lab''s stock';
  end if;
  if p_qty is null or p_qty < 1 then
    raise exception 'Enter how many were used';
  end if;
  if p_qty > c.qty then
    raise exception 'Only % of % in stock', c.qty, c.part_no;
  end if;
  update revive_components set qty = qty - p_qty, updated_at = now(), updated_by = current_employee_id()
   where id = c.id;
  insert into revive_component_moves (component_id, trc_id, ticket_id, kind, change, qty_after, actor_id)
  values (c.id, c.trc_id, t.id, 'use', -p_qty, c.qty - p_qty, current_employee_id());
  update revive_tickets set updated_at = now() where id = t.id;
  perform revive_step(t.id, t.status, t.status, t.trc_id, 'component', 'used',
    p_qty || ' × ' || coalesce(c.value, c.item, c.part_no) || ' (' || c.part_no || ')');
end $fn$;
grant execute on function public.revive_use_component(uuid, uuid, integer) to authenticated;

/** The components one ticket took from stock. */
create or replace function public.revive_component_uses(p_ticket_id uuid)
returns table (id bigint, part_no text, value text, item text, package text, qty integer, used_by_name text, at timestamptz)
language sql stable security definer set search_path to 'public'
as $fn$
  select m.id, c.part_no, c.value, c.item, c.package, -m.change, e.full_name, m.at
  from revive_component_moves m
  join revive_components c on c.id = m.component_id
  left join employees e on e.id = m.actor_id
  where m.ticket_id = p_ticket_id and m.kind = 'use'
    and revive_can_see(p_ticket_id)
  order by m.at
$fn$;
grant execute on function public.revive_component_uses(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Component requests: local purchase and purchase
-- ---------------------------------------------------------------------
create table if not exists public.revive_part_requests (
  id               uuid primary key default gen_random_uuid(),
  ticket_id        uuid not null references public.revive_tickets(id) on delete cascade,
  trc_id           uuid not null references public.revive_trcs(id),
  route            text not null check (route in ('local', 'purchase')),
  name             text not null check (length(btrim(name)) between 2 and 160),
  qty              integer not null check (qty between 1 and 100000),
  note             text check (note is null or length(note) <= 1000),
  link             text check (link is null or (length(link) <= 1000 and link ~* '^https?://')),
  photo_path       text,
  status           text not null default 'requested'
                   check (status in ('requested', 'accepted', 'declined', 'purchased', 'received', 'cancelled')),
  bill_amount      numeric(12, 2) check (bill_amount is null or bill_amount >= 0),
  bill_no          text check (bill_no is null or length(bill_no) <= 60),
  vendor           text check (vendor is null or length(vendor) <= 120),
  bill_paths       text[] not null default '{}',
  requested_by     uuid not null references public.employees(id),
  requested_at     timestamptz not null default now(),
  accepted_by      uuid references public.employees(id) on delete set null,
  accepted_at      timestamptz,
  declined_by      uuid references public.employees(id) on delete set null,
  declined_at      timestamptz,
  declined_reason  text,
  purchased_by     uuid references public.employees(id) on delete set null,
  purchased_at     timestamptz,
  received_by      uuid references public.employees(id) on delete set null,
  received_at      timestamptz,
  updated_at       timestamptz not null default now()
);
create index if not exists revive_part_requests_ticket on public.revive_part_requests (ticket_id);
create index if not exists revive_part_requests_trc_status on public.revive_part_requests (trc_id, status);

alter table public.revive_part_requests enable row level security;
drop policy if exists revive_part_requests_read on public.revive_part_requests;
create policy revive_part_requests_read on public.revive_part_requests
  for select to authenticated using (revive_can_see(ticket_id));
grant select on public.revive_part_requests to authenticated;

/** Who acts on a request: the desk for a local purchase, a buyer for a purchase. */
create or replace function public.revive_handles_part(p_route text, p_trc_id uuid)
returns boolean
language sql stable security definer set search_path to 'public'
as $fn$
  select case p_route when 'local' then revive_runs_trc(p_trc_id) else revive_buys_for(p_trc_id) end
$fn$;
grant execute on function public.revive_handles_part(text, uuid) to authenticated;

/**
 * After a request moves: the ticket's status follows the requests still
 * open, and the step goes in the history. A change of status is a move;
 * anything else is a component note.
 */
create or replace function public.revive_parts_step(p_ticket_id uuid, p_action text, p_note text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t    revive_tickets;
  next text;
begin
  select * into t from revive_tickets where id = p_ticket_id;
  select case
           when bool_or(r.status = 'requested') then 'parts_requested'
           when bool_or(r.status = 'accepted') then 'parts_ordered'
           when bool_or(r.status = 'purchased') then 'parts_ready'
           else 'in_repair'
         end
    into next
    from revive_part_requests r
   where r.ticket_id = t.id;
  next := coalesce(next, 'in_repair');

  if next <> t.status then
    update revive_tickets set status = next, updated_at = now() where id = t.id;
    perform revive_step(t.id, next, t.status, t.trc_id, 'status', p_action, p_note);
  else
    update revive_tickets set updated_at = now() where id = t.id;
    perform revive_step(t.id, t.status, t.status, t.trc_id, 'component', p_action, p_note);
  end if;
end $fn$;
revoke all on function public.revive_parts_step(uuid, text, text) from public;

create or replace function public.revive_part_label(r public.revive_part_requests)
returns text
language sql immutable
as $fn$
  select case r.route when 'local' then 'Local purchase' else 'Purchase' end
         || ': ' || r.qty || ' × ' || r.name
$fn$;

/** The engineer asks for a component that is not in stock. */
create or replace function public.revive_request_part(
  p_ticket_id uuid, p_route text, p_name text, p_qty integer,
  p_note text default null, p_link text default null)
returns uuid
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t    revive_tickets := revive_lock(p_ticket_id);
  r    revive_part_requests;
  lnk  text := nullif(btrim(coalesce(p_link, '')), '');
begin
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can request a component';
  end if;
  if t.status not in ('in_repair', 'parts_requested', 'parts_ordered', 'parts_ready') then
    raise exception 'Components are requested while it is in repair';
  end if;
  if coalesce(p_route, '') not in ('local', 'purchase') then
    raise exception 'Choose local purchase or purchase';
  end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then
    raise exception 'Enter the component name';
  end if;
  if length(btrim(p_name)) > 160 then
    raise exception 'Keep the component name under 160 characters';
  end if;
  if p_qty is null or p_qty < 1 or p_qty > 100000 then
    raise exception 'Enter how many are needed';
  end if;
  if lnk is not null and (lnk !~* '^https?://' or length(lnk) > 1000) then
    raise exception 'The link should start with http:// or https://';
  end if;
  if p_route = 'purchase' and not exists (
    select 1 from revive_members m join revive_member_trcs mt on mt.employee_id = m.employee_id
    where m.is_purchase and mt.trc_id = t.trc_id) then
    raise exception 'Nobody has the Purchase role for this Revive Lab yet — ask an admin, or make it a local purchase';
  end if;

  insert into revive_part_requests (ticket_id, trc_id, route, name, qty, note, link, requested_by)
  values (t.id, t.trc_id, p_route, btrim(p_name), p_qty,
          nullif(btrim(coalesce(p_note, '')), ''), lnk, current_employee_id())
  returning * into r;

  perform revive_parts_step(t.id, 'requested', concat_ws(' · ', revive_part_label(r), r.note));
  return r.id;
end $fn$;
grant execute on function public.revive_request_part(uuid, text, text, integer, text, text) to authenticated;

/** The photo the engineer took of the component, once it is uploaded. */
create or replace function public.revive_set_part_photo(p_request_id uuid, p_path text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  r revive_part_requests;
begin
  select * into r from revive_part_requests where id = p_request_id for update;
  if not found then raise exception 'That request does not exist'; end if;
  if r.requested_by is distinct from current_employee_id() then
    raise exception 'Only the engineer who asked for it can add its photo';
  end if;
  if p_path !~ ('^' || r.ticket_id || '/parts/' || r.id || '/photo\.(jpg|jpeg|png|webp)$') then
    raise exception 'That is not this request''s photo';
  end if;
  update revive_part_requests set photo_path = p_path, updated_at = now() where id = r.id;
end $fn$;
grant execute on function public.revive_set_part_photo(uuid, text) to authenticated;

/** A request, locked with its ticket — the ticket first, always, so two hands cannot deadlock. */
create or replace function public.revive_lock_part(p_request_id uuid)
returns public.revive_part_requests
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  tid uuid;
  r   revive_part_requests;
begin
  select ticket_id into tid from revive_part_requests where id = p_request_id;
  if tid is null then raise exception 'That request does not exist'; end if;
  perform revive_lock(tid);
  select * into r from revive_part_requests where id = p_request_id for update;
  return r;
end $fn$;
revoke all on function public.revive_lock_part(uuid) from public;

/** Taken on: the coordinator for a local purchase, the buyer for a purchase. */
create or replace function public.revive_accept_part(p_request_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  r revive_part_requests := revive_lock_part(p_request_id);
begin
  if not revive_handles_part(r.route, r.trc_id) then
    raise exception '%', case r.route when 'local' then 'Only the Revive Lab''s coordinator or manager accepts a local purchase'
                                      else 'Only Purchase accepts a purchase request' end;
  end if;
  if r.status <> 'requested' then
    raise exception 'This request is not waiting to be accepted';
  end if;
  update revive_part_requests
     set status = 'accepted', accepted_by = current_employee_id(), accepted_at = now(), updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, 'accepted', revive_part_label(r));
end $fn$;
grant execute on function public.revive_accept_part(uuid) to authenticated;

/** Not bought, with the reason — the engineer sees it and can ask another way. */
create or replace function public.revive_decline_part(p_request_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  r revive_part_requests := revive_lock_part(p_request_id);
begin
  if not revive_handles_part(r.route, r.trc_id) then
    raise exception 'Only whoever buys this request can decline it';
  end if;
  if r.status not in ('requested', 'accepted') then
    raise exception 'This request is not open';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Say why it is not being bought';
  end if;
  update revive_part_requests
     set status = 'declined', declined_by = current_employee_id(), declined_at = now(),
         declined_reason = btrim(p_reason), updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, 'declined', revive_part_label(r) || ' · ' || btrim(p_reason));
end $fn$;
grant execute on function public.revive_decline_part(uuid, text) to authenticated;

/** Bought: the bill attached, its amount, and it goes to the engineer. */
create or replace function public.revive_purchase_part(
  p_request_id uuid, p_amount numeric, p_bill_paths text[],
  p_bill_no text default null, p_vendor text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  r    revive_part_requests := revive_lock_part(p_request_id);
  path text;
begin
  if not revive_handles_part(r.route, r.trc_id) then
    raise exception 'Only whoever buys this request can send it to the engineer';
  end if;
  if r.status <> 'accepted' then
    raise exception 'Accept the request before sending it to the engineer';
  end if;
  if p_amount is null or p_amount < 0 or p_amount > 10000000 then
    raise exception 'Enter the bill amount';
  end if;
  if coalesce(array_length(p_bill_paths, 1), 0) = 0 then
    raise exception 'Attach the bill';
  end if;
  if array_length(p_bill_paths, 1) > 3 then
    raise exception 'Attach at most 3 pages of the bill';
  end if;
  foreach path in array p_bill_paths loop
    if path !~ ('^' || r.ticket_id || '/parts/' || r.id || '/bill-[1-3]\.(jpg|jpeg|png|webp)$') then
      raise exception 'That is not this request''s bill';
    end if;
  end loop;

  update revive_part_requests
     set status = 'purchased', purchased_by = current_employee_id(), purchased_at = now(),
         bill_amount = round(p_amount, 2), bill_paths = p_bill_paths,
         bill_no = nullif(btrim(coalesce(p_bill_no, '')), ''),
         vendor = nullif(btrim(coalesce(p_vendor, '')), ''),
         updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, 'purchased',
    revive_part_label(r) || ' · ₹' || regexp_replace(to_char(round(p_amount, 2), 'FM9999999990.00'), '\.00$', ''));
end $fn$;
grant execute on function public.revive_purchase_part(uuid, numeric, text[], text, text) to authenticated;

/** The engineer has it. When nothing else is being bought, the repair goes on. */
create or replace function public.revive_confirm_part(p_request_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  r revive_part_requests := revive_lock_part(p_request_id);
  t revive_tickets;
begin
  select * into t from revive_tickets where id = r.ticket_id;
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can confirm the purchase';
  end if;
  if r.status <> 'purchased' then
    raise exception 'This has not been sent to you yet';
  end if;
  update revive_part_requests
     set status = 'received', received_by = current_employee_id(), received_at = now(), updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, 'confirmed', revive_part_label(r));
end $fn$;
grant execute on function public.revive_confirm_part(uuid) to authenticated;

/** No longer needed, before anybody has bought it. */
create or replace function public.revive_cancel_part(p_request_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  r revive_part_requests := revive_lock_part(p_request_id);
  t revive_tickets;
begin
  select * into t from revive_tickets where id = r.ticket_id;
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can cancel a request';
  end if;
  if r.status not in ('requested', 'accepted') then
    raise exception 'Only a request that has not been bought can be cancelled';
  end if;
  update revive_part_requests set status = 'cancelled', updated_at = now() where id = r.id;
  perform revive_parts_step(r.ticket_id, 'cancelled', concat_ws(' · ', revive_part_label(r), nullif(btrim(coalesce(p_reason, '')), '')));
end $fn$;
grant execute on function public.revive_cancel_part(uuid, text) to authenticated;

/** Requests, with the people and the ticket — for one ticket, or every ticket this person can see. */
create or replace function public.revive_part_request_list(p_ticket_id uuid default null)
returns table (
  id uuid, ticket_id uuid, ticket_code text, ticket_status text, facility text,
  trc_id uuid, trc_name text, route text, name text, qty integer, note text, link text, photo_path text,
  status text, bill_amount numeric, bill_no text, vendor text, bill_paths text[],
  requested_by uuid, requested_by_name text, requested_at timestamptz,
  accepted_by_name text, accepted_at timestamptz,
  declined_by_name text, declined_at timestamptz, declined_reason text,
  purchased_by_name text, purchased_at timestamptz,
  received_by_name text, received_at timestamptz
)
language sql stable security definer set search_path to 'public'
as $fn$
  select r.id, r.ticket_id, t.code, t.status, t.facility,
         r.trc_id, trc.name, r.route, r.name, r.qty, r.note, r.link, r.photo_path,
         r.status, r.bill_amount, r.bill_no, r.vendor, r.bill_paths,
         r.requested_by, rq.full_name, r.requested_at,
         ac.full_name, r.accepted_at,
         dc.full_name, r.declined_at, r.declined_reason,
         pu.full_name, r.purchased_at,
         rc.full_name, r.received_at
  from revive_part_requests r
  join revive_tickets t on t.id = r.ticket_id
  join revive_trcs trc on trc.id = r.trc_id
  left join employees rq on rq.id = r.requested_by
  left join employees ac on ac.id = r.accepted_by
  left join employees dc on dc.id = r.declined_by
  left join employees pu on pu.id = r.purchased_by
  left join employees rc on rc.id = r.received_by
  where (p_ticket_id is null or r.ticket_id = p_ticket_id)
    and revive_can_see(r.ticket_id)
  order by r.requested_at desc
$fn$;
grant execute on function public.revive_part_request_list(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Photos of components and bills, in the ticket's folder
-- ---------------------------------------------------------------------
drop policy if exists revive_parts_insert on storage.objects;
create policy revive_parts_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'revive-attachments'
    and (storage.foldername(objects.name))[2] = 'parts'
    and exists (
      select 1 from public.revive_part_requests r
      where r.ticket_id::text = (storage.foldername(objects.name))[1]
        and r.id::text = (storage.foldername(objects.name))[3]
        and (
          (storage.filename(objects.name) ~ '^photo\.(jpg|jpeg|png|webp)$'
             and r.requested_by = public.current_employee_id())
          or (storage.filename(objects.name) ~ '^bill-[1-3]\.(jpg|jpeg|png|webp)$'
             and r.status = 'accepted'
             and public.revive_handles_part(r.route, r.trc_id))
        )
    )
  );

drop policy if exists revive_parts_update on storage.objects;
create policy revive_parts_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'revive-attachments'
    and (storage.foldername(objects.name))[2] = 'parts'
    and exists (
      select 1 from public.revive_part_requests r
      where r.ticket_id::text = (storage.foldername(objects.name))[1]
        and r.id::text = (storage.foldername(objects.name))[3]
        and (
          (storage.filename(objects.name) ~ '^photo\.(jpg|jpeg|png|webp)$'
             and r.requested_by = public.current_employee_id())
          or (storage.filename(objects.name) ~ '^bill-[1-3]\.(jpg|jpeg|png|webp)$'
             and r.status = 'accepted'
             and public.revive_handles_part(r.route, r.trc_id))
        )
    )
  );

-- ---------------------------------------------------------------------
-- The list and the trail carry all of it. Changed return types: drop and create.
-- ---------------------------------------------------------------------
drop function if exists public.revive_ticket_list();
create function public.revive_ticket_list()
returns table (
  id uuid, number integer, code text, status text,
  trc_kind text, trc_id uuid, trc_name text,
  source_ticket_no text, facility text, district text, state text,
  bemmp_id uuid, bemmp_code text, billing_spare boolean,
  equipment_name text, equipment_barcode text, spare_name text, items jsonb,
  issue text, return_address text, contact_number text,
  in_courier text, in_awb text, in_dispatched_on date,
  stakeholder_id uuid, stakeholder_name text, stakeholder_ecode text,
  stakeholder_function text,
  stakeholder_manager_name text,
  raised_by uuid, raised_by_name text, raised_by_function text, raised_as text,
  engineer_id uuid, engineer_name text, engineer_ecode text,
  out_courier text, out_awb text, out_dispatched_on date,
  created_at timestamptz, updated_at timestamptz, closed_at timestamptz,
  outcome text, closure text, scrapped_at timestamptz, scrapped_by_name text,
  expected_by date, parts jsonb
)
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
                   from revive_part_requests r where r.ticket_id = t.id), '[]'::jsonb)
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
grant execute on function public.revive_ticket_list() to authenticated;

drop function if exists public.revive_ticket_trail(uuid);
create function public.revive_ticket_trail(p_ticket_id uuid)
returns table (
  id bigint, status text, from_status text, trc_id uuid, trc_name text,
  actor_name text, actor_ecode text, note text, at timestamptz,
  engineer_name text, engineer_ecode text, kind text, action text
)
language sql stable security definer set search_path to 'public'
as $fn$
  select ev.id, ev.status, ev.from_status, ev.trc_id, trc.name,
         e.full_name, e.ecode, ev.note, ev.at,
         en.full_name, en.ecode, ev.kind, ev.action
  from revive_ticket_events ev
  left join revive_trcs trc on trc.id = ev.trc_id
  left join employees e on e.id = ev.actor_id
  left join employees en on en.id = ev.engineer_id
  where ev.ticket_id = p_ticket_id
    and revive_can_see(p_ticket_id)
  order by ev.at, ev.id
$fn$;
grant execute on function public.revive_ticket_trail(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Internal helpers are for the functions above, not for anybody signed in
-- ---------------------------------------------------------------------
-- Supabase gives every new function to anon and authenticated by default,
-- and "revoke from public" does not take that back. revive_log and
-- revive_lock were callable straight from the browser: a history step
-- written into any ticket, or any ticket's row read by its id. The
-- functions that use them run as their owner and keep working.
revoke execute on function public.revive_log(uuid, text, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.revive_lock(uuid) from public, anon, authenticated;
revoke execute on function public.revive_queue_mail() from public, anon, authenticated;
revoke execute on function public.revive_step(uuid, text, text, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.revive_parts_step(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.revive_lock_part(uuid) from public, anon, authenticated;
