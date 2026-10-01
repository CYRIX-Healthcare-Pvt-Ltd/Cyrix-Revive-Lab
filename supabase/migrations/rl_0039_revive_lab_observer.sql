/*
  rl_0039 — the Revive Lab Observer: somebody who only watches.

  The user, 1 Oct: "some users example a managers they need to just see
  only tickets just to know the status" — "we can set a new role ie Revive
  Lab Observer" — "for observer just basic dashboard without waiting for
  you, and ticket log".

  revive_members.is_observer is a fifth box beside Engineer, Coordinator,
  Manager and Purchase, ticked on People & Revive Labs with the Revive
  Labs it is for. An observer sees every ticket at those Revive Labs — and
  what a ticket carries: its history, its photographs, its components —
  exactly as its desk does, and can change nothing: no function lets an
  observer in. Like an engineer, a manager and Purchase, an observer raises
  no ticket unless they also run a desk.

  - revive_can_see: the Revive Lab's observers, where its coordinators and
    managers already were.
  - revive_me and revive_member_list say who is one (a column more, so each
    is dropped and made again; nothing depends on either).
  - revive_save_member takes p_observer. Left out — by a page from before
    this — it keeps what the person had, as p_purchase does.
  - revive_raise_ticket refuses an observer who has no desk role.
*/

alter table public.revive_members
  add column if not exists is_observer boolean not null default false;

comment on column public.revive_members.is_observer is
  'Revive Lab Observer: sees the tickets of the Revive Labs ticked for them, and changes nothing (rl_0039).';

-- ---------------------------------------------------------------------
-- Who sees a ticket
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revive_can_see(p_ticket_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from revive_tickets t
    where t.id = p_ticket_id
      and (
        -- Whoever it belongs to: the field engineer, whoever wrote the card,
        -- the engineer repairing it, and the field engineer's managers.
        t.stakeholder_id = current_employee_id()
        or t.raised_by = current_employee_id()
        or t.engineer_id = current_employee_id()
        or is_in_my_downline(t.stakeholder_id)
        -- The managers of anyone who held it before a transfer (rl_0029):
        -- following only the one holding it now lost it for the first team.
        or exists (
          select 1 from revive_handovers h
          where h.ticket_id = t.id and h.status = 'accepted' and is_in_my_downline(h.from_id))
        -- Every Revive Lab admin, and the software administrator.
        or revive_is_admin()
        -- A Regional Revive Lab's manager sees every Revive Lab's work.
        or exists (
          select 1 from revive_members m
          join revive_member_trcs mt on mt.employee_id = m.employee_id
          join revive_trcs l on l.id = mt.trc_id
          where m.employee_id = current_employee_id() and m.is_manager and l.state is null)
        -- The desk of the Revive Lab that has it, or that sent it on — its manager and its observers too (rl_0039).
        or exists (
          select 1 from revive_members m
          join revive_member_trcs mt on mt.employee_id = m.employee_id
          where m.employee_id = current_employee_id()
            and (m.is_coordinator or m.is_manager or m.is_observer)
            and (mt.trc_id = t.trc_id
                 or mt.trc_id in (select x.from_trc_id from revive_transfers x where x.ticket_id = t.id)))
        -- Purchase, where a purchase request brought it to them.
        or exists (
          select 1 from revive_part_requests r
          join revive_member_trcs mt on mt.trc_id = r.trc_id
          join revive_members m on m.employee_id = mt.employee_id
          where r.ticket_id = t.id and r.route = 'purchase'
            and m.employee_id = current_employee_id() and m.is_purchase)
        -- The field engineer asked to take it over, while they decide (rl_0028).
        or exists (
          select 1 from revive_handovers h
          where h.ticket_id = t.id and h.status = 'pending' and h.to_id = current_employee_id())
      )
  )
$function$;

-- ---------------------------------------------------------------------
-- Who I am, and who everybody is
-- ---------------------------------------------------------------------
drop function public.revive_me();

create function public.revive_me()
returns table(employee_id uuid, is_engineer boolean, is_coordinator boolean, is_manager boolean, is_admin boolean,
              is_sw_admin boolean, trc_ids uuid[], is_purchase boolean, approves boolean, is_observer boolean)
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
    coalesce(m.is_purchase, false),
    revive_approves(),
    coalesce(m.is_observer, false)
  from employees e
  left join revive_members m on m.employee_id = e.id
  where e.id = current_employee_id()
$fn$;
revoke all on function public.revive_me() from public, anon;
grant execute on function public.revive_me() to authenticated, service_role;

drop function public.revive_member_list();

create function public.revive_member_list()
returns table(employee_id uuid, ecode text, full_name text, designation text, is_engineer boolean, is_coordinator boolean,
              is_manager boolean, is_admin boolean, trc_ids uuid[], updated_at timestamptz, updated_by_name text,
              is_purchase boolean, is_observer boolean)
language sql stable security definer set search_path to 'public'
as $fn$
  select m.employee_id, e.ecode, e.full_name, e.designation,
         m.is_engineer, m.is_coordinator, m.is_manager, m.is_admin,
         coalesce((select array_agg(mt.trc_id order by mt.trc_id) from revive_member_trcs mt
                   where mt.employee_id = m.employee_id), '{}'),
         m.updated_at, u.full_name, m.is_purchase, m.is_observer
  from revive_members m
  join employees e on e.id = m.employee_id
  left join employees u on u.id = m.updated_by
  where revive_has_access()
  order by e.full_name
$fn$;
revoke all on function public.revive_member_list() from public, anon;
grant execute on function public.revive_member_list() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Saving a person's boxes
-- ---------------------------------------------------------------------
drop function public.revive_save_member(uuid, boolean, boolean, boolean, boolean, uuid[], boolean);

create function public.revive_save_member(
  p_employee_id uuid, p_engineer boolean, p_coordinator boolean, p_manager boolean, p_admin boolean,
  p_trc_ids uuid[], p_purchase boolean default null, p_observer boolean default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  me       uuid := current_employee_id();
  purchase boolean := coalesce(p_purchase,
                        (select m.is_purchase from revive_members m where m.employee_id = p_employee_id),
                        false);
  -- Left out by a page from before rl_0039: what they had stays.
  observer boolean := coalesce(p_observer,
                        (select m.is_observer from revive_members m where m.employee_id = p_employee_id),
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

  if not (p_engineer or p_coordinator or p_manager or p_admin or purchase or observer)
     and coalesce(array_length(p_trc_ids, 1), 0) = 0 then
    delete from revive_members where employee_id = p_employee_id;
    perform log_audit('revive_member', p_employee_id, 'removed', '{}'::jsonb);
    return;
  end if;

  insert into revive_members (employee_id, is_engineer, is_coordinator, is_manager, is_admin, is_purchase, is_observer, updated_at, updated_by)
  values (p_employee_id, p_engineer, p_coordinator, p_manager, p_admin, purchase, observer, now(), me)
  on conflict (employee_id) do update
  set is_engineer = excluded.is_engineer,
      is_coordinator = excluded.is_coordinator,
      is_manager = excluded.is_manager,
      is_admin = excluded.is_admin,
      is_purchase = excluded.is_purchase,
      is_observer = excluded.is_observer,
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
    'admin', p_admin, 'purchase', purchase, 'observer', observer, 'trcs', to_jsonb(coalesce(p_trc_ids, '{}'))));
end $fn$;
revoke all on function public.revive_save_member(uuid, boolean, boolean, boolean, boolean, uuid[], boolean, boolean) from public, anon;
grant execute on function public.revive_save_member(uuid, boolean, boolean, boolean, boolean, uuid[], boolean, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- An observer raises no ticket
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revive_raise_ticket(p_trc_id uuid, p_hospital text, p_state text, p_bemmp_id uuid, p_district text, p_source_ticket_no text, p_equipment_name text, p_equipment_barcode text, p_spare_name text, p_issue text, p_return_address text, p_contact_number text, p_in_courier text, p_in_awb text, p_in_dispatched_on date, p_stakeholder_id uuid DEFAULT NULL::uuid, p_items jsonb DEFAULT NULL::jsonb, p_billing_spare boolean DEFAULT NULL::boolean, p_approval_reason text DEFAULT NULL::text, p_equipment_make text DEFAULT NULL::text, p_equipment_model text DEFAULT NULL::text, p_source text DEFAULT 'hospital'::text, p_warehouse_id uuid DEFAULT NULL::uuid, p_contract_type text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_criticality text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- Its engineers repair what arrives, its manager approves, Purchase buys for it, and an observer only watches (rl_0019, rl_0036, rl_0039).
  if not is_sw_admin() and exists (
       select 1 from revive_members m
        where m.employee_id = me and (m.is_engineer or m.is_purchase or m.is_manager or m.is_observer)
          and not (m.is_coordinator or m.is_admin)) then
    raise exception 'Tickets are raised by the field engineer or a Revive Lab coordinator — not by a Revive Lab engineer, manager, observer or Purchase';
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
      raise exception 'Only a Revive Lab coordinator raises a ticket for a spare from a warehouse';
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
end $function$;
