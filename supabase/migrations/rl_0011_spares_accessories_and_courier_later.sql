-- =====================================================================
-- rl_0011 — spares and accessories, and courier details added later
-- =====================================================================
--
-- One card, several things in the box. A field engineer sending a spare in
-- often sends what goes with it from the same machine — the power cable,
-- the probe, a second board — and the card had room for one spare name.
-- Now a ticket carries a list: each line a spare or an accessory, with its
-- name, in the order they were entered. At least one, at most ten.
--
-- spare_name stays, and now holds the first line's name. Lists, search,
-- the ticket's own heading and the delete audit all read it, and an app
-- still open from before this change raises tickets through it — so the
-- raise function keeps its old arguments, and a call without the list is
-- one spare, as it always was. Every ticket already raised becomes a list
-- of its one spare.
--
-- And the courier. A card is often raised before the spare is handed to a
-- courier, when there is no tracking number yet. Whoever sent it in — the
-- person who raised it, or the field engineer it belongs to — can now add
-- or correct the courier, the tracking number and the date of dispatch
-- until the Revive Lab accepts it. Each change is a step in the history,
-- so the Revive Lab can see when the tracking number arrived. Like an
-- observation, it moves nothing: no clock starts, and nobody is mailed.

-- ---------------------------------------------------------------------
-- What is in the box
-- ---------------------------------------------------------------------
alter table public.revive_tickets
  add column if not exists items jsonb not null default '[]'::jsonb;

alter table public.revive_tickets
  drop constraint if exists revive_tickets_items_is_a_list;
alter table public.revive_tickets
  add constraint revive_tickets_items_is_a_list check (jsonb_typeof(items) = 'array');

comment on column public.revive_tickets.items is
  'What was sent in, in order: [{"kind": "spare" | "accessory", "name": text}]. spare_name holds the first name.';

update public.revive_tickets
   set items = jsonb_build_array(jsonb_build_object('kind', 'spare', 'name', spare_name))
 where items = '[]'::jsonb
   and spare_name is not null;

-- ---------------------------------------------------------------------
-- A step for the courier details, beside moves and observations
-- ---------------------------------------------------------------------
alter table public.revive_ticket_events
  drop constraint if exists revive_ticket_events_kind_check;
alter table public.revive_ticket_events
  add constraint revive_ticket_events_kind_check check (kind in ('status', 'observation', 'courier'));

comment on column public.revive_ticket_events.kind is
  'status: the ticket moved (or was given to another engineer). observation: the engineer wrote down what they found. courier: the sender added or changed the courier details. Only status moves the ticket.';

/* The mail is for moves — not for an observation, not for a tracking number. */
create or replace function public.revive_queue_mail()
returns trigger
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  hook text;
begin
  if new.kind <> 'status' then
    return new;
  end if;

  insert into revive_mail_outbox (event_id, ticket_id)
  values (new.id, new.ticket_id)
  on conflict (event_id) do nothing;

  /*
    Nudge the sender now, if the database can make a web request.

    pg_net is optional on purpose. Without it the note still waits in the
    outbox, and the app drains the outbox after every action and on every
    load — so nothing is lost, it is only later. With it, the note goes
    within seconds, whatever changed the status.
  */
  select value into hook from revive_settings where key = 'notify_url';
  if hook is not null and to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is not null then
    begin
      execute 'select net.http_post(url := $1, body := $2, headers := $3)'
      using hook, '{"drain": true}'::jsonb, '{"Content-Type": "application/json"}'::jsonb;
    exception when others then
      -- A web request that cannot be queued must never undo a status
      -- change. The outbox row above is the promise; this was a courtesy.
      null;
    end;
  end if;
  return new;
end $fn$;

-- ---------------------------------------------------------------------
-- Raising a ticket: the list, with the old arguments still accepted
-- ---------------------------------------------------------------------
drop function if exists public.revive_raise_ticket(
  uuid, text, text, uuid, text, text, text, text, text, text, text, text, text, text, date, uuid);

create function public.revive_raise_ticket(
  p_trc_id            uuid,
  p_hospital          text,
  p_state             text,
  p_bemmp_id          uuid,
  p_district          text,
  p_source_ticket_no  text,
  p_equipment_name    text,
  p_equipment_barcode text,
  p_spare_name        text,
  p_issue             text,
  p_return_address    text,
  p_contact_number    text,
  p_in_courier        text,
  p_in_awb            text,
  p_in_dispatched_on  date,
  p_stakeholder_id    uuid default null,
  p_items             jsonb default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  me     uuid := current_employee_id();
  trc    revive_trcs;
  as_co  boolean;
  holder uuid;
  t      revive_tickets;
  clean  text;
  entries   jsonb := '[]'::jsonb;
  entry     jsonb;
  item_kind text;
  item_name text;
begin
  if me is null then raise exception 'Only a signed-in employee can raise a ticket'; end if;
  if not revive_has_access() then
    raise exception 'Revive Lab has not been given to you yet — ask the software administrator';
  end if;

  select * into trc from revive_trcs where id = p_trc_id and is_active;
  if not found then raise exception 'Choose the Revive Lab the spare is going to'; end if;

  if length(btrim(coalesce(p_state, ''))) < 2 then
    raise exception 'Choose the state';
  end if;
  if not exists (select 1 from revive_bemmp_projects where id = p_bemmp_id and is_active) then
    raise exception 'Choose the BEMMP';
  end if;
  if length(btrim(coalesce(p_district, ''))) < 2 then
    raise exception 'Choose the district';
  end if;
  if length(btrim(coalesce(p_hospital, ''))) < 2 then
    raise exception 'Enter the hospital the spare came from';
  end if;

  /*
    The list. Without one — an app from before this change — the spare name
    is the whole list. A line left blank is skipped rather than refused: it
    is an empty row, not a mistake.
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
      if item_kind is null or item_kind not in ('spare', 'accessory') then
        raise exception 'Each line is a spare or an accessory';
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

  as_co := revive_runs_trc(p_trc_id);
  holder := coalesce(p_stakeholder_id, me);

  if as_co and p_stakeholder_id is null then
    raise exception 'Name the field engineer this spare belongs to, so they and their manager can follow it';
  end if;
  if not as_co and holder <> me then
    raise exception 'Only the Revive Lab''s coordinator can raise a ticket on somebody else''s behalf';
  end if;
  if not exists (select 1 from employees where id = holder and is_active) then
    raise exception 'That field engineer is not an active employee';
  end if;

  insert into revive_tickets (
    trc_kind, trc_id, facility, state, bemmp_id, district, source_ticket_no,
    equipment_name, equipment_barcode, spare_name, items, issue, return_address, contact_number,
    in_courier, in_awb, in_dispatched_on,
    stakeholder_id, raised_by, raised_as)
  values (
    trc.kind, trc.id,
    btrim(p_hospital),
    btrim(p_state),
    p_bemmp_id,
    btrim(p_district),
    nullif(btrim(coalesce(p_source_ticket_no, '')), ''),
    nullif(btrim(coalesce(p_equipment_name, '')), ''),
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

  perform revive_log(t.id, 'pending_acceptance', null, t.trc_id,
    case when as_co then 'Raised at the Revive Lab' else 'Raised from the field' end);

  return jsonb_build_object('id', t.id, 'code', t.code, 'number', t.number);
end $fn$;

grant execute on function public.revive_raise_ticket(
  uuid, text, text, uuid, text, text, text, text, text, text, text, text, text, text, date, uuid, jsonb)
to authenticated;

-- ---------------------------------------------------------------------
-- The courier details, after the ticket is raised
-- ---------------------------------------------------------------------
/** Adds or corrects how the spare is travelling in, until the Revive Lab accepts it. */
create or replace function public.revive_update_courier(
  p_ticket_id uuid, p_courier text, p_awb text, p_dispatched_on date)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t    revive_tickets := revive_lock(p_ticket_id);
  me   uuid := current_employee_id();
  c    text := nullif(btrim(coalesce(p_courier, '')), '');
  a    text := nullif(btrim(coalesce(p_awb, '')), '');
  said text;
begin
  if me is null or (t.raised_by <> me and t.stakeholder_id <> me) then
    raise exception 'Only whoever sent the spare in can change its courier details';
  end if;
  if t.status <> 'pending_acceptance' then
    raise exception 'The courier details can be changed until the Revive Lab accepts the spare';
  end if;
  if c is null and a is null then
    raise exception 'Enter the courier or the tracking number';
  end if;
  if length(c) > 60 or length(a) > 60 then
    raise exception 'Keep the courier and the tracking number under 60 characters';
  end if;
  -- A day's grace: current_date is the database's, and India is ahead of it.
  if p_dispatched_on > current_date + 1 then
    raise exception 'The date of dispatch cannot be in the future';
  end if;
  if c is not distinct from t.in_courier
     and a is not distinct from t.in_awb
     and p_dispatched_on is not distinct from t.in_dispatched_on then
    raise exception 'Nothing has changed';
  end if;

  update revive_tickets
     set in_courier = c, in_awb = a, in_dispatched_on = p_dispatched_on, updated_at = now()
   where id = t.id;

  said := concat_ws(' · ', c,
                    case when a is not null then 'AWB ' || a end,
                    case when p_dispatched_on is not null then 'dispatched ' || to_char(p_dispatched_on, 'FMDD Mon YYYY') end);
  insert into revive_ticket_events (ticket_id, status, from_status, trc_id, actor_id, note, kind)
  values (t.id, t.status, t.status, t.trc_id, me, said, 'courier');
end $fn$;

grant execute on function public.revive_update_courier(uuid, text, text, date) to authenticated;

-- ---------------------------------------------------------------------
-- The list carries what is in the box. A changed return type is a drop and create.
-- ---------------------------------------------------------------------
drop function if exists public.revive_ticket_list();

create function public.revive_ticket_list()
returns table (
  id uuid, number integer, code text, status text,
  trc_kind text, trc_id uuid, trc_name text,
  source_ticket_no text, facility text, district text, state text,
  bemmp_id uuid, bemmp_code text,
  equipment_name text, equipment_barcode text, spare_name text, items jsonb,
  issue text, return_address text, contact_number text,
  in_courier text, in_awb text, in_dispatched_on date,
  stakeholder_id uuid, stakeholder_name text, stakeholder_ecode text,
  stakeholder_function text,
  stakeholder_manager_name text,
  raised_by uuid, raised_by_name text, raised_by_function text, raised_as text,
  engineer_id uuid, engineer_name text, engineer_ecode text,
  out_courier text, out_awb text, out_dispatched_on date,
  created_at timestamptz, updated_at timestamptz, closed_at timestamptz
)
language sql stable security definer set search_path to 'public'
as $fn$
  select t.id, t.number, t.code, t.status,
         t.trc_kind, t.trc_id, trc.name,
         t.source_ticket_no, t.facility, t.district, t.state,
         t.bemmp_id, bp.code,
         t.equipment_name, t.equipment_barcode, t.spare_name, t.items,
         t.issue, t.return_address, t.contact_number,
         t.in_courier, t.in_awb, t.in_dispatched_on,
         t.stakeholder_id, sh.full_name, sh.ecode,
         sh.function_name,
         shm.full_name,
         t.raised_by, rb.full_name, rb.function_name, t.raised_as,
         t.engineer_id, en.full_name, en.ecode,
         t.out_courier, t.out_awb, t.out_dispatched_on,
         t.created_at, t.updated_at, t.closed_at
  from revive_tickets t
  join revive_trcs trc on trc.id = t.trc_id
  left join revive_bemmp_projects bp on bp.id = t.bemmp_id
  join employees sh on sh.id = t.stakeholder_id
  left join employees shm on shm.id = sh.reporting_manager_id
  join employees rb on rb.id = t.raised_by
  left join employees en on en.id = t.engineer_id
  where revive_can_see(t.id)
  order by t.number desc
$fn$;

grant execute on function public.revive_ticket_list() to authenticated;
