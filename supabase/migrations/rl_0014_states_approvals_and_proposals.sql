-- =====================================================================
-- rl_0014 — states, approval to go to another Revive Lab, and what
--           becomes of a spare that cannot be repaired
-- =====================================================================
--
-- States. A Revive Lab serves one state, or every state — Regional. So
-- does a BEMMP: AP, KL, RJ and UP are their states' programmes, and Pvt,
-- private hospitals, runs in every state. The route card asks the state
-- first, then offers only that state's BEMMPs and Revive Labs, with the
-- Regional ones beside them.
--
-- Approval. A spare going to another state's Revive Lab, and any ticket
-- moving from one Revive Lab to another, is approved first by the admins
-- of the Regional Revive Lab.
--
--   A field engineer who asks for another state's Revive Lab raises the
--   ticket as Waiting for approval. Approved, it comes back to them for
--   that Revive Lab — or for the one the admins approved instead — and
--   they send it; that Revive Lab accepts it as usual. Not approved, they
--   send it to their own state's or a Regional Revive Lab, or discard it.
--
--   A coordinator's transfer waits for the same approval, then comes back
--   to the coordinator to send. Not approved, the ticket carries on where
--   it was.
--
-- Not repairable. The engineer who closes a repair as not repairable
-- proposes what becomes of the spare — scrap, or back to the field
-- engineer — because the coordinator may not know. The coordinator is
-- offered that one move.

-- ---------------------------------------------------------------------
-- States
-- ---------------------------------------------------------------------
alter table public.revive_trcs
  add column if not exists state text check (state is null or length(btrim(state)) between 2 and 80);
alter table public.revive_bemmp_projects
  add column if not exists state text check (state is null or length(btrim(state)) between 2 and 80);

comment on column public.revive_trcs.state is
  'The state this Revive Lab serves. Null is Regional: every state.';
comment on column public.revive_bemmp_projects.state is
  'The state whose programme this is. Null runs in every state, like Pvt.';

-- The four state programmes; Pvt stays Regional. Every Revive Lab starts
-- Regional until an admin names its state, so nothing disappears from
-- anybody's route card the day this goes in.
update public.revive_bemmp_projects
   set state = case upper(btrim(code))
                 when 'AP' then 'Andhra Pradesh'
                 when 'KL' then 'Kerala'
                 when 'RJ' then 'Rajasthan'
                 when 'UP' then 'Uttar Pradesh'
               end
 where state is null
   and upper(btrim(code)) in ('AP', 'KL', 'RJ', 'UP');

/*
  p_state is the state's name, 'Regional' for every state, or left out to
  keep what is there. The People screens from before rl_0014 do not send
  it, and renaming a Revive Lab or retiring a BEMMP from one of them must
  not quietly make it Regional.
*/
drop function if exists public.revive_save_trc(uuid, text, text, boolean);
create function public.revive_save_trc(
  p_id uuid, p_name text, p_kind text, p_active boolean default true, p_state text default null)
returns uuid
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  tid  uuid := p_id;
  st   text := nullif(btrim(coalesce(p_state, '')), '');
  keep boolean := p_state is null;
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
  if lower(st) = 'regional' then
    st := null;
  end if;
  if st is not null and length(st) not between 2 and 80 then
    raise exception 'Choose the state it serves, or Regional';
  end if;

  if tid is null then
    insert into revive_trcs (name, kind, state, is_active, created_by)
    values (btrim(p_name), p_kind, st, coalesce(p_active, true), current_employee_id())
    returning id into tid;
  else
    update revive_trcs
    set name = btrim(p_name), kind = p_kind, is_active = coalesce(p_active, true),
        state = case when keep then state else st end
    where id = tid;
    if not found then raise exception 'That Revive Lab does not exist'; end if;
  end if;

  perform log_audit('revive_trc', tid, 'saved', jsonb_build_object(
    'name', btrim(p_name), 'kind', p_kind, 'active', coalesce(p_active, true),
    'state', (select coalesce(state, 'Regional') from revive_trcs where id = tid)));
  return tid;
end $fn$;
revoke execute on function public.revive_save_trc(uuid, text, text, boolean, text) from public, anon;
grant execute on function public.revive_save_trc(uuid, text, text, boolean, text) to authenticated;

drop function if exists public.revive_save_bemmp(uuid, text, boolean);
create function public.revive_save_bemmp(
  p_id uuid, p_code text, p_active boolean default true, p_state text default null)
returns uuid
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  pid   uuid := p_id;
  clean text := btrim(coalesce(p_code, ''));
  st    text := nullif(btrim(coalesce(p_state, '')), '');
  keep  boolean := p_state is null;
begin
  if not revive_is_admin() then
    raise exception 'Only a Revive Lab admin can change the BEMMP list';
  end if;
  if length(clean) not between 1 and 20 then
    raise exception 'A BEMMP code is 1 to 20 characters';
  end if;
  if exists (select 1 from revive_bemmp_projects
             where lower(btrim(code)) = lower(clean) and id is distinct from p_id) then
    raise exception 'BEMMP "%" is already on the list', clean;
  end if;
  if lower(st) = 'regional' then
    st := null;
  end if;
  if st is not null and length(st) not between 2 and 80 then
    raise exception 'Choose the state it belongs to, or Regional';
  end if;

  if pid is null then
    insert into revive_bemmp_projects (code, state, is_active, sort_order, created_by)
    values (clean, st, coalesce(p_active, true),
            coalesce((select max(sort_order) from revive_bemmp_projects), 0) + 10,
            current_employee_id())
    returning id into pid;
  else
    update revive_bemmp_projects
    set code = clean, is_active = coalesce(p_active, true),
        state = case when keep then state else st end
    where id = pid;
    if not found then raise exception 'That BEMMP does not exist'; end if;
  end if;

  perform log_audit('revive_bemmp', pid, 'saved', jsonb_build_object(
    'code', clean, 'active', coalesce(p_active, true),
    'state', (select coalesce(state, 'Regional') from revive_bemmp_projects where id = pid)));
  return pid;
end $fn$;
revoke execute on function public.revive_save_bemmp(uuid, text, boolean, text) from public, anon;
grant execute on function public.revive_save_bemmp(uuid, text, boolean, text) to authenticated;

-- ---------------------------------------------------------------------
-- The new statuses, how a ticket can end, and the engineer's proposal
-- ---------------------------------------------------------------------
alter table public.revive_tickets drop constraint if exists revive_tickets_status_check;
alter table public.revive_tickets add constraint revive_tickets_status_check check (status in (
  'awaiting_approval', 'approved', 'not_approved',
  'pending_acceptance', 'transferred', 'accepted', 'assigned', 'in_repair',
  'parts_requested', 'parts_ordered', 'parts_ready',
  'repaired', 'not_repairable', 'service_denied', 'in_transit_return', 'closed'));

-- Discarded: raised, never sent, and given up by whoever raised it.
alter table public.revive_tickets drop constraint if exists revive_tickets_closure_check;
alter table public.revive_tickets add constraint revive_tickets_closure_check
  check (closure in ('returned', 'scrapped', 'discarded'));

alter table public.revive_tickets
  add column if not exists proposal text check (proposal in ('scrap', 'return'));
comment on column public.revive_tickets.proposal is
  'Not repairable: what the engineer proposed — scrap, or return to the field engineer.';

-- ---------------------------------------------------------------------
-- Approvals
-- ---------------------------------------------------------------------
create table if not exists public.revive_approvals (
  id             uuid primary key default gen_random_uuid(),
  ticket_id      uuid not null references public.revive_tickets(id) on delete cascade,
  -- raise: a field engineer asked for another state's Revive Lab.
  -- transfer: a coordinator asked to move a ticket to another Revive Lab.
  kind           text not null check (kind in ('raise', 'transfer')),
  from_trc_id    uuid references public.revive_trcs(id),
  -- What was asked for, and what was approved: the admins may approve another.
  asked_trc_id   uuid not null references public.revive_trcs(id),
  to_trc_id      uuid not null references public.revive_trcs(id),
  reason         text not null check (length(btrim(reason)) between 5 and 500),
  -- A transfer that is not approved, or is cancelled, carries on from here.
  back_to        text,
  status         text not null default 'pending'
                 check (status in ('pending', 'approved', 'declined', 'cancelled', 'sent')),
  requested_by   uuid not null references public.employees(id),
  requested_at   timestamptz not null default now(),
  decided_by     uuid references public.employees(id) on delete set null,
  decided_at     timestamptz,
  decision_note  text check (decision_note is null or length(decision_note) <= 500),
  updated_at     timestamptz not null default now(),
  check ((kind = 'transfer') = (from_trc_id is not null and back_to is not null))
);
create index if not exists revive_approvals_ticket on public.revive_approvals (ticket_id, requested_at desc);
-- One open question per ticket.
create unique index if not exists revive_approvals_one_open on public.revive_approvals (ticket_id)
  where status in ('pending', 'approved');

alter table public.revive_approvals enable row level security;
drop policy if exists revive_approvals_read on public.revive_approvals;
create policy revive_approvals_read on public.revive_approvals
  for select to authenticated using (revive_can_see(ticket_id));
grant select on public.revive_approvals to authenticated;

/*
  Who approves: an admin of a Regional Revive Lab. Until a Regional Revive
  Lab has an admin, every Revive Lab admin does — a request must never wait
  for nobody. The software administrator always can.
*/
create or replace function public.revive_approves()
returns boolean
language sql stable security definer set search_path to 'public'
as $fn$
  select is_sw_admin() or exists (
    select 1 from revive_members m
    where m.employee_id = current_employee_id()
      and m.is_admin
      and (
        exists (select 1 from revive_member_trcs mt
                join revive_trcs l on l.id = mt.trc_id
                where mt.employee_id = m.employee_id and l.state is null)
        or not exists (select 1 from revive_members a
                       join revive_member_trcs mt on mt.employee_id = a.employee_id
                       join revive_trcs l on l.id = mt.trc_id
                       where a.is_admin and l.state is null)
      )
  )
$fn$;
revoke execute on function public.revive_approves() from public, anon;
grant execute on function public.revive_approves() to authenticated;

drop function if exists public.revive_me();
create function public.revive_me()
returns table (
  employee_id uuid, is_engineer boolean, is_coordinator boolean,
  is_manager boolean, is_admin boolean, is_sw_admin boolean, trc_ids uuid[],
  is_purchase boolean, approves boolean
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
    coalesce(m.is_purchase, false),
    revive_approves()
  from employees e
  left join revive_members m on m.employee_id = e.id
  where e.id = current_employee_id()
$fn$;
grant execute on function public.revive_me() to authenticated;

-- ---------------------------------------------------------------------
-- Raising a ticket: the state decides the BEMMP and the Revive Lab
-- ---------------------------------------------------------------------
drop function if exists public.revive_raise_ticket(
  uuid, text, text, uuid, text, text, text, text, text, text, text, text, text, text, date, uuid, jsonb, boolean);
create function public.revive_raise_ticket(
  p_trc_id uuid, p_hospital text, p_state text, p_bemmp_id uuid, p_district text,
  p_source_ticket_no text, p_equipment_name text, p_equipment_barcode text, p_spare_name text,
  p_issue text, p_return_address text, p_contact_number text,
  p_in_courier text, p_in_awb text, p_in_dispatched_on date,
  p_stakeholder_id uuid default null, p_items jsonb default null, p_billing_spare boolean default null,
  p_approval_reason text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  me        uuid := current_employee_id();
  trc       revive_trcs;
  bemmp     revive_bemmp_projects;
  st        text := btrim(coalesce(p_state, ''));
  why       text := btrim(coalesce(p_approval_reason, ''));
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

  select * into trc from revive_trcs where id = p_trc_id and is_active;
  if not found then raise exception 'Choose the Revive Lab the spare is going to'; end if;

  if length(st) < 2 then
    raise exception 'Choose the state';
  end if;
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

  /*
    Another state's Revive Lab. A field engineer is offered their own
    state's and the Regional ones; any other is asked for, with a reason,
    and waits for the Regional Revive Lab admins. The desk raises a spare
    that has already arrived at its own Revive Lab, wherever it came from.
  */
  far := not as_co and trc.state is not null and trc.state <> st;
  if far and length(why) < 5 then
    raise exception '% is not a Revive Lab for % — say why it should go there, and the Regional Revive Lab admins approve it first', trc.name, st;
  end if;
  if far and length(why) > 500 then
    raise exception 'Keep the reason under 500 characters';
  end if;

  insert into revive_tickets (
    status, trc_kind, trc_id, facility, state, bemmp_id, billing_spare, district, source_ticket_no,
    equipment_name, equipment_barcode, spare_name, items, issue, return_address, contact_number,
    in_courier, in_awb, in_dispatched_on,
    stakeholder_id, raised_by, raised_as)
  values (
    case when far then 'awaiting_approval' else 'pending_acceptance' end,
    trc.kind, trc.id,
    btrim(p_hospital),
    st,
    p_bemmp_id,
    case when bemmp.asks_billing then coalesce(p_billing_spare, false) end,
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

  if far then
    insert into revive_approvals (ticket_id, kind, asked_trc_id, to_trc_id, reason, requested_by)
    values (t.id, 'raise', trc.id, trc.id, why, me);
    perform revive_step(t.id, 'awaiting_approval', null, t.trc_id, 'status', 'lab_requested',
      'For ' || trc.name || ': ' || why);
  else
    perform revive_log(t.id, 'pending_acceptance', null, t.trc_id,
      case when as_co then 'Raised at the Revive Lab' else 'Raised from the field' end);
  end if;

  return jsonb_build_object('id', t.id, 'code', t.code, 'number', t.number, 'status', t.status);
end $fn$;
revoke execute on function public.revive_raise_ticket(
  uuid, text, text, uuid, text, text, text, text, text, text, text, text, text, text, date, uuid, jsonb, boolean, text)
  from public, anon;
grant execute on function public.revive_raise_ticket(
  uuid, text, text, uuid, text, text, text, text, text, text, text, text, text, text, date, uuid, jsonb, boolean, text)
  to authenticated;

-- ---------------------------------------------------------------------
-- A transfer is asked for, approved or not, then sent
-- ---------------------------------------------------------------------
create or replace function public.revive_request_transfer(p_ticket_id uuid, p_to_trc_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t    revive_tickets := revive_lock(p_ticket_id);
  dest revive_trcs;
  why  text := btrim(coalesce(p_reason, ''));
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
  if length(why) < 5 then raise exception 'Say why it is being transferred'; end if;
  if length(why) > 500 then raise exception 'Keep the reason under 500 characters'; end if;

  insert into revive_approvals (ticket_id, kind, from_trc_id, asked_trc_id, to_trc_id, reason, back_to, requested_by)
  values (t.id, 'transfer', t.trc_id, dest.id, dest.id, why, t.status, current_employee_id());
  -- The engineer keeps it: a transfer that is not approved carries on with them.
  update revive_tickets set status = 'awaiting_approval', updated_at = now() where id = t.id;
  perform revive_step(t.id, 'awaiting_approval', t.status, t.trc_id, 'status', 'transfer_requested',
    'To ' || dest.name || ': ' || why);
end $fn$;
revoke execute on function public.revive_request_transfer(uuid, uuid, text) from public, anon;
grant execute on function public.revive_request_transfer(uuid, uuid, text) to authenticated;

/*
  The transfer button from before rl_0014 moved the ticket at once. It now
  asks, like the new one, so an app still open from before cannot go round
  the approval. The courier details are asked for when it is sent.
*/
create or replace function public.revive_transfer(
  p_ticket_id uuid, p_to_trc_id uuid, p_reason text, p_courier text, p_awb text, p_dispatched_on date)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
begin
  perform revive_request_transfer(p_ticket_id, p_to_trc_id, p_reason);
end $fn$;

create or replace function public.revive_approve(
  p_ticket_id uuid, p_to_trc_id uuid default null, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t     revive_tickets := revive_lock(p_ticket_id);
  a     revive_approvals;
  dest  revive_trcs;
  asked text;
  n     text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not revive_approves() then
    raise exception 'Only the Regional Revive Lab admins approve where a spare goes';
  end if;
  select * into a from revive_approvals where ticket_id = t.id and status = 'pending' for update;
  if not found or t.status <> 'awaiting_approval' then
    raise exception 'This ticket is not waiting for approval';
  end if;
  select * into dest from revive_trcs where id = coalesce(p_to_trc_id, a.to_trc_id) and is_active;
  if not found then raise exception 'Choose a Revive Lab that is taking tickets'; end if;
  if a.kind = 'transfer' and dest.id = a.from_trc_id then
    raise exception 'It is already at that Revive Lab — decline the transfer instead';
  end if;
  if length(n) > 500 then raise exception 'Keep the note under 500 characters'; end if;
  select name into asked from revive_trcs where id = a.asked_trc_id;

  update revive_approvals
     set status = 'approved', to_trc_id = dest.id, decided_by = current_employee_id(),
         decided_at = now(), decision_note = n, updated_at = now()
   where id = a.id;
  -- A raise is for the approved Revive Lab from now on. A transfer stays
  -- where the spare is until the coordinator sends it.
  update revive_tickets
     set status = 'approved',
         trc_id = case when a.kind = 'raise' then dest.id else trc_id end,
         trc_kind = case when a.kind = 'raise' then dest.kind else trc_kind end,
         updated_at = now()
   where id = t.id;
  perform revive_step(t.id, 'approved', t.status,
    case when a.kind = 'raise' then dest.id else t.trc_id end, 'status', 'approved',
    concat_ws(' · ',
      'For ' || dest.name || case when dest.id <> a.asked_trc_id then ' instead of ' || asked else '' end,
      n));
end $fn$;
revoke execute on function public.revive_approve(uuid, uuid, text) from public, anon;
grant execute on function public.revive_approve(uuid, uuid, text) to authenticated;

create or replace function public.revive_decline_approval(p_ticket_id uuid, p_note text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t     revive_tickets := revive_lock(p_ticket_id);
  a     revive_approvals;
  asked text;
  n     text := btrim(coalesce(p_note, ''));
begin
  if not revive_approves() then
    raise exception 'Only the Regional Revive Lab admins approve where a spare goes';
  end if;
  select * into a from revive_approvals where ticket_id = t.id and status = 'pending' for update;
  if not found or t.status <> 'awaiting_approval' then
    raise exception 'This ticket is not waiting for approval';
  end if;
  if length(n) < 3 then raise exception 'Say why it is not approved'; end if;
  if length(n) > 500 then raise exception 'Keep the reason under 500 characters'; end if;
  select name into asked from revive_trcs where id = a.to_trc_id;

  update revive_approvals
     set status = 'declined', decided_by = current_employee_id(), decided_at = now(),
         decision_note = n, updated_at = now()
   where id = a.id;
  if a.kind = 'raise' then
    -- Back to the field engineer: their own state's or a Regional Revive Lab, or discard it.
    update revive_tickets set status = 'not_approved', updated_at = now() where id = t.id;
    perform revive_step(t.id, 'not_approved', t.status, t.trc_id, 'status', 'declined',
      'For ' || asked || ': ' || n);
  else
    update revive_tickets set status = a.back_to, updated_at = now() where id = t.id;
    perform revive_step(t.id, a.back_to, t.status, t.trc_id, 'status', 'declined',
      'Transfer to ' || asked || ': ' || n);
  end if;
end $fn$;
revoke execute on function public.revive_decline_approval(uuid, text) from public, anon;
grant execute on function public.revive_decline_approval(uuid, text) to authenticated;

/*
  Approved, and sent. A raise goes to the approved Revive Lab to be accepted;
  a transfer goes the way transfers always have — a hop, and the next Revive
  Lab accepts it on arrival.
*/
create or replace function public.revive_send(
  p_ticket_id uuid, p_courier text default null, p_awb text default null,
  p_dispatched_on date default null, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t    revive_tickets := revive_lock(p_ticket_id);
  me   uuid := current_employee_id();
  a    revive_approvals;
  dest revive_trcs;
  c    text := nullif(btrim(coalesce(p_courier, '')), '');
  w    text := nullif(btrim(coalesce(p_awb, '')), '');
  n    text := nullif(btrim(coalesce(p_note, '')), '');
  hop  integer;
begin
  select * into a from revive_approvals where ticket_id = t.id and status = 'approved' for update;
  if not found or t.status <> 'approved' then
    raise exception 'This ticket has no approval waiting to be sent';
  end if;
  if a.kind = 'raise' and (me is null or (t.raised_by <> me and t.stakeholder_id <> me)) then
    raise exception 'Only whoever raised it can send it';
  end if;
  if a.kind = 'transfer' and not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator or manager of this Revive Lab can send it';
  end if;
  select * into dest from revive_trcs where id = a.to_trc_id;
  if not dest.is_active then
    raise exception '% is no longer taking tickets — %', dest.name,
      case a.kind when 'raise' then 'discard this ticket and raise it again' else 'cancel the transfer and ask again' end;
  end if;
  if length(c) > 80 or length(w) > 80 then
    raise exception 'Keep the courier and the tracking number under 80 characters';
  end if;
  -- A day's grace: current_date is the database's, and India is ahead of it.
  if p_dispatched_on > current_date + 1 then
    raise exception 'The date of dispatch cannot be in the future';
  end if;
  if length(n) > 300 then raise exception 'Keep the note under 300 characters'; end if;

  if a.kind = 'raise' then
    update revive_tickets
       set status = 'pending_acceptance',
           in_courier = coalesce(c, in_courier),
           in_awb = coalesce(w, in_awb),
           in_dispatched_on = coalesce(p_dispatched_on, in_dispatched_on),
           updated_at = now()
     where id = t.id;
    update revive_approvals set status = 'sent', updated_at = now() where id = a.id;
    perform revive_step(t.id, 'pending_acceptance', t.status, t.trc_id, 'status', 'sent',
      concat_ws(' · ', 'Sent to ' || dest.name, n));
  else
    select coalesce(max(x.hop), 0) + 1 into hop from revive_transfers x where x.ticket_id = t.id;
    insert into revive_transfers (
      ticket_id, hop, from_trc_id, to_trc_id, courier, awb, dispatched_on, reason, transferred_by)
    values (t.id, hop, t.trc_id, dest.id, c, w, coalesce(p_dispatched_on, current_date), a.reason, me);
    -- Logged against the Revive Lab it is leaving: that is where this leg ends.
    perform revive_step(t.id, 'transferred', t.status, t.trc_id, 'status', 'sent',
      concat_ws(' · ', 'To ' || dest.name || ': ' || a.reason, n));
    update revive_tickets
       set status = 'transferred', trc_id = dest.id, trc_kind = dest.kind,
           engineer_id = null, updated_at = now()
     where id = t.id;
    update revive_approvals set status = 'sent', updated_at = now() where id = a.id;
  end if;
end $fn$;
revoke execute on function public.revive_send(uuid, text, text, date, text) from public, anon;
grant execute on function public.revive_send(uuid, text, text, date, text) to authenticated;

create or replace function public.revive_cancel_transfer(p_ticket_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
  a revive_approvals;
  n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator or manager of this Revive Lab can cancel the transfer';
  end if;
  select * into a from revive_approvals
   where ticket_id = t.id and kind = 'transfer' and status in ('pending', 'approved') for update;
  if not found or t.status not in ('awaiting_approval', 'approved') then
    raise exception 'There is no transfer to cancel';
  end if;
  if length(n) > 300 then raise exception 'Keep the note under 300 characters'; end if;

  update revive_approvals set status = 'cancelled', updated_at = now() where id = a.id;
  update revive_tickets set status = a.back_to, updated_at = now() where id = t.id;
  perform revive_step(t.id, a.back_to, t.status, t.trc_id, 'status', 'transfer_cancelled',
    concat_ws(' · ', 'Transfer to ' || (select name from revive_trcs where id = a.to_trc_id) || ' cancelled', n));
end $fn$;
revoke execute on function public.revive_cancel_transfer(uuid, text) from public, anon;
grant execute on function public.revive_cancel_transfer(uuid, text) to authenticated;

/*
  Not approved: the field engineer sends it to their own state's Revive Lab
  or a Regional one instead. Neither needs approval.
*/
create or replace function public.revive_reroute(
  p_ticket_id uuid, p_trc_id uuid, p_courier text default null, p_awb text default null,
  p_dispatched_on date default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t    revive_tickets := revive_lock(p_ticket_id);
  me   uuid := current_employee_id();
  dest revive_trcs;
  c    text := nullif(btrim(coalesce(p_courier, '')), '');
  w    text := nullif(btrim(coalesce(p_awb, '')), '');
begin
  if me is null or (t.raised_by <> me and t.stakeholder_id <> me) then
    raise exception 'Only whoever raised it can choose where it goes';
  end if;
  if t.status <> 'not_approved' then
    raise exception 'This ticket is not waiting for you to choose a Revive Lab';
  end if;
  select * into dest from revive_trcs where id = p_trc_id and is_active;
  if not found then raise exception 'Choose the Revive Lab the spare is going to'; end if;
  if dest.state is not null and dest.state is distinct from t.state then
    raise exception '% is not a Revive Lab for % — choose one of its own, or a Regional one',
      dest.name, coalesce(t.state, 'this state');
  end if;
  if length(c) > 80 or length(w) > 80 then
    raise exception 'Keep the courier and the tracking number under 80 characters';
  end if;
  if p_dispatched_on > current_date + 1 then
    raise exception 'The date of dispatch cannot be in the future';
  end if;

  update revive_tickets
     set status = 'pending_acceptance', trc_id = dest.id, trc_kind = dest.kind,
         in_courier = coalesce(c, in_courier),
         in_awb = coalesce(w, in_awb),
         in_dispatched_on = coalesce(p_dispatched_on, in_dispatched_on),
         updated_at = now()
   where id = t.id;
  perform revive_step(t.id, 'pending_acceptance', t.status, dest.id, 'status', 'sent', 'Sent to ' || dest.name);
end $fn$;
revoke execute on function public.revive_reroute(uuid, uuid, text, text, date) from public, anon;
grant execute on function public.revive_reroute(uuid, uuid, text, text, date) to authenticated;

/*
  Given up before it went anywhere. Only a ticket that was never sent to a
  Revive Lab: once one has had it, it ends the way repairs end.
*/
create or replace function public.revive_discard(p_ticket_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t  revive_tickets := revive_lock(p_ticket_id);
  me uuid := current_employee_id();
  n  text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if me is null or (t.raised_by <> me and t.stakeholder_id <> me) then
    raise exception 'Only whoever raised it can discard it';
  end if;
  if t.status not in ('awaiting_approval', 'approved', 'not_approved')
     or exists (select 1 from revive_ticket_events ev
                where ev.ticket_id = t.id and ev.status = 'pending_acceptance') then
    raise exception 'Only a ticket that has not been sent to a Revive Lab can be discarded';
  end if;
  if length(n) > 300 then raise exception 'Keep the note under 300 characters'; end if;

  update revive_approvals set status = 'cancelled', updated_at = now()
   where ticket_id = t.id and status in ('pending', 'approved');
  update revive_tickets
     set status = 'closed', closure = 'discarded', closed_at = now(), updated_at = now()
   where id = t.id;
  perform revive_step(t.id, 'closed', t.status, t.trc_id, 'status', 'discarded', n);
end $fn$;
revoke execute on function public.revive_discard(uuid, text) from public, anon;
grant execute on function public.revive_discard(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Not repairable: the engineer proposes, the coordinator does it
-- ---------------------------------------------------------------------
drop function if exists public.revive_complete_repair(uuid, text, text);
create function public.revive_complete_repair(
  p_ticket_id uuid, p_note text default null, p_outcome text default 'repaired', p_proposal text default null)
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
  -- An app from before rl_0014 proposes nothing, and the coordinator then chooses.
  if p_proposal is not null and p_outcome <> 'not_repairable' then
    raise exception 'Only a spare that cannot be repaired is proposed for scrap or return';
  end if;
  if p_proposal is not null and p_proposal not in ('scrap', 'return') then
    raise exception 'Propose scrap, or sending it back to the field engineer';
  end if;
  next := case p_outcome
            when 'repaired' then 'repaired'
            when 'not_repairable' then 'not_repairable'
            else 'service_denied' end;
  update revive_tickets
     set status = next, outcome = p_outcome, proposal = p_proposal, updated_at = now()
   where id = t.id;
  perform revive_step(t.id, next, t.status, t.trc_id, 'status', p_outcome, p_note);
end $fn$;
revoke execute on function public.revive_complete_repair(uuid, text, text, text) from public, anon;
grant execute on function public.revive_complete_repair(uuid, text, text, text) to authenticated;

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
  if t.proposal = 'return' then
    raise exception 'The engineer proposed sending it back to the field engineer — dispatch it back';
  end if;
  update revive_tickets
     set status = 'closed', closure = 'scrapped', closed_at = now(),
         scrapped_at = now(), scrapped_by = current_employee_id(), updated_at = now()
   where id = t.id;
  perform revive_step(t.id, 'closed', t.status, t.trc_id, 'status', 'scrapped', p_note);
end $fn$;

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
  if t.status = 'not_repairable' and t.proposal = 'scrap' then
    raise exception 'The engineer proposed scrap — move it to scrap';
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

-- ---------------------------------------------------------------------
-- The ticket list: the proposal, the Revive Lab's state, the approval
-- ---------------------------------------------------------------------
drop function if exists public.revive_ticket_list();
create function public.revive_ticket_list()
returns table (
  id uuid, number integer, code text, status text, trc_kind text, trc_id uuid, trc_name text,
  source_ticket_no text, facility text, district text, state text,
  bemmp_id uuid, bemmp_code text, billing_spare boolean,
  equipment_name text, equipment_barcode text, spare_name text, items jsonb,
  issue text, return_address text, contact_number text,
  in_courier text, in_awb text, in_dispatched_on date,
  stakeholder_id uuid, stakeholder_name text, stakeholder_ecode text, stakeholder_function text,
  stakeholder_manager_name text,
  raised_by uuid, raised_by_name text, raised_by_function text, raised_as text,
  engineer_id uuid, engineer_name text, engineer_ecode text,
  out_courier text, out_awb text, out_dispatched_on date,
  created_at timestamptz, updated_at timestamptz, closed_at timestamptz,
  outcome text, closure text, scrapped_at timestamptz, scrapped_by_name text,
  expected_by date, parts jsonb,
  proposal text, trc_state text, approval jsonb
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
           limit 1)
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
