-- =====================================================================
-- Revive Lab  ·  rl_0004  ·  Revive Labs, not TRCs
--
-- TRC is the old name. Nobody using the module should read it: each
-- centre is a Revive Lab — Regional Revive Lab, Project Revive Lab — and
-- the people in them are Revive Lab engineers, coordinators and managers.
--
-- The screens were reworded in the app. What the database says reaches
-- the same screens — every refusal ("Only a coordinator or manager of this
-- TRC can accept it") is shown to the person who pressed the button — so
-- the functions are reworded too, and the two labs seeded by rl_0001 are
-- renamed.
--
-- Bodies are the live definitions with only uppercase TRC words changed.
-- Every identifier here is lowercase (revive_trcs, trc_id), so none of
-- them can be. Same signatures, so the grants stand.
-- =====================================================================

update public.revive_trcs set name = 'Regional Revive Lab' where name in ('Regional TRC', 'Regional Lab');
update public.revive_trcs set name = 'Project Revive Lab'  where name in ('Project TRC', 'Project Lab');

CREATE OR REPLACE FUNCTION public.revive_accept(p_ticket_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator or manager of this Revive Lab can accept it';
  end if;
  if t.status not in ('pending_acceptance', 'transferred') then
    raise exception 'This ticket is not waiting to be accepted';
  end if;
  update revive_tickets set status = 'accepted', updated_at = now() where id = t.id;
  perform revive_log(t.id, 'accepted', t.status, t.trc_id, p_note);
end $function$
;

CREATE OR REPLACE FUNCTION public.revive_assign(p_ticket_id uuid, p_engineer_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator or manager of this Revive Lab can assign it';
  end if;
  if t.status not in ('accepted', 'assigned') then
    raise exception 'Accept the ticket before assigning it';
  end if;
  if not exists (
    select 1 from revive_members m
    join revive_member_trcs mt on mt.employee_id = m.employee_id
    where m.employee_id = p_engineer_id and m.is_engineer and mt.trc_id = t.trc_id
  ) then
    raise exception 'That person is not an engineer at this Revive Lab';
  end if;
  update revive_tickets
  set status = 'assigned', engineer_id = p_engineer_id, updated_at = now()
  where id = t.id;
  perform revive_log(t.id, 'assigned', t.status, t.trc_id, p_note);
end $function$
;

CREATE OR REPLACE FUNCTION public.revive_dispatch(p_ticket_id uuid, p_courier text, p_awb text, p_dispatched_on date, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator or manager of this Revive Lab can dispatch it';
  end if;
  if t.status <> 'repaired' then
    raise exception 'Only a repaired spare can be dispatched';
  end if;
  if length(btrim(coalesce(p_courier, ''))) < 2 then
    raise exception 'Enter the courier it is going back with';
  end if;
  update revive_tickets
  set status = 'in_transit_return',
      out_courier = btrim(p_courier),
      out_awb = nullif(btrim(coalesce(p_awb, '')), ''),
      out_dispatched_on = coalesce(p_dispatched_on, current_date),
      updated_at = now()
  where id = t.id;
  perform revive_log(t.id, 'in_transit_return', t.status, t.trc_id, p_note);
end $function$
;

CREATE OR REPLACE FUNCTION public.revive_mark_received(p_ticket_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if not (t.stakeholder_id = current_employee_id() or revive_runs_trc(t.trc_id)) then
    raise exception 'Only the field engineer or the Revive Lab can confirm it arrived';
  end if;
  if t.status <> 'in_transit_return' then
    raise exception 'This spare has not been dispatched back yet';
  end if;
  update revive_tickets
  set status = 'closed', closed_at = now(), updated_at = now()
  where id = t.id;
  perform revive_log(t.id, 'closed', t.status, t.trc_id, p_note);
end $function$
;

CREATE OR REPLACE FUNCTION public.revive_raise_ticket(p_trc_id uuid, p_facility text, p_district text, p_state text, p_source_ticket_no text, p_item text, p_in_courier text, p_in_awb text, p_in_dispatched_on date, p_stakeholder_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me     uuid := current_employee_id();
  trc    revive_trcs;
  as_co  boolean;
  holder uuid;
  t      revive_tickets;
begin
  if me is null then raise exception 'Only a signed-in employee can raise a ticket'; end if;
  if not revive_has_access() then
    raise exception 'Revive Lab has not been given to you yet — ask the software administrator';
  end if;

  select * into trc from revive_trcs where id = p_trc_id and is_active;
  if not found then raise exception 'Choose the Revive Lab the spare is going to'; end if;

  as_co := revive_runs_trc(p_trc_id);
  holder := coalesce(p_stakeholder_id, me);

  -- Raised at the lab: the field engineer has to be named, and not as the
  -- coordinator themselves unless they really are the one who sent it.
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
    trc_kind, trc_id, facility, district, state, source_ticket_no, item,
    in_courier, in_awb, in_dispatched_on,
    stakeholder_id, raised_by, raised_as)
  values (
    trc.kind, trc.id,
    btrim(p_facility), nullif(btrim(coalesce(p_district, '')), ''),
    nullif(btrim(coalesce(p_state, '')), ''),
    nullif(btrim(coalesce(p_source_ticket_no, '')), ''),
    nullif(btrim(coalesce(p_item, '')), ''),
    nullif(btrim(coalesce(p_in_courier, '')), ''),
    nullif(btrim(coalesce(p_in_awb, '')), ''),
    p_in_dispatched_on,
    holder, me, case when as_co then 'coordinator' else 'engineer' end)
  returning * into t;

  perform revive_log(t.id, 'pending_acceptance', null, t.trc_id,
    case when as_co then 'Raised at the Revive Lab' else 'Raised from the field' end);

  return jsonb_build_object('id', t.id, 'code', t.code, 'number', t.number);
end $function$
;

CREATE OR REPLACE FUNCTION public.revive_save_member(p_employee_id uuid, p_engineer boolean, p_coordinator boolean, p_manager boolean, p_admin boolean, p_trc_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me uuid := current_employee_id();
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

  if not (p_engineer or p_coordinator or p_manager or p_admin)
     and coalesce(array_length(p_trc_ids, 1), 0) = 0 then
    delete from revive_members where employee_id = p_employee_id;
    perform log_audit('revive_member', p_employee_id, 'removed', '{}'::jsonb);
    return;
  end if;

  insert into revive_members (employee_id, is_engineer, is_coordinator, is_manager, is_admin, updated_at, updated_by)
  values (p_employee_id, p_engineer, p_coordinator, p_manager, p_admin, now(), me)
  on conflict (employee_id) do update
  set is_engineer = excluded.is_engineer,
      is_coordinator = excluded.is_coordinator,
      is_manager = excluded.is_manager,
      is_admin = excluded.is_admin,
      updated_at = now(),
      updated_by = me;

  delete from revive_member_trcs
  where employee_id = p_employee_id
    and trc_id <> all (coalesce(p_trc_ids, '{}'));
  insert into revive_member_trcs (employee_id, trc_id)
  select p_employee_id, x from unnest(coalesce(p_trc_ids, '{}')) x
  on conflict do nothing;

  -- Somebody given a box can open the module. Only once the module is on
  -- the platform's list — employee_modules refers to it.
  if exists (select 1 from app_modules where code = 'revive') then
    insert into employee_modules (employee_id, module_code, granted_by)
    values (p_employee_id, 'revive', me)
    on conflict do nothing;
  end if;

  perform log_audit('revive_member', p_employee_id, 'saved', jsonb_build_object(
    'engineer', p_engineer, 'coordinator', p_coordinator, 'manager', p_manager,
    'admin', p_admin, 'trcs', to_jsonb(coalesce(p_trc_ids, '{}'))));
end $function$
;

CREATE OR REPLACE FUNCTION public.revive_save_trc(p_id uuid, p_name text, p_kind text, p_active boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  tid uuid := p_id;
begin
  if not revive_is_admin() then
    raise exception 'Only a Revive Lab admin can change the Revive Labs';
  end if;
  if p_kind not in ('regional', 'project') then
    raise exception 'A Revive Lab is Regional or Project';
  end if;
  if exists (select 1 from revive_trcs
             where lower(btrim(name)) = lower(btrim(p_name)) and id is distinct from p_id) then
    raise exception 'There is already a Revive Lab called "%"', btrim(p_name);
  end if;

  if tid is null then
    insert into revive_trcs (name, kind, is_active, created_by)
    values (btrim(p_name), p_kind, coalesce(p_active, true), current_employee_id())
    returning id into tid;
  else
    update revive_trcs
    set name = btrim(p_name), kind = p_kind, is_active = coalesce(p_active, true)
    where id = tid;
    if not found then raise exception 'That Revive Lab does not exist'; end if;
  end if;

  perform log_audit('revive_trc', tid, 'saved',
    jsonb_build_object('name', btrim(p_name), 'kind', p_kind, 'active', coalesce(p_active, true)));
  return tid;
end $function$
;

CREATE OR REPLACE FUNCTION public.revive_transfer(p_ticket_id uuid, p_to_trc_id uuid, p_reason text, p_courier text, p_awb text, p_dispatched_on date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t    revive_tickets := revive_lock(p_ticket_id);
  dest revive_trcs;
  hop  integer;
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator or manager of this Revive Lab can transfer it';
  end if;
  if t.status not in ('accepted', 'assigned', 'in_repair') then
    raise exception 'Accept the ticket before transferring it, and transfer it before it is repaired';
  end if;
  select * into dest from revive_trcs where id = p_to_trc_id and is_active;
  if not found then raise exception 'Choose the Revive Lab it is going to'; end if;
  if dest.id = t.trc_id then raise exception 'It is already at that Revive Lab'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Say why it is being transferred';
  end if;

  select coalesce(max(x.hop), 0) + 1 into hop from revive_transfers x where x.ticket_id = t.id;

  insert into revive_transfers (
    ticket_id, hop, from_trc_id, to_trc_id, courier, awb, dispatched_on, reason, transferred_by)
  values (
    t.id, hop, t.trc_id, dest.id,
    nullif(btrim(coalesce(p_courier, '')), ''),
    nullif(btrim(coalesce(p_awb, '')), ''),
    coalesce(p_dispatched_on, current_date),
    btrim(p_reason), current_employee_id());

  -- Logged against the lab it is leaving: that is where this leg ends.
  perform revive_log(t.id, 'transferred', t.status, t.trc_id,
    'To ' || dest.name || ': ' || btrim(p_reason));

  update revive_tickets
  set status = 'transferred', trc_id = dest.id, trc_kind = dest.kind,
      engineer_id = null, updated_at = now()
  where id = t.id;
end $function$
;

do $test$
declare
  left_over text;
begin
  select string_agg(p.proname, ', ') into left_over
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'revive\_%'
    and pg_get_functiondef(p.oid) ~ '(^|[^A-Za-z_])TRCs?([^_A-Za-z]|$)';
  if left_over is not null then
    raise exception 'still says TRC: %', left_over;
  end if;
  if exists (select 1 from revive_trcs where name ~ 'TRC') then
    raise exception 'a lab is still named TRC';
  end if;
  raise notice 'rl_0004 self-test passed (no function or lab says TRC)';
end $test$;
