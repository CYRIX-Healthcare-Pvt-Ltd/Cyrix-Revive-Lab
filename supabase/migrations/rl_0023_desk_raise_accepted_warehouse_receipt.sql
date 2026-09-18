/*
  rl_0023 — the desk's own raise is accepted as it is raised, and a
  warehouse's spare is closed when it arrives back.

  - A coordinator or manager raises a ticket for a spare already at their
    Revive Lab: it starts accepted (the history shows it raised, then
    accepted on arrival), with nothing left to accept.
  - A warehouse keeps what comes back as stock and cannot test it, so the
    in-charge confirming it arrived — with the transit-damage tick and
    photographs as before — closes the ticket. A hospital's spare still
    goes Received back, then closed as working or not.
*/

CREATE OR REPLACE FUNCTION public.revive_raise_ticket(p_trc_id uuid, p_hospital text, p_state text, p_bemmp_id uuid, p_district text, p_source_ticket_no text, p_equipment_name text, p_equipment_barcode text, p_spare_name text, p_issue text, p_return_address text, p_contact_number text, p_in_courier text, p_in_awb text, p_in_dispatched_on date, p_stakeholder_id uuid DEFAULT NULL::uuid, p_items jsonb DEFAULT NULL::jsonb, p_billing_spare boolean DEFAULT NULL::boolean, p_approval_reason text DEFAULT NULL::text, p_equipment_make text DEFAULT NULL::text, p_equipment_model text DEFAULT NULL::text, p_source text DEFAULT 'hospital'::text, p_warehouse_id uuid DEFAULT NULL::uuid)
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
    -- Raised at the desk, the spare is already there: accepted as it is raised (rl_0023).
    if as_co then
      perform revive_log(t.id, 'accepted', 'pending_acceptance', t.trc_id, 'Accepted on arrival — raised at the Revive Lab');
    end if;
  end if;

  return jsonb_build_object('id', t.id, 'code', t.code, 'number', t.number, 'status', t.status);
end $function$;

CREATE OR REPLACE FUNCTION public.revive_mark_received(p_ticket_id uuid, p_note text DEFAULT NULL::text, p_damaged boolean DEFAULT false, p_photos text[] DEFAULT NULL::text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t      revive_tickets := revive_lock(p_ticket_id);
  photos text[] := coalesce(p_photos, '{}');
  path   text;
  -- A warehouse keeps it as stock: received is the end of it, nothing is fitted (rl_0023).
  next   text := case when t.source = 'warehouse' then 'closed' else 'received_back' end;
begin
  -- The one person who can know it arrived is the one it arrived to. The
  -- Revive Lab sent it, and can only guess.
  if t.stakeholder_id is distinct from current_employee_id() then
    raise exception 'Only the person it was sent back to can confirm it arrived';
  end if;
  if t.status <> 'in_transit_return' then
    raise exception 'This spare has not been dispatched back yet';
  end if;
  if array_length(photos, 1) > 2 then
    raise exception 'Two photographs, at most';
  end if;
  foreach path in array photos loop
    if not revive_file_ok(t.id, path, 'return') then
      raise exception 'That is not a photograph of this spare arriving back';
    end if;
  end loop;
  if coalesce(p_damaged, false) and coalesce(array_length(photos, 1), 0) = 0 then
    raise exception 'Photograph the damage — it is the only proof there will be';
  end if;

  update revive_tickets
     set status = next, received_at = now(),
         closed_at = case when next = 'closed' then now() else closed_at end,
         closure = case when next = 'closed' then coalesce(closure, 'returned') else closure end,
         return_damaged = coalesce(p_damaged, false), return_photos = photos, updated_at = now()
   where id = t.id;
  perform revive_step(t.id, next, t.status, t.trc_id, 'status',
    case when coalesce(p_damaged, false) then 'damaged' when next = 'closed' then 'received_stock' end,
    concat_ws(' · ',
      case when coalesce(p_damaged, false) then 'Damaged in transit' end,
      nullif(btrim(coalesce(p_note, '')), '')));
end $function$;
