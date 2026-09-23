/*
  rl_0028 — the spare on its way back, handed to another field engineer.

  The field engineer who raised it may not be the one there when it comes
  back. The user, 23 Sep: "before [the] engineer accepting, in transit,
  next to accept, we need an option transfer ticket … engineer A should
  have the option to transfer it to another engineer — name or ecode, and
  phone number … all mandatory. Employee B should accept it, and the rest
  is normal: close call etc."

  - revive_handovers: each transfer asked for — from whom, to whom, the
    phone to reach them on — and what became of it: waiting, accepted,
    declined or cancelled. One can wait at a time.
  - revive_hand_over: the field engineer it is being sent back to, while it
    is in transit back. By E-code, with a phone; the person must be active
    and somebody else.
  - revive_answer_handover: that person accepts — they become the field
    engineer it is sent back to, their phone the contact number — or
    declines, and it stays as it was. revive_cancel_handover: the first
    engineer takes the request back.
  - Waiting, the person asked can see the ticket to decide; the first
    engineer cannot mark it received until it is settled.
  - revive_phone_of: the phone to fill in once somebody is chosen — their
    official number, or the one they gave on their own last ticket.
  - The history says each of these as a step of its own kind, 'handover':
    not a change of status, so no mail and no turnaround stage.
*/

create table public.revive_handovers (
  id           uuid primary key default gen_random_uuid(),
  ticket_id    uuid not null references public.revive_tickets(id) on delete cascade,
  from_id      uuid not null references public.employees(id),
  to_id        uuid not null references public.employees(id),
  phone        text not null check (length(btrim(phone)) between 10 and 20),
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  -- The clock, not the transaction's start: asked, answered and asked again in one go still come in order.
  requested_at timestamptz not null default clock_timestamp(),
  decided_at   timestamptz,
  check (from_id <> to_id)
);

-- One transfer waiting at a time.
create unique index revive_handovers_one_waiting on public.revive_handovers (ticket_id) where status = 'pending';
create index revive_handovers_to on public.revive_handovers (to_id) where status = 'pending';

alter table public.revive_handovers enable row level security;
create policy revive_handovers_read on public.revive_handovers
  for select to authenticated using (revive_can_see(ticket_id));
revoke all on public.revive_handovers from public, anon;
grant select on public.revive_handovers to authenticated;

alter table public.revive_ticket_events drop constraint revive_ticket_events_kind_check;
alter table public.revive_ticket_events add constraint revive_ticket_events_kind_check
  check (kind in ('status', 'observation', 'courier', 'component', 'eta', 'classify', 'handover'));

-- ---------------------------------------------------------------------
-- Who can see a ticket: and the field engineer asked to take it over
-- ---------------------------------------------------------------------
create or replace function public.revive_can_see(p_ticket_id uuid)
returns boolean
language sql stable security definer set search_path to 'public'
as $fn$
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
        -- Every Revive Lab admin, and the software administrator.
        or revive_is_admin()
        -- A Regional Revive Lab's manager sees every Revive Lab's work.
        or exists (
          select 1 from revive_members m
          join revive_member_trcs mt on mt.employee_id = m.employee_id
          join revive_trcs l on l.id = mt.trc_id
          where m.employee_id = current_employee_id() and m.is_manager and l.state is null)
        -- The desk of the Revive Lab that has it, or that sent it on.
        or exists (
          select 1 from revive_members m
          join revive_member_trcs mt on mt.employee_id = m.employee_id
          where m.employee_id = current_employee_id()
            and (m.is_coordinator or m.is_manager)
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
$fn$;

-- ---------------------------------------------------------------------
-- The phone to fill in, once somebody is chosen
-- ---------------------------------------------------------------------
create function public.revive_phone_of(p_employee_id uuid)
returns text
language sql stable security definer set search_path to 'public'
as $fn$
  select coalesce(
    (select nullif(btrim(e.official_phone), '') from employees e where e.id = p_employee_id and e.is_active),
    -- Or the number they gave on the last card they wrote for themselves.
    (select nullif(btrim(t.contact_number), '') from revive_tickets t
      where t.stakeholder_id = p_employee_id and t.raised_by = p_employee_id and t.raised_as = 'engineer'
        and nullif(btrim(t.contact_number), '') is not null
      order by t.created_at desc limit 1))
  where revive_has_access()
$fn$;

-- ---------------------------------------------------------------------
-- Handing it over, and the answer
-- ---------------------------------------------------------------------
create function public.revive_hand_over(p_ticket_id uuid, p_ecode text, p_phone text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t   revive_tickets := revive_lock(p_ticket_id);
  me  uuid := current_employee_id();
  who employees;
  ph  text := btrim(coalesce(p_phone, ''));
  digits int := length(regexp_replace(ph, '\D', '', 'g'));
begin
  if me is null or t.stakeholder_id is distinct from me then
    raise exception 'Only the field engineer it is being sent back to can transfer it';
  end if;
  if t.status <> 'in_transit_return' then
    raise exception 'A ticket is transferred while its spare is on the way back';
  end if;
  if exists (select 1 from revive_handovers h where h.ticket_id = t.id and h.status = 'pending') then
    raise exception 'A transfer is already waiting to be accepted — cancel it first';
  end if;
  if length(btrim(coalesce(p_ecode, ''))) = 0 then
    raise exception 'Enter the E-code of the engineer taking it over';
  end if;
  select * into who from employees e where upper(e.ecode) = upper(btrim(p_ecode)) and e.is_active;
  if not found then
    raise exception 'Nobody active has the E-code %', btrim(p_ecode);
  end if;
  if who.id = me then
    raise exception 'That is you — choose the engineer taking it over';
  end if;
  if digits < 10 or digits > 13 then
    raise exception 'Enter their phone number — 10 digits';
  end if;

  insert into revive_handovers (ticket_id, from_id, to_id, phone) values (t.id, me, who.id, ph);
  insert into revive_ticket_events (ticket_id, status, from_status, trc_id, actor_id, note, kind, action)
  values (t.id, t.status, t.status, t.trc_id, me, who.full_name || ' (' || who.ecode || ') · ' || ph, 'handover', 'handover_asked');
end $fn$;

create function public.revive_answer_handover(p_ticket_id uuid, p_accept boolean)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t   revive_tickets := revive_lock(p_ticket_id);
  me  uuid := current_employee_id();
  h   revive_handovers;
  was text;
begin
  select * into h from revive_handovers x where x.ticket_id = t.id and x.status = 'pending' for update;
  if not found then
    raise exception 'No transfer is waiting on this ticket';
  end if;
  if me is null or h.to_id <> me then
    raise exception 'Only the engineer it was transferred to can answer it';
  end if;
  if p_accept is null then
    raise exception 'Accept it or decline it';
  end if;
  select full_name into was from employees where id = h.from_id;

  update revive_handovers
     set status = case when p_accept then 'accepted' else 'declined' end, decided_at = clock_timestamp()
   where id = h.id;
  if p_accept then
    -- Theirs now: it is sent back to them, and the Revive Lab calls them.
    update revive_tickets set stakeholder_id = me, contact_number = h.phone, updated_at = now() where id = t.id;
  end if;
  insert into revive_ticket_events (ticket_id, status, from_status, trc_id, actor_id, note, kind, action)
  values (t.id, t.status, t.status, t.trc_id, me,
          case when p_accept then 'From ' || was || ' · reach them on ' || h.phone else 'It stays with ' || was end,
          'handover', case when p_accept then 'handover_accepted' else 'handover_declined' end);
end $fn$;

create function public.revive_cancel_handover(p_ticket_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t   revive_tickets := revive_lock(p_ticket_id);
  me  uuid := current_employee_id();
  h   revive_handovers;
  to_name text;
begin
  select * into h from revive_handovers x where x.ticket_id = t.id and x.status = 'pending' for update;
  if not found then
    raise exception 'No transfer is waiting on this ticket';
  end if;
  if me is null or h.from_id <> me then
    raise exception 'Only the engineer who asked for the transfer can cancel it';
  end if;
  select full_name into to_name from employees where id = h.to_id;
  update revive_handovers set status = 'cancelled', decided_at = clock_timestamp() where id = h.id;
  insert into revive_ticket_events (ticket_id, status, from_status, trc_id, actor_id, note, kind, action)
  values (t.id, t.status, t.status, t.trc_id, me, 'No longer to ' || to_name, 'handover', 'handover_cancelled');
end $fn$;

-- ---------------------------------------------------------------------
-- Received back: not while a transfer waits to be answered
-- ---------------------------------------------------------------------
create or replace function public.revive_mark_received(
  p_ticket_id uuid, p_note text default null, p_damaged boolean default false, p_photos text[] default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
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
  -- Handed to somebody else: settled first, one way or the other (rl_0028).
  if exists (select 1 from revive_handovers h where h.ticket_id = t.id and h.status = 'pending') then
    raise exception 'It is being transferred to another field engineer — cancel the transfer first, or let them accept it';
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
end $fn$;

revoke all on function public.revive_phone_of(uuid) from public, anon;
revoke all on function public.revive_hand_over(uuid, text, text) from public, anon;
revoke all on function public.revive_answer_handover(uuid, boolean) from public, anon;
revoke all on function public.revive_cancel_handover(uuid) from public, anon;
revoke all on function public.revive_mark_received(uuid, text, boolean, text[]) from public, anon;
revoke all on function public.revive_can_see(uuid) from public, anon;
grant execute on function public.revive_phone_of(uuid) to authenticated;
grant execute on function public.revive_hand_over(uuid, text, text) to authenticated;
grant execute on function public.revive_answer_handover(uuid, boolean) to authenticated;
grant execute on function public.revive_cancel_handover(uuid) to authenticated;
grant execute on function public.revive_mark_received(uuid, text, boolean, text[]) to authenticated;
grant execute on function public.revive_can_see(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- The ticket list: its latest transfer to another field engineer
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
  spare_category text, criticality text, contract_type text, accepted_at timestamptz, dispatched_at timestamptz,
  billing_estimate numeric, asks_billing_estimate boolean, field_returns jsonb, handover jsonb)
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
         -- The end of the Revive Lab's TAT: the first dispatch back since it
         -- was accepted — this round's, once the field has sent it back (rl_0027).
         (select min(ev.at) from revive_ticket_events ev
           where ev.ticket_id = t.id and ev.kind = 'status' and ev.status = 'in_transit_return'
             and (t.accepted_at is null or ev.at >= t.accepted_at)),
         t.billing_estimate,
         coalesce(bp.asks_billing, false),
         t.field_returns,
         -- Its latest transfer to another field engineer, whatever became of it (rl_0028).
         (select jsonb_build_object(
                   'id', h.id, 'status', h.status,
                   'from_id', h.from_id, 'from_name', fe.full_name, 'from_ecode', fe.ecode,
                   'to_id', h.to_id, 'to_name', te.full_name, 'to_ecode', te.ecode,
                   'phone', h.phone, 'requested_at', h.requested_at, 'decided_at', h.decided_at)
            from revive_handovers h
            join employees fe on fe.id = h.from_id
            join employees te on te.id = h.to_id
           where h.ticket_id = t.id
           order by h.requested_at desc, (h.status = 'pending') desc, (h.status = 'accepted') desc
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

revoke all on function public.revive_ticket_list() from public, anon;
grant execute on function public.revive_ticket_list() to authenticated;
