/*
  rl_0024 — a spare's category and criticality, the contract a Pvt spare
  is under, a Revive Lab TAT by category, and courier details at arrival.

  - revive_tickets.spare_category: A, B or C. The Revive Lab has it for
    3, 2 or 1 days from acceptance until it is dispatched back (or moved
    to scrap); the app counts it and says when it is exceeded.
  - revive_tickets.criticality: critical or non_critical.
  - revive_tickets.contract_type: AMC or CAMC, asked on the route card
    under a BEMMP that asks it (Pvt: revive_bemmp_projects.asks_contract).
    A CAMC spare is always critical, and nobody can say otherwise.
  - revive_tickets.accepted_at: when a Revive Lab first accepted it — the
    TAT's start. Filled from the history for every ticket accepted so far.
  - Accepting a spare that arrived by courier now needs the courier, the
    tracking / AWB number and the date of dispatch, and the category and
    criticality. A coordinator's own raise is accepted as it is raised
    (rl_0023), so it asks the category and criticality then. Tickets
    already open start as category A, non-critical; closed ones and those
    not yet accepted are left alone.
  - revive_set_classification: the desk changes the category and
    criticality from acceptance until it is dispatched back; each change
    is a history step (kind 'classify', no mail).
  - revive_ticket_list carries all of it, and when it was dispatched back.
*/

-- ---------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------
alter table public.revive_tickets
  add column if not exists spare_category text,
  add column if not exists criticality text,
  add column if not exists contract_type text,
  add column if not exists accepted_at timestamptz;

alter table public.revive_tickets
  add constraint revive_tickets_category_check
    check (spare_category is null or spare_category in ('A', 'B', 'C')),
  add constraint revive_tickets_criticality_check
    check (criticality is null or criticality in ('critical', 'non_critical')),
  add constraint revive_tickets_contract_check
    check (contract_type is null or contract_type in ('AMC', 'CAMC')),
  add constraint revive_tickets_camc_is_critical
    check (contract_type is distinct from 'CAMC' or criticality = 'critical');

-- When each ticket accepted so far was first accepted: the step into
-- accepted from waiting for acceptance, or from a transfer. A hand-back
-- from the engineer is also "accepted", and is not an arrival.
update public.revive_tickets t
   set accepted_at = (
         select min(ev.at) from public.revive_ticket_events ev
          where ev.ticket_id = t.id and ev.kind = 'status' and ev.status = 'accepted'
            and ev.from_status in ('pending_acceptance', 'transferred'))
 where t.accepted_at is null;

alter table public.revive_bemmp_projects
  add column if not exists asks_contract boolean not null default false;
-- The BEMMP that asks Billing spare is the private one: it asks the contract too.
update public.revive_bemmp_projects set asks_contract = true where asks_billing;

alter table public.revive_ticket_events drop constraint revive_ticket_events_kind_check;
alter table public.revive_ticket_events add constraint revive_ticket_events_kind_check
  check (kind in ('status', 'observation', 'courier', 'component', 'eta', 'classify'));

/** "Critical" / "Non-critical", for the history. */
create function public.revive_crit_label(p text)
returns text
language sql immutable
as $fn$
  select case p when 'critical' then 'Critical' when 'non_critical' then 'Non-critical' end
$fn$;
revoke all on function public.revive_crit_label(text) from public, anon, authenticated;

-- Every ticket already open at a Revive Lab starts as category A and
-- non-critical; the desk changes either until it is dispatched back (the
-- user, 23 Sep). Not a closed ticket, nor one not yet accepted — that one
-- is classified when it is accepted. Each says so in its history.
with filled as (
  update public.revive_tickets
     set spare_category = 'A', criticality = 'non_critical'
   where accepted_at is not null and status <> 'closed'
     and spare_category is null and criticality is null
  returning id, status, trc_id
)
insert into public.revive_ticket_events (ticket_id, status, from_status, trc_id, actor_id, note, kind)
select id, status, status, trc_id, null,
       'Category A · Non-critical — set for every ticket already open; the coordinator changes it where it is not right',
       'classify'
  from filled;

-- ---------------------------------------------------------------------
-- Accepting: how it came, and what it is
-- ---------------------------------------------------------------------
drop function if exists public.revive_accept(uuid, text, boolean, text[], text, text, date);

create function public.revive_accept(
  p_ticket_id uuid, p_note text default null, p_damaged boolean default false, p_photos text[] default null,
  p_courier text default null, p_awb text default null, p_dispatched_on date default null,
  p_category text default null, p_criticality text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t      revive_tickets := revive_lock(p_ticket_id);
  photos text[] := coalesce(p_photos, '{}');
  path   text;
  c      text := coalesce(nullif(btrim(coalesce(p_courier, '')), ''), t.in_courier);
  w      text := coalesce(nullif(btrim(coalesce(p_awb, '')), ''), t.in_awb);
  d      date := coalesce(p_dispatched_on, t.in_dispatched_on);
  cat    text := coalesce(upper(nullif(btrim(coalesce(p_category, '')), '')), t.spare_category);
  crit   text := coalesce(nullif(btrim(coalesce(p_criticality, '')), ''), t.criticality);
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator or manager of this Revive Lab can accept it';
  end if;
  if t.status not in ('pending_acceptance', 'transferred') then
    raise exception 'This ticket is not waiting to be accepted';
  end if;
  if array_length(photos, 1) > 2 then
    raise exception 'Two photographs of the spare as it arrived, at most';
  end if;
  foreach path in array photos loop
    if not revive_file_ok(t.id, path, 'arrival') then
      raise exception 'That is not a photograph of this spare arriving';
    end if;
  end loop;
  -- The one thing a damaged spare needs is the picture of it.
  if coalesce(p_damaged, false) and coalesce(array_length(photos, 1), 0) = 0 then
    raise exception 'Photograph the damage — it is the only proof there will be';
  end if;

  -- How it came, from the consignment note in the coordinator's hand. A
  -- transfer's courier was recorded when the other Revive Lab sent it.
  if t.status = 'pending_acceptance' then
    if c is null then raise exception 'Enter the courier it came with'; end if;
    if w is null then raise exception 'Enter the tracking / AWB number'; end if;
    if d is null then raise exception 'Enter the date of dispatch'; end if;
  end if;
  if length(c) > 80 or length(w) > 80 then
    raise exception 'Keep the courier and the tracking number under 80 characters';
  end if;
  if d > current_date + 1 then
    raise exception 'The date of dispatch cannot be in the future';
  end if;

  -- What it is: the category sets its TAT, and a CAMC spare is critical.
  if cat is null or cat not in ('A', 'B', 'C') then
    raise exception 'Choose the spare category — A, B or C';
  end if;
  if t.contract_type = 'CAMC' then
    if p_criticality = 'non_critical' then
      raise exception 'A CAMC spare is always critical';
    end if;
    crit := 'critical';
  end if;
  if crit is null or crit not in ('critical', 'non_critical') then
    raise exception 'Choose whether the spare is critical or non-critical';
  end if;

  update revive_tickets
     set status = 'accepted',
         arrival_damaged = coalesce(p_damaged, false),
         arrival_photos = photos,
         in_courier = c,
         in_awb = w,
         in_dispatched_on = d,
         spare_category = cat,
         criticality = crit,
         accepted_at = coalesce(accepted_at, now()),
         updated_at = now()
   where id = t.id;
  perform revive_step(t.id, 'accepted', t.status, t.trc_id, 'status',
    case when coalesce(p_damaged, false) then 'damaged' end,
    concat_ws(' · ',
      'Category ' || cat,
      revive_crit_label(crit),
      case when coalesce(p_damaged, false) then 'Damaged in transit' end,
      nullif(btrim(coalesce(p_note, '')), '')));
end $fn$;

revoke all on function public.revive_accept(uuid, text, boolean, text[], text, text, date, text, text) from public, anon;
grant execute on function public.revive_accept(uuid, text, boolean, text[], text, text, date, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Changing them, until it is dispatched back
-- ---------------------------------------------------------------------
create function public.revive_set_classification(p_ticket_id uuid, p_category text, p_criticality text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t    revive_tickets := revive_lock(p_ticket_id);
  cat  text := upper(nullif(btrim(coalesce(p_category, '')), ''));
  crit text := nullif(btrim(coalesce(p_criticality, '')), '');
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator or manager of this Revive Lab can change the category and criticality';
  end if;
  if t.accepted_at is null or t.status not in (
       'accepted', 'assigned', 'in_repair', 'parts_requested', 'parts_ordered', 'parts_ready',
       'repaired', 'not_repairable', 'service_denied', 'awaiting_approval', 'approved') then
    raise exception 'The category and criticality can be changed from acceptance until it is dispatched back';
  end if;
  if cat is null or cat not in ('A', 'B', 'C') then
    raise exception 'Choose the spare category — A, B or C';
  end if;
  if crit is null or crit not in ('critical', 'non_critical') then
    raise exception 'Choose whether the spare is critical or non-critical';
  end if;
  if t.contract_type = 'CAMC' and crit <> 'critical' then
    raise exception 'A CAMC spare is always critical';
  end if;
  if cat is not distinct from t.spare_category and crit is not distinct from t.criticality then
    raise exception 'Nothing has changed';
  end if;

  update revive_tickets
     set spare_category = cat, criticality = crit, updated_at = now()
   where id = t.id;
  perform revive_step(t.id, t.status, t.status, t.trc_id, 'classify', null,
    concat_ws(' · ',
      case when cat is distinct from t.spare_category then
        case when t.spare_category is null then 'Category ' || cat
             else 'Category ' || t.spare_category || ' → ' || cat end end,
      case when crit is distinct from t.criticality then
        case when t.criticality is null then revive_crit_label(crit)
             else revive_crit_label(t.criticality) || ' → ' || revive_crit_label(crit) end end));
end $fn$;

revoke all on function public.revive_set_classification(uuid, text, text) from public, anon;
grant execute on function public.revive_set_classification(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Raising: the contract under Pvt, and the desk's own raise classified
-- ---------------------------------------------------------------------
drop function if exists public.revive_raise_ticket(
  uuid, text, text, uuid, text, text, text, text, text, text, text, text, text, text, date, uuid, jsonb, boolean, text, text, text,
  text, uuid);

create function public.revive_raise_ticket(
  p_trc_id uuid, p_hospital text, p_state text, p_bemmp_id uuid, p_district text, p_source_ticket_no text,
  p_equipment_name text, p_equipment_barcode text, p_spare_name text, p_issue text, p_return_address text,
  p_contact_number text, p_in_courier text, p_in_awb text, p_in_dispatched_on date,
  p_stakeholder_id uuid default null, p_items jsonb default null, p_billing_spare boolean default null,
  p_approval_reason text default null, p_equipment_make text default null, p_equipment_model text default null,
  p_source text default 'hospital', p_warehouse_id uuid default null,
  p_contract_type text default null, p_category text default null, p_criticality text default null)
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
  contract  text := upper(nullif(btrim(coalesce(p_contract_type, '')), ''));
  cat       text := upper(nullif(btrim(coalesce(p_category, '')), ''));
  crit      text := nullif(btrim(coalesce(p_criticality, '')), '');
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
    contract := null;
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
    -- A private contract says which: AMC, or CAMC (rl_0024).
    if bemmp.asks_contract then
      if contract is null or contract not in ('AMC', 'CAMC') then
        raise exception 'Choose the contract type — AMC or CAMC';
      end if;
    else
      contract := null;
    end if;
  end if;
  if length(coalesce(make, '')) > 80 or length(coalesce(model, '')) > 80 then
    raise exception 'Keep the make and the model under 80 characters';
  end if;

  -- A CAMC spare is critical, whoever raises it.
  if contract = 'CAMC' then
    if crit = 'non_critical' then
      raise exception 'A CAMC spare is always critical';
    end if;
    crit := 'critical';
  end if;
  -- The desk's raise is its acceptance (rl_0023), so it says what the spare is now.
  if as_co then
    if cat is null or cat not in ('A', 'B', 'C') then
      raise exception 'Choose the spare category — A, B or C';
    end if;
    if crit is null or crit not in ('critical', 'non_critical') then
      raise exception 'Choose whether the spare is critical or non-critical';
    end if;
  else
    -- The field does not classify it: the Revive Lab does, on arrival.
    cat := null;
    if contract is distinct from 'CAMC' then crit := null; end if;
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
    stakeholder_id, raised_by, raised_as, contract_type, spare_category, criticality, accepted_at)
  values (
    case when far then 'awaiting_approval' when as_co then 'accepted' else 'pending_acceptance' end,
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
    holder, me, case when as_co then 'coordinator' else 'engineer' end,
    contract, cat, crit,
    case when as_co then now() end)
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
    -- Raised at the desk, the spare is already there: accepted as it is raised (rl_0023).
    if as_co then
      perform revive_log(t.id, 'accepted', 'pending_acceptance', t.trc_id,
        concat_ws(' · ', 'Accepted on arrival — raised at the Revive Lab', 'Category ' || cat, revive_crit_label(crit)));
    end if;
  end if;

  return jsonb_build_object('id', t.id, 'code', t.code, 'number', t.number, 'status', t.status);
end $fn$;

revoke all on function public.revive_raise_ticket(
  uuid, text, text, uuid, text, text, text, text, text, text, text, text, text, text, date, uuid, jsonb, boolean, text, text, text,
  text, uuid, text, text, text)
  from public, anon;
grant execute on function public.revive_raise_ticket(
  uuid, text, text, uuid, text, text, text, text, text, text, text, text, text, text, date, uuid, jsonb, boolean, text, text, text,
  text, uuid, text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------
-- The ticket list: all of it, and when it went back
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
  spare_category text, criticality text, contract_type text, accepted_at timestamptz, dispatched_at timestamptz)
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
           where ev.ticket_id = t.id and ev.kind = 'status' and ev.status = 'in_transit_return')
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
