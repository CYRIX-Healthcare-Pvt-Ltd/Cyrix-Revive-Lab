-- Revive Lab · rl_0057 · OTS / Stock, observers name the field engineer, the route card edited
-- The user, 23 Oct:
--  · Pvt's contract types gain OTS / Stock; such a spare asks no hospital (and no photo, in the app).
--  · An observer ticked "May raise tickets" names the field engineer it belongs to, as the coordinator does.
--  · Whoever raised a ticket can correct what they entered on the route card — the field engineer until the
--    Revive Lab accepts it, the coordinator until it is dispatched back. Each change is a step in the history.

alter table public.revive_tickets drop constraint revive_tickets_contract_check;
alter table public.revive_tickets add constraint revive_tickets_contract_check
  check (contract_type is null or contract_type = any (array['AMC', 'CAMC', 'OTS']));

alter table public.revive_ticket_events drop constraint revive_ticket_events_kind_check;
alter table public.revive_ticket_events add constraint revive_ticket_events_kind_check check (kind = any (array[
  'status', 'observation', 'courier', 'component', 'eta', 'classify', 'handover', 'review', 'edit']));

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
  -- An observer ticked "May raise tickets" names the field engineer it belongs to, as the desk does (rl_0057).
  obs_raise boolean := exists (select 1 from revive_members m where m.employee_id = current_employee_id() and m.is_observer and m.may_raise);
  ots       boolean;
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
    the desk raised in their name is theirs to close too.

    Nor does the desk raise in the name of a field engineer who is held
    (rl_0042; the user, 3 Oct: "coordinator cannot raise bcz from eng it is
    pending"). Only they can confirm or close those spares. A warehouse's
    card names its in-charge, not a field engineer, and is not held.
  */
  if not as_co then
    select count(*)::int, string_agg(o.code, ', ' order by o.days desc, o.number)
      into late_n, late_list
      from revive_overdue_returns(case when obs_raise and p_stakeholder_id is not null then p_stakeholder_id else me end) o;
    if late_n > 0 and obs_raise and p_stakeholder_id is not null then
      raise exception '% has % to close first, past the days allowed for a spare that came back to them.',
        coalesce((select full_name from employees where id = p_stakeholder_id), 'This field engineer'), late_list;
    end if;
    if late_n > 0 then
      raise exception 'Close % first — % past the days allowed for a spare that came back to you. Then you can raise a new ticket.',
        late_list, case when late_n = 1 then 'it is' else 'they are' end;
    end if;
  elsif src = 'hospital' and p_stakeholder_id is not null then
    select count(*)::int, string_agg(o.code, ', ' order by o.days desc, o.number)
      into late_n, late_list
      from revive_overdue_returns(p_stakeholder_id) o;
    if late_n > 0 then
      raise exception '% has % to close first, past the days allowed for a spare that came back to them. A ticket can be raised in their name once they have confirmed or closed %.',
        coalesce((select full_name from employees where id = p_stakeholder_id), 'This field engineer'), late_list,
        case when late_n = 1 then 'it' else 'them' end;
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
    -- A private contract says which: AMC, CAMC, or OTS / Stock (rl_0024, rl_0057).
    if bemmp.asks_contract then
      if contract is null or contract not in ('AMC', 'CAMC', 'OTS') then
        raise exception 'Choose the contract type — AMC, CAMC or OTS / Stock';
      end if;
    else
      contract := null;
    end if;
    -- OTS / Stock asks no hospital (rl_0057).
    ots := contract = 'OTS';
    if not ots and length(btrim(coalesce(p_hospital, ''))) < 2 then
      raise exception 'Enter the hospital the spare came from';
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
  if not as_co and obs_raise and p_stakeholder_id is null then
    raise exception 'Name the field engineer this spare belongs to, so they and their manager can follow it';
  end if;
  if not as_co and not obs_raise and holder <> me then
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
  -- Only where the BEMMP has a project head, who approves it (rl_0049); otherwise it simply goes.
  far := not as_co and trc.state is not null and trc.state <> st
         and exists (select 1 from revive_bemmp_projects b where b.id = p_bemmp_id and b.head_id is not null);
  if far and length(why) < 5 then
    raise exception '% is not a Revive Lab for % — say why it should go there, and the project head approves it first', trc.name, st;
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
    case when src = 'warehouse' then wh.name else coalesce(nullif(btrim(coalesce(p_hospital, '')), ''), 'OTS / Stock') end,
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
end $function$
;

create or replace function public.revive_can_edit_card(t revive_tickets)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select t.raised_by = current_employee_id()
     and case when t.raised_as = 'coordinator'
              then t.status not in ('in_transit_return', 'received_back', 'closed')
              else t.status in ('awaiting_approval', 'approved', 'not_approved', 'pending_acceptance') end
$function$;

create or replace function public.revive_edit_ticket(
  p_ticket_id uuid, p_hospital text, p_district text, p_source_ticket_no text,
  p_equipment_name text, p_equipment_barcode text, p_equipment_make text, p_equipment_model text,
  p_items jsonb, p_issue text, p_return_address text, p_contact_number text, p_stakeholder_id uuid default null)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  t       revive_tickets := revive_lock(p_ticket_id);
  hosp    text := nullif(btrim(coalesce(p_hospital, '')), '');
  dist    text := nullif(btrim(coalesce(p_district, '')), '');
  tid     text := nullif(btrim(coalesce(p_source_ticket_no, '')), '');
  ename   text := nullif(btrim(coalesce(p_equipment_name, '')), '');
  ebar    text := nullif(btrim(coalesce(p_equipment_barcode, '')), '');
  emake   text := nullif(btrim(coalesce(p_equipment_make, '')), '');
  emodel  text := nullif(btrim(coalesce(p_equipment_model, '')), '');
  iss     text := btrim(coalesce(p_issue, ''));
  addr    text := btrim(coalesce(p_return_address, ''));
  phone   text := nullif(regexp_replace(coalesce(p_contact_number, ''), '[^0-9+]', '', 'g'), '');
  holder  uuid := coalesce(p_stakeholder_id, t.stakeholder_id);
  entries jsonb := '[]'::jsonb;
  entry   jsonb;
  k       text;
  n       text;
  changes text[] := '{}';
  was     text;
  now_is  text;
begin
  if t.id is null then raise exception 'That ticket does not exist'; end if;
  if not revive_can_edit_card(t) then
    raise exception '%', case when t.raised_by is distinct from current_employee_id()
      then 'Only whoever raised it can edit the route card'
      when t.raised_as = 'coordinator' then 'The route card can be edited until it is dispatched back'
      else 'The route card can be edited until the Revive Lab accepts it' end;
  end if;

  if t.source = 'warehouse' then
    hosp := t.facility; dist := null; tid := null;
  else
    if hosp is null and t.contract_type = 'OTS' then hosp := 'OTS / Stock'; end if;
    if hosp is null or length(hosp) < 2 then raise exception 'Enter the hospital the spare came from'; end if;
    if length(hosp) > 200 then raise exception 'Keep the hospital name under 200 characters'; end if;
    if dist is null or length(dist) < 2 then raise exception 'Choose the district'; end if;
  end if;
  if length(coalesce(emake, '')) > 80 or length(coalesce(emodel, '')) > 80 then
    raise exception 'Keep the make and the model under 80 characters';
  end if;
  if length(iss) < 3 then raise exception 'Describe the issue identified'; end if;
  if length(addr) < 5 then raise exception 'Enter the address the spare should be returned to'; end if;
  if phone is not null and length(phone) not between 7 and 15 then raise exception 'That contact number does not look right'; end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'List the spares and accessories'; end if;
  for entry in select value from jsonb_array_elements(p_items) loop
    k := entry->>'kind';
    n := btrim(coalesce(entry->>'name', ''));
    continue when n = '';
    if k is null or k not in ('spare', 'accessory', 'full_machine') then raise exception 'Each line is a spare, an accessory or a full machine'; end if;
    if length(n) < 2 then raise exception 'Enter the name of each spare and accessory'; end if;
    if length(n) > 120 then raise exception 'Keep each name under 120 characters'; end if;
    entries := entries || jsonb_build_array(jsonb_build_object('kind', k, 'name', n));
  end loop;
  if jsonb_array_length(entries) = 0 then raise exception 'Enter the spare''s name'; end if;
  if jsonb_array_length(entries) > 10 then raise exception 'A ticket carries at most 10 spares and accessories'; end if;

  -- The field engineer it belongs to is the desk's to name, and an observer's who raised it (rl_0057).
  if holder is distinct from t.stakeholder_id then
    if t.raised_as <> 'coordinator' and not exists (
         select 1 from revive_members m where m.employee_id = current_employee_id() and m.is_observer and m.may_raise) then
      raise exception 'The field engineer it belongs to cannot be changed here';
    end if;
    if not exists (select 1 from employees where id = holder and is_active) then
      raise exception 'That field engineer is not an active employee';
    end if;
  end if;

  if hosp is distinct from t.facility and t.source <> 'warehouse' then changes := changes || format('Hospital: %s → %s', coalesce(t.facility, '—'), hosp); end if;
  if dist is distinct from t.district and t.source <> 'warehouse' then changes := changes || format('District: %s → %s', coalesce(t.district, '—'), dist); end if;
  if ebar is distinct from t.equipment_barcode then changes := changes || format('Barcode: %s → %s', coalesce(t.equipment_barcode, '—'), coalesce(ebar, '—')); end if;
  if ename is distinct from t.equipment_name then changes := changes || format('Equipment: %s → %s', coalesce(t.equipment_name, '—'), coalesce(ename, '—')); end if;
  if emake is distinct from t.equipment_make then changes := changes || format('Make: %s → %s', coalesce(t.equipment_make, '—'), coalesce(emake, '—')); end if;
  if emodel is distinct from t.equipment_model then changes := changes || format('Model: %s → %s', coalesce(t.equipment_model, '—'), coalesce(emodel, '—')); end if;
  if entries is distinct from t.items then
    select string_agg(x->>'name', ', ') into was from jsonb_array_elements(t.items) x;
    select string_agg(x->>'name', ', ') into now_is from jsonb_array_elements(entries) x;
    changes := changes || format('Spares: %s → %s', coalesce(was, '—'), now_is);
  end if;
  if tid is distinct from t.source_ticket_no and t.source <> 'warehouse' then changes := changes || format('Ticket ID: %s → %s', coalesce(t.source_ticket_no, '—'), coalesce(tid, '—')); end if;
  if phone is distinct from t.contact_number then changes := changes || format('Contact: %s → %s', coalesce(t.contact_number, '—'), coalesce(phone, '—')); end if;
  if iss is distinct from t.issue then changes := changes || 'Issue changed'; end if;
  if addr is distinct from t.return_address then changes := changes || 'Return address changed'; end if;
  if holder is distinct from t.stakeholder_id then
    changes := changes || format('Field engineer: %s → %s',
      coalesce((select full_name from employees where id = t.stakeholder_id), '—'),
      (select full_name from employees where id = holder));
  end if;
  if cardinality(changes) = 0 then return; end if;

  update revive_tickets set
    facility = case when t.source = 'warehouse' then facility else hosp end,
    district = case when t.source = 'warehouse' then district else dist end,
    source_ticket_no = case when t.source = 'warehouse' then source_ticket_no else tid end,
    equipment_name = ename, equipment_barcode = ebar, equipment_make = emake, equipment_model = emodel,
    items = entries, spare_name = entries->0->>'name',
    issue = iss, return_address = addr, contact_number = phone, stakeholder_id = holder,
    updated_at = now()
  where id = t.id;

  insert into revive_ticket_events (ticket_id, status, from_status, trc_id, actor_id, note, kind)
  values (t.id, t.status, t.status, t.trc_id, current_employee_id(), left(array_to_string(changes, ' · '), 1000), 'edit');
end $function$;

revoke all on function public.revive_edit_ticket(uuid, text, text, text, text, text, text, text, jsonb, text, text, text, uuid) from public, anon;
grant execute on function public.revive_edit_ticket(uuid, text, text, text, text, text, text, text, jsonb, text, text, text, uuid) to authenticated;
revoke all on function public.revive_can_edit_card(revive_tickets) from public, anon;
grant execute on function public.revive_can_edit_card(revive_tickets) to authenticated;
