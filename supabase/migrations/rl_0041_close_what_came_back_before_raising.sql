/*
  rl_0041 — a field engineer closes what came back before raising another.

  Spares come back from the Revive Lab and are not closed: 67 in Kerala were
  in transit back on 3 Oct, some for nine days, nobody having said they
  arrived. Closing is where the field engineer says whether the spare works.
  Left open, a spare that fails later is the Revive Lab engineer's fault; once
  it is closed as working, it is not (the user, 3 Oct: "engineers are not
  closing tickets, and if not working they will blame trc engineer, bcz if
  they confirm it is working they cant blame the trc eng").

  So, per state, the software administrator sets two limits (the user: "for
  KL … close the ticket within 5 days … received back, and in transit 7
  days"; "admin should able to decide for each state"):

    - In transit back: days from the dispatch date the Revive Lab entered
      to the field engineer confirming it arrived (revive_mark_received).
    - Received back: days from that confirmation to the ticket being closed,
      working or not (revive_close_ticket).

  Either may be left empty, and a state with neither has no limit. Days are
  calendar days in India: dispatched on 24 Sep with a limit of 7, the spare
  may still be confirmed on 1 Oct, and holds its field engineer back from
  2 Oct.

  A field engineer with any spare past its state's limit cannot raise a new
  ticket until it is confirmed or closed: revive_raise_ticket refuses, and
  the app shows which tickets, since when, and opens each. Whose spare it is
  is the person it was sent back to (stakeholder_id), whoever raised it: the
  user, 3 Oct, "some tickets are raised by trc coord still that eng is
  assigned to field eng id, so for that field eng also this should be
  valid". The desk's own raise, for a spare already at its Revive Lab, is
  not held.

  Nothing changes until a limit is set: the table starts empty.
*/

create table if not exists public.revive_close_limits (
  state              text primary key,
  received_back_days integer check (received_back_days between 1 and 90),
  in_transit_days    integer check (in_transit_days between 1 and 90),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.employees(id),
  check (received_back_days is not null or in_transit_days is not null)
);
comment on table public.revive_close_limits is 'Per state: days a returned spare may stay in transit back unconfirmed, and back with the field engineer unclosed, before they may not raise another ticket (rl_0041).';

alter table public.revive_close_limits enable row level security;
drop policy if exists revive_close_limits_read on public.revive_close_limits;
create policy revive_close_limits_read on public.revive_close_limits for select to authenticated using (revive_has_access());
revoke all on public.revive_close_limits from anon, authenticated;
grant select on public.revive_close_limits to authenticated;

/** One person's spares past their state's limit, longest first. For the functions below; nobody calls it directly. */
create or replace function public.revive_overdue_returns(p_employee_id uuid)
returns table (ticket_id uuid, code text, number integer, status text, state text, facility text, spare_name text,
               equipment_name text, since date, days integer, limit_days integer)
language sql stable security definer set search_path to 'public' as $fn$
  with waiting as (
    select t.id, t.code, t.number, t.status, t.state, t.facility, t.spare_name, t.equipment_name,
           case when t.status = 'received_back' then (t.received_at at time zone 'Asia/Kolkata')::date
                else t.out_dispatched_on end as since,
           case when t.status = 'received_back' then l.received_back_days else l.in_transit_days end as limit_days
      from revive_tickets t
      join revive_close_limits l on l.state = t.state
     where t.stakeholder_id = p_employee_id
       and t.status in ('in_transit_return', 'received_back')
  )
  select w.id, w.code, w.number, w.status, w.state, w.facility, w.spare_name, w.equipment_name, w.since,
         ((now() at time zone 'Asia/Kolkata')::date - w.since)::integer, w.limit_days
    from waiting w
   where w.limit_days is not null and w.since is not null
     and (now() at time zone 'Asia/Kolkata')::date - w.since > w.limit_days
   order by 10 desc, w.number
$fn$;
revoke all on function public.revive_overdue_returns(uuid) from public, anon, authenticated;

/** What holds the signed-in person back from raising: the app's pop-up. Empty for almost everybody. */
create or replace function public.revive_my_overdue_returns()
returns jsonb language sql stable security definer set search_path to 'public' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.ticket_id, 'code', o.code, 'status', o.status, 'state', o.state, 'facility', o.facility,
           'spare_name', o.spare_name, 'equipment_name', o.equipment_name,
           'since', o.since, 'days', o.days, 'limit_days', o.limit_days) order by o.days desc, o.number), '[]'::jsonb)
    from revive_overdue_returns(current_employee_id()) o
$fn$;
revoke all on function public.revive_my_overdue_returns() from public, anon;
grant execute on function public.revive_my_overdue_returns() to authenticated;

/** Sets a state's two limits; both empty takes the state's limits away. The software administrator's alone. */
create or replace function public.revive_set_close_limit(p_state text, p_received_back_days integer, p_in_transit_days integer)
returns void language plpgsql security definer set search_path to 'public' as $fn$
declare
  st text := btrim(coalesce(p_state, ''));
  was revive_close_limits;
begin
  if not is_sw_admin() then
    raise exception 'Only the software administrator sets how long a returned spare may wait';
  end if;
  if length(st) < 2 or length(st) > 60 then
    raise exception 'Choose the state';
  end if;
  if p_in_transit_days is not null and p_in_transit_days not between 1 and 90 then
    raise exception 'In transit back: from 1 to 90 days, or leave it empty';
  end if;
  if p_received_back_days is not null and p_received_back_days not between 1 and 90 then
    raise exception 'Received back: from 1 to 90 days, or leave it empty';
  end if;
  select * into was from revive_close_limits where state = st;
  if p_received_back_days is null and p_in_transit_days is null then
    delete from revive_close_limits where state = st;
  else
    insert into revive_close_limits (state, received_back_days, in_transit_days, updated_at, updated_by)
    values (st, p_received_back_days, p_in_transit_days, now(), current_employee_id())
    on conflict (state) do update
      set received_back_days = excluded.received_back_days, in_transit_days = excluded.in_transit_days,
          updated_at = now(), updated_by = excluded.updated_by;
  end if;
  perform log_audit('revive_close_limit', md5('revive_close_limit:' || st)::uuid, case when p_received_back_days is null and p_in_transit_days is null then 'removed' else 'set' end,
    jsonb_build_object('state', st,
      'in_transit_days', p_in_transit_days, 'received_back_days', p_received_back_days,
      'was', case when was.state is null then null else jsonb_build_object('in_transit_days', was.in_transit_days, 'received_back_days', was.received_back_days) end));
end $fn$;
revoke all on function public.revive_set_close_limit(text, integer, integer) from public, anon;
grant execute on function public.revive_set_close_limit(text, integer, integer) to authenticated;

/**
 * What a state's limits would do today, before they are saved: how many spares wait there at all and
 * the longest, and how many field engineers these numbers would hold back, over how many tickets.
 */
create or replace function public.revive_close_limit_preview(p_state text, p_received_back_days integer, p_in_transit_days integer)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare out jsonb;
begin
  if not is_sw_admin() then
    raise exception 'Only the software administrator sets how long a returned spare may wait';
  end if;
  with waiting as (
    select t.stakeholder_id, t.status,
           (now() at time zone 'Asia/Kolkata')::date
             - case when t.status = 'received_back' then (t.received_at at time zone 'Asia/Kolkata')::date else t.out_dispatched_on end as days
      from revive_tickets t
     where t.state = btrim(coalesce(p_state, '')) and t.status in ('in_transit_return', 'received_back')
  ), judged as (
    select *, coalesce(case when status = 'received_back' then days > p_received_back_days else days > p_in_transit_days end, false) as late
      from waiting
  )
  select jsonb_build_object(
           'in_transit', count(*) filter (where status = 'in_transit_return'),
           'in_transit_oldest', max(days) filter (where status = 'in_transit_return'),
           'received_back', count(*) filter (where status = 'received_back'),
           'received_back_oldest', max(days) filter (where status = 'received_back'),
           'late_tickets', count(*) filter (where late),
           'late_people', count(distinct stakeholder_id) filter (where late))
    into out from judged;
  return out;
end $fn$;
revoke all on function public.revive_close_limit_preview(text, integer, integer) from public, anon;
grant execute on function public.revive_close_limit_preview(text, integer, integer) to authenticated;

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
  late_n    integer;
  late_list text;
begin
  if me is null then raise exception 'Only a signed-in employee can raise a ticket'; end if;
  if not revive_has_access() then
    raise exception 'Revive Lab has not been given to you yet — ask the software administrator';
  end if;
  -- Whoever sends spares in raises them: the field, or a Revive Lab's desk.
  -- Its engineers repair what arrives, its manager approves, Purchase buys for it, and an observer only watches (rl_0019, rl_0036, rl_0039).
  if not is_sw_admin() and exists (
       select 1 from revive_members m
        where m.employee_id = me and (m.is_engineer or m.is_purchase or m.is_manager or (m.is_observer and not m.may_raise))
          and not (m.is_coordinator or m.is_admin)) then
    raise exception 'Tickets are raised by the field engineer or a Revive Lab coordinator — not by a Revive Lab engineer, manager, observer or Purchase';
  end if;
  if src not in ('hospital', 'warehouse') then
    raise exception 'A spare comes from a hospital or a warehouse';
  end if;

  select * into trc from revive_trcs where id = p_trc_id and is_active;
  if not found then raise exception 'Choose the Revive Lab the spare is going to'; end if;
  as_co := revive_runs_trc(p_trc_id);

  /*
    A field engineer closes what has come back to them before raising
    another (rl_0041): a spare in transit back that they have not confirmed
    arriving, or one back with them that they have not closed as working or
    not, past the days the software administrator set for its state. Whose
    it is is the person it was sent back to, whoever raised it — a ticket
    the desk raised in their name is theirs to close too. The desk's own
    raise is for a spare already at its Revive Lab, and is not held.
  */
  if not as_co then
    select count(*)::int, string_agg(o.code, ', ' order by o.days desc, o.number)
      into late_n, late_list
      from revive_overdue_returns(me) o;
    if late_n > 0 then
      raise exception 'Close % first — % past the days allowed for a spare that came back to you. Then you can raise a new ticket.',
        late_list, case when late_n = 1 then 'it is' else 'they are' end;
    end if;
  end if;

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
