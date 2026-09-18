/*
  rl_0020 — spares from a warehouse, and the desk kept to the state.

  - revive_warehouses: the warehouses a defective spare can come from, a
    fixed list kept by Revive Lab admins (revive_save_warehouse) — each in a
    state, or in none (any state). Retired rather than deleted.
  - revive_tickets.source: 'hospital' (every ticket so far) or 'warehouse',
    with warehouse_id. A warehouse ticket is raised by the Revive Lab's
    coordinator or manager only; it names the warehouse where a hospital
    ticket names the hospital (facility carries the warehouse's name, so
    lists and search need nothing new), has no BEMMP, district or ticket
    ID, and belongs to the warehouse in-charge the way a hospital spare
    belongs to its field engineer. Everything after raising is the same.
  - The desk raises only at a Revive Lab of its own that serves the chosen
    state — its state's, or a Regional one. It was offered, and allowed,
    any Revive Lab it runs whatever the state.
*/

-- ---------------------------------------------------------------------
-- The warehouses
-- ---------------------------------------------------------------------
create table public.revive_warehouses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 2 and 80),
  -- No state: it sends spares in whatever state the ticket says.
  state       text check (state is null or length(state) between 2 and 80),
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.employees(id)
);
create unique index revive_warehouses_name_key on public.revive_warehouses (lower(btrim(name)));

alter table public.revive_warehouses enable row level security;
create policy revive_warehouses_read on public.revive_warehouses
  for select to authenticated using (revive_has_access());
revoke all on public.revive_warehouses from anon;
revoke insert, update, delete, truncate, references, trigger on public.revive_warehouses from authenticated;
grant select on public.revive_warehouses to authenticated;

/** Adds or changes one; null for p_state keeps its state, '' or 'Any' makes it any state's. */
create function public.revive_save_warehouse(
  p_id uuid, p_name text, p_active boolean default true, p_state text default null)
returns uuid
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  pid   uuid := p_id;
  clean text := btrim(coalesce(p_name, ''));
  st    text := nullif(btrim(coalesce(p_state, '')), '');
  keep  boolean := p_state is null;
begin
  if not revive_is_admin() then
    raise exception 'Only a Revive Lab admin can change the warehouse list';
  end if;
  if length(clean) not between 2 and 80 then
    raise exception 'A warehouse''s name is 2 to 80 characters';
  end if;
  if exists (select 1 from revive_warehouses
             where lower(btrim(name)) = lower(clean) and id is distinct from p_id) then
    raise exception 'Warehouse "%" is already on the list', clean;
  end if;
  if lower(st) in ('any', 'regional') then
    st := null;
  end if;
  if st is not null and length(st) not between 2 and 80 then
    raise exception 'Choose the state it is in, or any state';
  end if;

  if pid is null then
    insert into revive_warehouses (name, state, is_active, sort_order, created_by)
    values (clean, st, coalesce(p_active, true),
            coalesce((select max(sort_order) from revive_warehouses), 0) + 10,
            current_employee_id())
    returning id into pid;
  else
    update revive_warehouses
       set name = clean, is_active = coalesce(p_active, true),
           state = case when keep then state else st end
     where id = pid;
    if not found then raise exception 'That warehouse does not exist'; end if;
  end if;

  perform log_audit('revive_warehouse', pid, 'saved', jsonb_build_object(
    'name', clean, 'active', coalesce(p_active, true),
    'state', (select coalesce(state, 'any') from revive_warehouses where id = pid)));
  return pid;
end $fn$;

revoke all on function public.revive_save_warehouse(uuid, text, boolean, text) from public, anon;
grant execute on function public.revive_save_warehouse(uuid, text, boolean, text) to authenticated;

-- ---------------------------------------------------------------------
-- Where a ticket's spare came from
-- ---------------------------------------------------------------------
alter table public.revive_tickets
  add column source text not null default 'hospital',
  add column warehouse_id uuid references public.revive_warehouses(id);

alter table public.revive_tickets
  add constraint revive_tickets_source_check check (source in ('hospital', 'warehouse')),
  add constraint revive_tickets_warehouse_check check ((source = 'warehouse') = (warehouse_id is not null));

-- ---------------------------------------------------------------------
-- Raising: from a hospital or a warehouse, and the desk kept to the state
-- ---------------------------------------------------------------------
drop function if exists public.revive_raise_ticket(
  uuid, text, text, uuid, text, text, text, text, text, text, text, text, text, text, date, uuid, jsonb, boolean, text, text, text);

create function public.revive_raise_ticket(
  p_trc_id uuid, p_hospital text, p_state text, p_bemmp_id uuid, p_district text, p_source_ticket_no text,
  p_equipment_name text, p_equipment_barcode text, p_spare_name text, p_issue text, p_return_address text,
  p_contact_number text, p_in_courier text, p_in_awb text, p_in_dispatched_on date,
  p_stakeholder_id uuid default null, p_items jsonb default null, p_billing_spare boolean default null,
  p_approval_reason text default null, p_equipment_make text default null, p_equipment_model text default null,
  p_source text default 'hospital', p_warehouse_id uuid default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  me        uuid := current_employee_id();
  trc       revive_trcs;
  bemmp     revive_bemmp_projects;
  wh        revive_warehouses;
  src       text := coalesce(nullif(btrim(coalesce(p_source, '')), ''), 'hospital');
  st        text := btrim(coalesce(p_state, ''));
  why       text := btrim(coalesce(p_approval_reason, ''));
  make      text := nullif(btrim(coalesce(p_equipment_make, '')), '');
  model     text := nullif(btrim(coalesce(p_equipment_model, '')), '');
  as_co     boolean;
  far       boolean;
  holder    uuid;
  t         revive_tickets;
  clean     text;
  entries   jsonb := '[]'::jsonb;
  entry     jsonb;
  item_kind text;
  item_name text;
begin
  if me is null then raise exception 'Only a signed-in employee can raise a ticket'; end if;
  if not revive_has_access() then
    raise exception 'Revive Lab has not been given to you yet — ask the software administrator';
  end if;
  -- Whoever sends spares in raises them: the field, or a Revive Lab's desk.
  -- Its engineers repair what arrives, and Purchase buys for it (rl_0019).
  if not is_sw_admin() and exists (
       select 1 from revive_members m
        where m.employee_id = me and (m.is_engineer or m.is_purchase)
          and not (m.is_coordinator or m.is_manager or m.is_admin)) then
    raise exception 'Tickets are raised by the field engineer or a Revive Lab coordinator — not by a Revive Lab engineer or Purchase';
  end if;
  if src not in ('hospital', 'warehouse') then
    raise exception 'A spare comes from a hospital or a warehouse';
  end if;

  select * into trc from revive_trcs where id = p_trc_id and is_active;
  if not found then raise exception 'Choose the Revive Lab the spare is going to'; end if;
  as_co := revive_runs_trc(p_trc_id);

  if length(st) < 2 then
    raise exception 'Choose the state';
  end if;
  -- The desk raises at a Revive Lab of its own for that state: the state's own, or a Regional one.
  if as_co and trc.state is not null and trc.state <> st then
    raise exception '% serves %, not % — choose a Revive Lab for %, or a Regional one', trc.name, trc.state, st, st;
  end if;

  if src = 'warehouse' then
    -- A warehouse's defective spare arrives at the Revive Lab; its desk writes the card.
    if not as_co then
      raise exception 'Only a Revive Lab coordinator or manager raises a ticket for a spare from a warehouse';
    end if;
    select * into wh from revive_warehouses where id = p_warehouse_id and is_active;
    if not found then raise exception 'Choose the warehouse'; end if;
    if wh.state is not null and wh.state <> st then
      raise exception '% is in %, not %', wh.name, wh.state, st;
    end if;
  else
    select * into bemmp from revive_bemmp_projects where id = p_bemmp_id and is_active;
    if not found then
      raise exception 'Choose the BEMMP';
    end if;
    if bemmp.state is not null and bemmp.state <> st then
      raise exception 'BEMMP % is for % — choose a BEMMP for %', bemmp.code, bemmp.state, st;
    end if;
    if length(btrim(coalesce(p_district, ''))) < 2 then
      raise exception 'Choose the district';
    end if;
    if length(btrim(coalesce(p_hospital, ''))) < 2 then
      raise exception 'Enter the hospital the spare came from';
    end if;
  end if;
  if length(coalesce(make, '')) > 80 or length(coalesce(model, '')) > 80 then
    raise exception 'Keep the make and the model under 80 characters';
  end if;

  /*
    The list. Without one — an app from before rl_0011 — the spare name is
    the whole list. A line left blank is skipped rather than refused: it is
    an empty row, not a mistake.
  */
  if p_items is null then
    if length(btrim(coalesce(p_spare_name, ''))) < 2 then
      raise exception 'Enter the spare''s name';
    end if;
    entries := jsonb_build_array(jsonb_build_object('kind', 'spare', 'name', btrim(p_spare_name)));
  else
    if jsonb_typeof(p_items) <> 'array' then
      raise exception 'List the spares and accessories';
    end if;
    for entry in select value from jsonb_array_elements(p_items) loop
      item_kind := entry->>'kind';
      item_name := btrim(coalesce(entry->>'name', ''));
      continue when item_name = '';
      if item_kind is null or item_kind not in ('spare', 'accessory', 'full_machine') then
        raise exception 'Each line is a spare, an accessory or a full machine';
      end if;
      if length(item_name) < 2 then
        raise exception 'Enter the name of each spare and accessory';
      end if;
      if length(item_name) > 120 then
        raise exception 'Keep each name under 120 characters';
      end if;
      entries := entries || jsonb_build_array(jsonb_build_object('kind', item_kind, 'name', item_name));
    end loop;
    if jsonb_array_length(entries) = 0 then
      raise exception 'Enter the spare''s name';
    end if;
    if jsonb_array_length(entries) > 10 then
      raise exception 'A ticket carries at most 10 spares and accessories';
    end if;
  end if;

  if length(btrim(coalesce(p_issue, ''))) < 3 then
    raise exception 'Describe the issue identified';
  end if;
  if length(btrim(coalesce(p_return_address, ''))) < 5 then
    raise exception 'Enter the address the spare should be returned to';
  end if;
  clean := nullif(regexp_replace(coalesce(p_contact_number, ''), '[^0-9+]', '', 'g'), '');
  if clean is not null and length(clean) not between 7 and 15 then
    raise exception 'That contact number does not look right';
  end if;

  holder := coalesce(p_stakeholder_id, me);

  if as_co and p_stakeholder_id is null then
    raise exception '%', case when src = 'warehouse'
      then 'Name the warehouse in-charge this spare belongs to, so they and their manager can follow it'
      else 'Name the field engineer this spare belongs to, so they and their manager can follow it' end;
  end if;
  if not as_co and holder <> me then
    raise exception 'Only the Revive Lab''s coordinator can raise a ticket on somebody else''s behalf';
  end if;
  if not exists (select 1 from employees where id = holder and is_active) then
    raise exception '%', case when src = 'warehouse'
      then 'That warehouse in-charge is not an active employee'
      else 'That field engineer is not an active employee' end;
  end if;

  /*
    Another state's Revive Lab. A field engineer is offered their own
    state's and the Regional ones; any other is asked for, with a reason,
    and waits for the Regional Revive Lab admins.
  */
  far := not as_co and trc.state is not null and trc.state <> st;
  if far and length(why) < 5 then
    raise exception '% is not a Revive Lab for % — say why it should go there, and the Regional Revive Lab admins approve it first', trc.name, st;
  end if;
  if far and length(why) > 500 then
    raise exception 'Keep the reason under 500 characters';
  end if;

  insert into revive_tickets (
    status, trc_kind, trc_id, source, warehouse_id, facility, state, bemmp_id, billing_spare, district,
    source_ticket_no, equipment_name, equipment_make, equipment_model, equipment_barcode, spare_name, items,
    issue, return_address, contact_number, in_courier, in_awb, in_dispatched_on,
    stakeholder_id, raised_by, raised_as)
  values (
    case when far then 'awaiting_approval' else 'pending_acceptance' end,
    trc.kind, trc.id,
    src,
    case when src = 'warehouse' then wh.id end,
    case when src = 'warehouse' then wh.name else btrim(p_hospital) end,
    st,
    case when src = 'hospital' then p_bemmp_id end,
    case when src = 'hospital' and bemmp.asks_billing then coalesce(p_billing_spare, false) end,
    case when src = 'hospital' then btrim(p_district) end,
    case when src = 'hospital' then nullif(btrim(coalesce(p_source_ticket_no, '')), '') end,
    nullif(btrim(coalesce(p_equipment_name, '')), ''),
    make,
    model,
    nullif(btrim(coalesce(p_equipment_barcode, '')), ''),
    entries->0->>'name',
    entries,
    btrim(p_issue),
    btrim(p_return_address),
    clean,
    nullif(btrim(coalesce(p_in_courier, '')), ''),
    nullif(btrim(coalesce(p_in_awb, '')), ''),
    p_in_dispatched_on,
    holder, me, case when as_co then 'coordinator' else 'engineer' end)
  returning * into t;

  if far then
    insert into revive_approvals (ticket_id, kind, asked_trc_id, to_trc_id, reason, requested_by)
    values (t.id, 'raise', trc.id, trc.id, why, me);
    perform revive_step(t.id, 'awaiting_approval', null, t.trc_id, 'status', 'lab_requested',
      'For ' || trc.name || ': ' || why);
  else
    perform revive_log(t.id, 'pending_acceptance', null, t.trc_id,
      case when src = 'warehouse' then 'Raised at the Revive Lab — from ' || wh.name
           when as_co then 'Raised at the Revive Lab'
           else 'Raised from the field' end);
  end if;

  return jsonb_build_object('id', t.id, 'code', t.code, 'number', t.number, 'status', t.status);
end $fn$;

revoke all on function public.revive_raise_ticket(
  uuid, text, text, uuid, text, text, text, text, text, text, text, text, text, text, date, uuid, jsonb, boolean, text, text, text,
  text, uuid)
  from public, anon;
grant execute on function public.revive_raise_ticket(
  uuid, text, text, uuid, text, text, text, text, text, text, text, text, text, text, date, uuid, jsonb, boolean, text, text, text,
  text, uuid)
  to authenticated;

-- ---------------------------------------------------------------------
-- The ticket list: where it came from
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
  equipment_make text, equipment_model text, done_voice text, source text, warehouse_id uuid)
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
         t.source, t.warehouse_id
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
