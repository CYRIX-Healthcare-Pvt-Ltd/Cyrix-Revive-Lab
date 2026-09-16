-- =====================================================================
-- Revive Lab  ·  rl_0001  ·  The repair lab, on the shared database
--
-- Revive Lab (the old name was TRC) tracks a defective spare from the
-- hospital where a field engineer finds it, into a TRC, through repair,
-- and back out again — or on to another TRC when this one cannot fix it.
--
-- It lives on the KPI project's database because the people are the same
-- people: employees is the master record, auth.users is the one sign-in,
-- and reporting lines decide whose manager can see what. So this module
-- READS shared things (employees, employee_modules, current_employee_id,
-- is_sw_admin, is_in_my_downline) and WRITES only its own:
--
--   revive_trcs            the labs, each Regional or Project
--   revive_members         who works in Revive Lab, as ticked boxes
--   revive_member_trcs     which labs each of them belongs to
--   revive_tickets         one spare's journey, numbered RL-01, RL-02 …
--   revive_ticket_events   every status it entered, when and by whom
--   revive_transfers       every hop between labs, with its courier
--   revive_mail_outbox     one row per event still to be emailed
--   revive_settings        this module's own configuration
--
-- Row-level security is on for every table from this first migration.
-- Nobody writes a table directly: every change goes through a function
-- that checks who is asking and whether the ticket is in a state that
-- allows it, and writes the event row in the same transaction. That is
-- what makes the history complete — there is no path to a new status
-- that does not leave its own timestamp behind — and it is what the TAT
-- figures and the notification emails are built from.
--
-- Roles are ticked boxes, not a role name. A manager who also repairs is
-- a manager with the engineer box ticked; nobody has to invent "Manager
-- Engineer" as a role. The field engineer who sends a spare in and their
-- reporting manager are not boxes at all: the first is whoever raised or
-- is named on the ticket, the second is read from the reporting line.
-- =====================================================================

-- ---------------------------------------------------------------------
-- The labs
-- ---------------------------------------------------------------------
create table public.revive_trcs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 2 and 80),
  kind        text not null check (kind in ('regional', 'project')),
  is_active   boolean not null default true,
  sort_order  integer not null default 100,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.employees(id) on delete set null
);

create unique index revive_trcs_name_key on public.revive_trcs (lower(btrim(name)));

-- ---------------------------------------------------------------------
-- The people, as boxes
-- ---------------------------------------------------------------------
create table public.revive_members (
  employee_id     uuid primary key references public.employees(id) on delete cascade,
  is_engineer     boolean not null default false,
  is_coordinator  boolean not null default false,
  is_manager      boolean not null default false,
  -- Edit rights over this table itself. Not a role in the ticket
  -- workflow: "Manager + Admin" is the manager box and this one.
  is_admin        boolean not null default false,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.employees(id) on delete set null
);

create table public.revive_member_trcs (
  employee_id  uuid not null references public.revive_members(employee_id) on delete cascade,
  trc_id       uuid not null references public.revive_trcs(id) on delete cascade,
  primary key (employee_id, trc_id)
);

create index revive_member_trcs_trc on public.revive_member_trcs (trc_id);

-- ---------------------------------------------------------------------
-- Tickets
-- ---------------------------------------------------------------------
create sequence public.revive_ticket_number;

create table public.revive_tickets (
  id                 uuid primary key default gen_random_uuid(),
  number             integer not null unique default nextval('public.revive_ticket_number'),
  -- RL-01 … RL-09, RL-10 … RL-99, RL-100. Padded to two, never truncated.
  code               text generated always as (
                       'RL-' || case when number < 10 then '0' else '' end || number::text
                     ) stored,

  status             text not null default 'pending_acceptance' check (status in (
                       'pending_acceptance',   -- at a TRC, waiting for a coordinator
                       'accepted',             -- the coordinator has it
                       'assigned',             -- given to a TRC engineer
                       'in_repair',            -- the engineer accepted it and is working
                       'repaired',             -- repair done, waiting to be dispatched
                       'in_transit_return',    -- on its way back
                       'closed',               -- received back
                       'transferred'           -- on its way to another TRC
                     )),

  -- Where it is now. A transfer changes both.
  trc_kind           text not null check (trc_kind in ('regional', 'project')),
  trc_id             uuid not null references public.revive_trcs(id),

  source_ticket_no   text check (source_ticket_no is null or length(source_ticket_no) <= 60),
  item               text check (item is null or length(item) <= 200),
  facility           text not null check (length(btrim(facility)) between 2 and 200),
  district           text check (district is null or length(district) <= 80),
  state              text check (state is null or length(state) <= 80),

  in_courier         text check (in_courier is null or length(in_courier) <= 80),
  in_awb             text check (in_awb is null or length(in_awb) <= 80),
  in_dispatched_on   date,

  -- The field engineer the spare belongs to: whoever raised it, or the one
  -- a coordinator names when the spare simply turns up at the lab.
  stakeholder_id     uuid not null references public.employees(id),
  raised_by          uuid not null references public.employees(id),
  raised_as          text not null check (raised_as in ('engineer', 'coordinator')),

  engineer_id        uuid references public.employees(id),

  out_courier        text check (out_courier is null or length(out_courier) <= 80),
  out_awb            text check (out_awb is null or length(out_awb) <= 80),
  out_dispatched_on  date,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  closed_at          timestamptz
);

create index revive_tickets_trc_status on public.revive_tickets (trc_id, status);
create index revive_tickets_stakeholder on public.revive_tickets (stakeholder_id);
create index revive_tickets_engineer on public.revive_tickets (engineer_id) where engineer_id is not null;

-- ---------------------------------------------------------------------
-- History: every status a ticket entered
-- ---------------------------------------------------------------------
create table public.revive_ticket_events (
  id           bigint generated always as identity primary key,
  ticket_id    uuid not null references public.revive_tickets(id) on delete cascade,
  status       text not null,
  from_status  text,
  -- The TRC the ticket was at when this happened. For a transfer, the one
  -- it is leaving; the destination is on the transfer row.
  trc_id       uuid references public.revive_trcs(id),
  actor_id     uuid references public.employees(id),
  note         text check (note is null or length(note) <= 1000),
  at           timestamptz not null default now()
);

create index revive_ticket_events_ticket on public.revive_ticket_events (ticket_id, at);

-- ---------------------------------------------------------------------
-- Transfers: each hop between labs
-- ---------------------------------------------------------------------
create table public.revive_transfers (
  id              uuid primary key default gen_random_uuid(),
  ticket_id       uuid not null references public.revive_tickets(id) on delete cascade,
  hop             integer not null,
  from_trc_id     uuid not null references public.revive_trcs(id),
  to_trc_id       uuid not null references public.revive_trcs(id),
  courier         text check (courier is null or length(courier) <= 80),
  awb             text check (awb is null or length(awb) <= 80),
  dispatched_on   date,
  reason          text check (reason is null or length(reason) <= 1000),
  transferred_by  uuid references public.employees(id),
  transferred_at  timestamptz not null default now(),
  unique (ticket_id, hop),
  check (from_trc_id <> to_trc_id)
);

-- ---------------------------------------------------------------------
-- Mail waiting to go
--
-- One row per event, written by a trigger on the event table — so the
-- note is owed the moment the status changes, whichever screen, script
-- or future integration changed it. Sending is the edge function's job;
-- the unique key on event_id means a retry can never send twice.
-- ---------------------------------------------------------------------
create table public.revive_mail_outbox (
  id          bigint generated always as identity primary key,
  event_id    bigint not null unique references public.revive_ticket_events(id) on delete cascade,
  ticket_id   uuid not null references public.revive_tickets(id) on delete cascade,
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  sent_at     timestamptz,
  recipients  text[],
  error       text
);

create index revive_mail_outbox_unsent on public.revive_mail_outbox (id) where sent_at is null;

create table public.revive_settings (
  key    text primary key,
  value  text
);

-- =====================================================================
-- Who is asking
-- =====================================================================

/** The caller's own boxes, or nothing when they have none. */
create or replace function public.revive_me()
returns table (
  employee_id uuid, is_engineer boolean, is_coordinator boolean,
  is_manager boolean, is_admin boolean, is_sw_admin boolean, trc_ids uuid[]
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
              where mt.employee_id = e.id), '{}')
  from employees e
  left join revive_members m on m.employee_id = e.id
  where e.id = current_employee_id()
$fn$;

/** May edit people, boxes and labs: the Admin box, or the software administrator. */
create or replace function public.revive_is_admin()
returns boolean
language sql stable security definer set search_path to 'public'
as $fn$
  select is_sw_admin() or exists (
    select 1 from revive_members m
    where m.employee_id = current_employee_id() and m.is_admin
  )
$fn$;

/**
 * Runs a lab's desk: a coordinator of that TRC, or its manager. Managing
 * a lab includes doing its coordinator's job when the coordinator is out.
 */
create or replace function public.revive_runs_trc(p_trc_id uuid)
returns boolean
language sql stable security definer set search_path to 'public'
as $fn$
  select exists (
    select 1 from revive_members m
    join revive_member_trcs mt on mt.employee_id = m.employee_id
    where m.employee_id = current_employee_id()
      and mt.trc_id = p_trc_id
      and (m.is_coordinator or m.is_manager)
  )
$fn$;

/** May use the module at all: granted it, or holding a box in it. */
create or replace function public.revive_has_access()
returns boolean
language sql stable security definer set search_path to 'public'
as $fn$
  select is_sw_admin()
      or exists (select 1 from revive_members m where m.employee_id = current_employee_id())
      or exists (select 1 from employee_modules em
                 where em.employee_id = current_employee_id() and em.module_code = 'revive')
$fn$;

/**
 * Who can see a ticket.
 *
 * The field engineer it belongs to, whoever raised it, the engineer
 * repairing it, anybody above that field engineer in the reporting line,
 * everybody in a lab it is at or has passed through, and the admins.
 * Passing through matters: a lab that transferred a spare onward still
 * wants to know what became of it.
 */
create or replace function public.revive_can_see(p_ticket_id uuid)
returns boolean
language sql stable security definer set search_path to 'public'
as $fn$
  select exists (
    select 1 from revive_tickets t
    where t.id = p_ticket_id
      and (
        revive_is_admin()
        or t.stakeholder_id = current_employee_id()
        or t.raised_by = current_employee_id()
        or t.engineer_id = current_employee_id()
        or is_in_my_downline(t.stakeholder_id)
        or exists (
          select 1 from revive_member_trcs mt
          where mt.employee_id = current_employee_id()
            and (mt.trc_id = t.trc_id
                 or mt.trc_id in (select x.from_trc_id from revive_transfers x
                                  where x.ticket_id = t.id))
        )
      )
  )
$fn$;

-- =====================================================================
-- Row-level security: read through the rules above, write through nothing
-- =====================================================================
alter table public.revive_trcs          enable row level security;
alter table public.revive_members       enable row level security;
alter table public.revive_member_trcs   enable row level security;
alter table public.revive_tickets       enable row level security;
alter table public.revive_ticket_events enable row level security;
alter table public.revive_transfers     enable row level security;
alter table public.revive_mail_outbox   enable row level security;
alter table public.revive_settings      enable row level security;

-- Lab names and who holds which box are what the dropdowns are built
-- from; anybody in the module needs them.
create policy revive_trcs_read on public.revive_trcs
  for select to authenticated using (revive_has_access());
create policy revive_members_read on public.revive_members
  for select to authenticated using (revive_has_access());
create policy revive_member_trcs_read on public.revive_member_trcs
  for select to authenticated using (revive_has_access());

create policy revive_tickets_read on public.revive_tickets
  for select to authenticated using (revive_can_see(id));
create policy revive_ticket_events_read on public.revive_ticket_events
  for select to authenticated using (revive_can_see(ticket_id));
create policy revive_transfers_read on public.revive_transfers
  for select to authenticated using (revive_can_see(ticket_id));

-- The outbox and settings have no policies at all: the service role that
-- sends the mail bypasses RLS, and nobody else has any business in them.

-- =====================================================================
-- The event trail, and the mail it owes
-- =====================================================================

create or replace function public.revive_log(
  p_ticket_id uuid, p_status text, p_from text, p_trc_id uuid, p_note text)
returns bigint
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  eid bigint;
begin
  insert into revive_ticket_events (ticket_id, status, from_status, trc_id, actor_id, note)
  values (p_ticket_id, p_status, p_from, p_trc_id, current_employee_id(),
          nullif(btrim(coalesce(p_note, '')), ''))
  returning id into eid;
  return eid;
end $fn$;

create or replace function public.revive_queue_mail()
returns trigger
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  hook text;
begin
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

create trigger revive_ticket_events_mail
  after insert on public.revive_ticket_events
  for each row execute function public.revive_queue_mail();

-- =====================================================================
-- The workflow
-- =====================================================================

/** The ticket, locked, or a plain sentence saying why not. */
create or replace function public.revive_lock(p_ticket_id uuid)
returns public.revive_tickets
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets;
begin
  select * into t from revive_tickets where id = p_ticket_id for update;
  if not found then
    raise exception 'That ticket does not exist';
  end if;
  return t;
end $fn$;

/**
 * Raising a ticket, from the field or at the lab.
 *
 * A field engineer raises it for themselves. A coordinator raising one
 * for a spare that simply arrived must name the field engineer it belongs
 * to — that person, and their manager, see it exactly as if they had sent
 * it, which is the whole point of naming them.
 */
create or replace function public.revive_raise_ticket(
  p_trc_id uuid,
  p_facility text,
  p_district text,
  p_state text,
  p_source_ticket_no text,
  p_item text,
  p_in_courier text,
  p_in_awb text,
  p_in_dispatched_on date,
  p_stakeholder_id uuid default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $fn$
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
  if not found then raise exception 'Choose the TRC the spare is going to'; end if;

  as_co := revive_runs_trc(p_trc_id);
  holder := coalesce(p_stakeholder_id, me);

  -- Raised at the lab: the field engineer has to be named, and not as the
  -- coordinator themselves unless they really are the one who sent it.
  if as_co and p_stakeholder_id is null then
    raise exception 'Name the field engineer this spare belongs to, so they and their manager can follow it';
  end if;
  if not as_co and holder <> me then
    raise exception 'Only the TRC''s coordinator can raise a ticket on somebody else''s behalf';
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
    case when as_co then 'Raised at the TRC' else 'Raised from the field' end);

  return jsonb_build_object('id', t.id, 'code', t.code, 'number', t.number);
end $fn$;

/** The coordinator takes it in. From the field, or off a transfer. */
create or replace function public.revive_accept(p_ticket_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator or manager of this TRC can accept it';
  end if;
  if t.status not in ('pending_acceptance', 'transferred') then
    raise exception 'This ticket is not waiting to be accepted';
  end if;
  update revive_tickets set status = 'accepted', updated_at = now() where id = t.id;
  perform revive_log(t.id, 'accepted', t.status, t.trc_id, p_note);
end $fn$;

/** Given to one of the lab's engineers — or given again to a different one. */
create or replace function public.revive_assign(
  p_ticket_id uuid, p_engineer_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator or manager of this TRC can assign it';
  end if;
  if t.status not in ('accepted', 'assigned') then
    raise exception 'Accept the ticket before assigning it';
  end if;
  if not exists (
    select 1 from revive_members m
    join revive_member_trcs mt on mt.employee_id = m.employee_id
    where m.employee_id = p_engineer_id and m.is_engineer and mt.trc_id = t.trc_id
  ) then
    raise exception 'That person is not an engineer at this TRC';
  end if;
  update revive_tickets
  set status = 'assigned', engineer_id = p_engineer_id, updated_at = now()
  where id = t.id;
  perform revive_log(t.id, 'assigned', t.status, t.trc_id, p_note);
end $fn$;

/** The engineer takes the job before starting it. */
create or replace function public.revive_start_repair(p_ticket_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer it is assigned to can accept this repair';
  end if;
  if t.status <> 'assigned' then
    raise exception 'This repair is not waiting for you to accept it';
  end if;
  update revive_tickets set status = 'in_repair', updated_at = now() where id = t.id;
  perform revive_log(t.id, 'in_repair', t.status, t.trc_id, p_note);
end $fn$;

/**
 * The engineer hands it back to the desk: the wrong engineer, or a spare
 * this lab cannot fix. A reason is required, because the coordinator's
 * next move — reassign, or transfer — depends entirely on it.
 */
create or replace function public.revive_return_to_desk(p_ticket_id uuid, p_note text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer it is assigned to can hand it back';
  end if;
  if t.status not in ('assigned', 'in_repair') then
    raise exception 'This ticket is not with you';
  end if;
  if length(btrim(coalesce(p_note, ''))) < 5 then
    raise exception 'Say why it is going back to the coordinator';
  end if;
  update revive_tickets
  set status = 'accepted', engineer_id = null, updated_at = now()
  where id = t.id;
  perform revive_log(t.id, 'accepted', t.status, t.trc_id, p_note);
end $fn$;

/** Repaired. The call closes, and the ticket goes to the desk for dispatch. */
create or replace function public.revive_complete_repair(p_ticket_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can close the repair';
  end if;
  if t.status <> 'in_repair' then
    raise exception 'Accept the repair before closing it';
  end if;
  update revive_tickets set status = 'repaired', updated_at = now() where id = t.id;
  perform revive_log(t.id, 'repaired', t.status, t.trc_id, p_note);
end $fn$;

/** Sent back to the field, with the courier that is carrying it. */
create or replace function public.revive_dispatch(
  p_ticket_id uuid, p_courier text, p_awb text, p_dispatched_on date, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator or manager of this TRC can dispatch it';
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
end $fn$;

/**
 * Received back. The field engineer it belongs to says so, or the lab's
 * desk does on their word — whichever of them is at a screen first.
 */
create or replace function public.revive_mark_received(p_ticket_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if not (t.stakeholder_id = current_employee_id() or revive_runs_trc(t.trc_id)) then
    raise exception 'Only the field engineer or the TRC can confirm it arrived';
  end if;
  if t.status <> 'in_transit_return' then
    raise exception 'This spare has not been dispatched back yet';
  end if;
  update revive_tickets
  set status = 'closed', closed_at = now(), updated_at = now()
  where id = t.id;
  perform revive_log(t.id, 'closed', t.status, t.trc_id, p_note);
end $fn$;

/**
 * On to another lab.
 *
 * The ticket's TRC becomes the destination at once, so the destination's
 * coordinators see it arriving and accept it when it lands — the same
 * acceptance, assignment and repair cycle, at the new lab. The hop keeps
 * where it came from and the courier that carried it.
 */
create or replace function public.revive_transfer(
  p_ticket_id uuid, p_to_trc_id uuid, p_reason text,
  p_courier text, p_awb text, p_dispatched_on date)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t    revive_tickets := revive_lock(p_ticket_id);
  dest revive_trcs;
  hop  integer;
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator or manager of this TRC can transfer it';
  end if;
  if t.status not in ('accepted', 'assigned', 'in_repair') then
    raise exception 'Accept the ticket before transferring it, and transfer it before it is repaired';
  end if;
  select * into dest from revive_trcs where id = p_to_trc_id and is_active;
  if not found then raise exception 'Choose the TRC it is going to'; end if;
  if dest.id = t.trc_id then raise exception 'It is already at that TRC'; end if;
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
end $fn$;

-- =====================================================================
-- People and labs, for admins
-- =====================================================================

/** Everybody in Revive Lab, with their boxes and labs, for the admin table. */
create or replace function public.revive_member_list()
returns table (
  employee_id uuid, ecode text, full_name text, designation text,
  is_engineer boolean, is_coordinator boolean, is_manager boolean, is_admin boolean,
  trc_ids uuid[], updated_at timestamptz, updated_by_name text
)
language sql stable security definer set search_path to 'public'
as $fn$
  select m.employee_id, e.ecode, e.full_name, e.designation,
         m.is_engineer, m.is_coordinator, m.is_manager, m.is_admin,
         coalesce((select array_agg(mt.trc_id order by mt.trc_id) from revive_member_trcs mt
                   where mt.employee_id = m.employee_id), '{}'),
         m.updated_at, u.full_name
  from revive_members m
  join employees e on e.id = m.employee_id
  left join employees u on u.id = m.updated_by
  where revive_has_access()
  order by e.full_name
$fn$;

/**
 * Find a person, by code or name.
 *
 * For naming the field engineer on a ticket and for adding somebody on the
 * admin tab. Employees' own row policy shows a person only themselves,
 * their manager and their reports, so this is how anybody in the module
 * finds anybody else — name, code and designation only, twenty at most.
 */
create or replace function public.revive_find_people(p_q text)
returns table (id uuid, ecode text, full_name text, designation text, department text)
language sql stable security definer set search_path to 'public'
as $fn$
  select e.id, e.ecode, e.full_name, e.designation, e.department
  from employees e
  where revive_has_access()
    and e.is_active
    and length(btrim(coalesce(p_q, ''))) >= 2
    and (e.ecode ilike btrim(p_q) || '%' or e.full_name ilike '%' || btrim(p_q) || '%')
  order by (upper(e.ecode) = upper(btrim(p_q))) desc, e.full_name
  limit 20
$fn$;

/**
 * Sets one person's boxes and labs in one go.
 *
 * Every box clear and no lab ticked removes them. An admin cannot take
 * their own Admin box away — the software administrator can — because the
 * last admin unticking themselves is a table nobody can edit any more.
 */
create or replace function public.revive_save_member(
  p_employee_id uuid,
  p_engineer boolean, p_coordinator boolean, p_manager boolean, p_admin boolean,
  p_trc_ids uuid[])
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
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
    raise exception 'One of those TRCs does not exist';
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
end $fn$;

/** Adds a lab, or renames, retypes or retires one. */
create or replace function public.revive_save_trc(
  p_id uuid, p_name text, p_kind text, p_active boolean default true)
returns uuid
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  tid uuid := p_id;
begin
  if not revive_is_admin() then
    raise exception 'Only a Revive Lab admin can change the TRCs';
  end if;
  if p_kind not in ('regional', 'project') then
    raise exception 'A TRC is Regional or Project';
  end if;
  if exists (select 1 from revive_trcs
             where lower(btrim(name)) = lower(btrim(p_name)) and id is distinct from p_id) then
    raise exception 'There is already a TRC called "%"', btrim(p_name);
  end if;

  if tid is null then
    insert into revive_trcs (name, kind, is_active, created_by)
    values (btrim(p_name), p_kind, coalesce(p_active, true), current_employee_id())
    returning id into tid;
  else
    update revive_trcs
    set name = btrim(p_name), kind = p_kind, is_active = coalesce(p_active, true)
    where id = tid;
    if not found then raise exception 'That TRC does not exist'; end if;
  end if;

  perform log_audit('revive_trc', tid, 'saved',
    jsonb_build_object('name', btrim(p_name), 'kind', p_kind, 'active', coalesce(p_active, true)));
  return tid;
end $fn$;

-- =====================================================================
-- Grants: the functions a signed-in person calls. Internal helpers stay
-- callable only from inside the functions above.
-- =====================================================================
revoke all on function public.revive_log(uuid, text, text, uuid, text) from public;
revoke all on function public.revive_lock(uuid) from public;
revoke all on function public.revive_queue_mail() from public;

grant execute on function
  public.revive_me(),
  public.revive_is_admin(),
  public.revive_has_access(),
  public.revive_runs_trc(uuid),
  public.revive_can_see(uuid),
  public.revive_raise_ticket(uuid, text, text, text, text, text, text, text, date, uuid),
  public.revive_accept(uuid, text),
  public.revive_assign(uuid, uuid, text),
  public.revive_start_repair(uuid, text),
  public.revive_return_to_desk(uuid, text),
  public.revive_complete_repair(uuid, text),
  public.revive_dispatch(uuid, text, text, date, text),
  public.revive_mark_received(uuid, text),
  public.revive_transfer(uuid, uuid, text, text, text, date),
  public.revive_member_list(),
  public.revive_find_people(text),
  public.revive_save_member(uuid, boolean, boolean, boolean, boolean, uuid[]),
  public.revive_save_trc(uuid, text, text, boolean)
to authenticated;

grant select on public.revive_trcs, public.revive_members, public.revive_member_trcs,
  public.revive_tickets, public.revive_ticket_events, public.revive_transfers
to authenticated;

-- The two labs that exist today. More are added from the admin tab.
insert into public.revive_trcs (name, kind, sort_order) values
  ('Regional TRC', 'regional', 10),
  ('Project TRC', 'project', 20);
