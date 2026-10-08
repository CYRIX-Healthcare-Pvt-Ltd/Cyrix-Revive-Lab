-- =====================================================================
-- Revive Lab · rl_0049 · No project head, no approval
--
-- The user, 8 Oct: "without head bemmp also no regional trc manager
-- approval needed." Another state's Revive Lab is approved only by the
-- ticket's BEMMP project head. With no head there is nobody to ask: a raise
-- goes straight to it, a transfer is approved at once for the desk to
-- send, and a return goes back there directly.
-- =====================================================================

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
    the desk raised in their name is theirs to close too.

    Nor does the desk raise in the name of a field engineer who is held
    (rl_0042; the user, 3 Oct: "coordinator cannot raise bcz from eng it is
    pending"). Only they can confirm or close those spares. A warehouse's
    card names its in-charge, not a field engineer, and is not held.
  */
  if not as_co then
    select count(*)::int, string_agg(o.code, ', ' order by o.days desc, o.number)
      into late_n, late_list
      from revive_overdue_returns(me) o;
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
end $function$
;

CREATE OR REPLACE FUNCTION public.revive_request_transfer(p_ticket_id uuid, p_to_trc_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t    revive_tickets := revive_lock(p_ticket_id);
  dest revive_trcs;
  why  text := btrim(coalesce(p_reason, ''));
  a    revive_approvals;
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator of this Revive Lab can transfer it';
  end if;
  if t.status not in ('accepted', 'assigned', 'in_repair') then
    raise exception 'Accept the ticket before transferring it, and transfer it before it is repaired';
  end if;
  select * into dest from revive_trcs where id = p_to_trc_id and is_active;
  if not found then raise exception 'Choose the Revive Lab it is going to'; end if;
  if dest.id = t.trc_id then raise exception 'It is already at that Revive Lab'; end if;
  if length(why) < 5 then raise exception 'Say why it is being transferred'; end if;
  if length(why) > 500 then raise exception 'Keep the reason under 500 characters'; end if;

  insert into revive_approvals (ticket_id, kind, from_trc_id, asked_trc_id, to_trc_id, reason, back_to, requested_by)
  values (t.id, 'transfer', t.trc_id, dest.id, dest.id, why, t.status, current_employee_id())
  returning * into a;
  -- No project head to ask (rl_0049): approved at once, and the desk sends it.
  if a.head_id is null then
    update revive_approvals
       set status = 'approved', decided_by = current_employee_id(), decided_at = now(), updated_at = now()
     where id = a.id;
    update revive_tickets set status = 'approved', updated_at = now() where id = t.id;
    perform revive_step(t.id, 'approved', t.status, t.trc_id, 'status', 'transfer_requested',
      'To ' || dest.name || ': ' || why);
    return;
  end if;
  -- The engineer keeps it: a transfer that is not approved carries on with them.
  update revive_tickets set status = 'awaiting_approval', updated_at = now() where id = t.id;
  perform revive_step(t.id, 'awaiting_approval', t.status, t.trc_id, 'status', 'transfer_requested',
    'To ' || dest.name || ': ' || why);
end $function$
;

CREATE OR REPLACE FUNCTION public.revive_return_to_lab(p_ticket_id uuid, p_reason text, p_courier text, p_awb text, p_dispatched_on date, p_photos text[] DEFAULT NULL::text[], p_video text DEFAULT NULL::text, p_voice text DEFAULT NULL::text, p_trc_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t     revive_tickets := revive_lock(p_ticket_id);
  lab   revive_trcs;
  who   text;
  why   text := btrim(coalesce(p_reason, ''));
  c     text := nullif(btrim(coalesce(p_courier, '')), '');
  w     text := nullif(btrim(coalesce(p_awb, '')), '');
  shots text[] := coalesce(p_photos, '{}');
  vid   text := nullif(btrim(coalesce(p_video, '')), '');
  voc   text := nullif(btrim(coalesce(p_voice, '')), '');
  -- The round this return starts: its files carry it, resend-1-r2 and so on.
  nxt   text := '-r' || (jsonb_array_length(t.field_returns) + 2) || '\.[a-z0-9]+$';
  path  text;
begin
  if t.stakeholder_id is distinct from current_employee_id() then
    raise exception 'Only the field engineer it was sent back to can return it';
  end if;
  if t.status <> 'received_back' then
    raise exception 'Confirm the spare arrived before sending it back';
  end if;
  if length(why) < 5 then
    raise exception 'Say why it is going back — what is not working';
  end if;
  if length(why) > 500 then
    raise exception 'Keep the reason under 500 characters';
  end if;
  -- As when it was first sent: a photograph of it at least (rl_0030).
  if coalesce(array_length(shots, 1), 0) = 0 then
    raise exception 'Add a photo of the spare — one at least';
  end if;
  if array_length(shots, 1) > 2 then
    raise exception 'Two photographs, at most';
  end if;
  foreach path in array shots loop
    if not revive_file_ok(t.id, path, 'resend') or path !~ nxt then
      raise exception 'That is not a photograph of this spare going back';
    end if;
  end loop;
  if vid is not null and (not revive_file_ok(t.id, vid, 'resend_video') or vid !~ nxt) then
    raise exception 'That is not a video of this spare going back';
  end if;
  if voc is not null and (not revive_file_ok(t.id, voc, 'resend_voice') or voc !~ nxt) then
    raise exception 'That is not a voice note on this spare going back';
  end if;
  if c is null then raise exception 'Enter the courier it is going back with'; end if;
  if w is null then raise exception 'Enter the tracking / AWB number'; end if;
  if p_dispatched_on is null then raise exception 'Enter the date of dispatch'; end if;
  if length(c) > 80 or length(w) > 80 then
    raise exception 'Keep the courier and the tracking number under 80 characters';
  end if;
  -- A day's grace: current_date is the database's, and India is ahead of it.
  if p_dispatched_on > current_date + 1 then
    raise exception 'The date of dispatch cannot be in the future';
  end if;
  -- The same Revive Lab, or another one (rl_0046): the state's own and the Regional
  -- ones, as on the route card. Back to where it was is always allowed.
  select * into lab from revive_trcs where id = coalesce(p_trc_id, t.trc_id);
  if lab.id is null then raise exception 'Choose the Revive Lab it is going to'; end if;
  if not lab.is_active then
    raise exception '% is no longer taking tickets — choose another Revive Lab', lab.name;
  end if;
  -- Another state's Revive Lab once it is approved (rl_0047).
  if lab.id <> t.trc_id and lab.state is not null and lab.state is distinct from t.state
     -- No project head on its BEMMP: nobody to ask (rl_0049).
     and exists (select 1 from revive_bemmp_projects b where b.id = t.bemmp_id and b.head_id is not null)
     and not exists (select 1 from revive_approvals a where a.ticket_id = t.id and a.kind = 'return'
                       and a.status = 'approved' and a.to_trc_id = lab.id) then
    raise exception '% is in another state — ask for approval to send it there first', lab.name;
  end if;
  select full_name into who from employees where id = t.stakeholder_id;

  update revive_tickets
     set field_returns = field_returns || jsonb_build_array(jsonb_build_object(
           'at', now(), 'by', t.stakeholder_id, 'by_name', who, 'trc_name', lab.name,
           'reason', why, 'courier', c, 'awb', w, 'dispatched_on', p_dispatched_on,
           -- What it looked like going back (rl_0030).
           'photos', to_jsonb(shots), 'video', vid, 'voice', voc,
           -- The round that ended, all of it: the ticket's own fields start the next one.
           'before', jsonb_build_object(
             'in_courier', t.in_courier, 'in_awb', t.in_awb, 'in_dispatched_on', t.in_dispatched_on,
             'accepted_at', t.accepted_at, 'trc_id', t.trc_id,
             'trc_name_before', (select x.name from revive_trcs x where x.id = t.trc_id),
             'spare_category', t.spare_category, 'criticality', t.criticality,
             'arrival_damaged', t.arrival_damaged, 'arrival_photos', to_jsonb(t.arrival_photos),
             'engineer_id', t.engineer_id,
             'engineer_name', (select e.full_name from employees e where e.id = t.engineer_id),
             'engineer_ecode', (select e.ecode from employees e where e.id = t.engineer_id),
             'expected_by', t.expected_by,
             'outcome', t.outcome, 'proposal', t.proposal,
             'done_photos', to_jsonb(t.done_photos), 'done_video', t.done_video, 'done_voice', t.done_voice,
             'out_courier', t.out_courier, 'out_awb', t.out_awb, 'out_dispatched_on', t.out_dispatched_on,
             -- When the repair was closed: that round's category TAT ended there (rl_0030).
             'repaired_at', (select max(ev.at) from revive_ticket_events ev
                              where ev.ticket_id = t.id and ev.kind = 'status'
                                and ev.status in ('repaired', 'not_repairable', 'service_denied')
                                and (t.accepted_at is null or ev.at >= t.accepted_at)),
             -- When it went back.
             'dispatched_at', (select min(ev.at) from revive_ticket_events ev
                                where ev.ticket_id = t.id and ev.kind = 'status' and ev.status = 'in_transit_return'
                                  and (t.accepted_at is null or ev.at >= t.accepted_at)),
             'billing_estimate', t.billing_estimate,
             'received_at', t.received_at, 'return_damaged', t.return_damaged,
             'return_photos', to_jsonb(t.return_photos)))),
         status = 'pending_acceptance',
         trc_id = lab.id, trc_kind = lab.kind,
         in_courier = c, in_awb = w, in_dispatched_on = p_dispatched_on,
         -- A new round: its TAT starts when it is accepted again, any engineer may have it.
         accepted_at = null, engineer_id = null, expected_by = null,
         outcome = null, proposal = null, closure = null,
         arrival_damaged = false, arrival_photos = '{}',
         done_photos = '{}', done_video = null, done_voice = null,
         out_courier = null, out_awb = null, out_dispatched_on = null,
         billing_estimate = null,
         received_at = null, return_damaged = false, return_photos = '{}',
         updated_at = now()
   where id = t.id;
  update revive_approvals
     set status = case when to_trc_id = lab.id then 'sent' else 'cancelled' end, updated_at = now()
   where ticket_id = t.id and kind = 'return' and status = 'approved';
  perform revive_step(t.id, 'pending_acceptance', t.status, lab.id, 'status', 'field_return',
    case when lab.id <> t.trc_id then 'To ' || lab.name || E'\n' else '' end || why || E'\n' || concat_ws(' · ', c, 'AWB ' || w, 'dispatched ' || to_char(p_dispatched_on, 'FMDD Mon YYYY')));
end $function$
;

CREATE OR REPLACE FUNCTION public.revive_request_return(p_ticket_id uuid, p_to_trc_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t    revive_tickets := revive_lock(p_ticket_id);
  dest revive_trcs;
  why  text := btrim(coalesce(p_reason, ''));
begin
  if t.stakeholder_id is distinct from current_employee_id() then
    raise exception 'Only the field engineer it was sent back to can return it';
  end if;
  if t.status <> 'received_back' then
    raise exception 'Confirm the spare arrived before sending it back';
  end if;
  select * into dest from revive_trcs where id = p_to_trc_id and is_active;
  if not found then raise exception 'Choose the Revive Lab it is going to'; end if;
  if dest.state is null or dest.state is not distinct from t.state or dest.id = t.trc_id
     or not exists (select 1 from revive_bemmp_projects b where b.id = t.bemmp_id and b.head_id is not null) then
    raise exception '% needs no approval — return it there directly', dest.name;
  end if;
  if length(why) < 5 then raise exception 'Say why it should go there'; end if;
  if length(why) > 500 then raise exception 'Keep the reason under 500 characters'; end if;
  update revive_approvals set status = 'cancelled', updated_at = now()
   where ticket_id = t.id and kind = 'return' and status = 'approved';

  insert into revive_approvals (ticket_id, kind, from_trc_id, asked_trc_id, to_trc_id, reason, back_to, requested_by)
  values (t.id, 'return', t.trc_id, dest.id, dest.id, why, t.status, current_employee_id());
  update revive_tickets set status = 'awaiting_approval', updated_at = now() where id = t.id;
  perform revive_step(t.id, 'awaiting_approval', t.status, t.trc_id, 'status', 'return_requested',
    'To ' || dest.name || ': ' || why);
end $function$
;

notify pgrst, 'reload schema';
