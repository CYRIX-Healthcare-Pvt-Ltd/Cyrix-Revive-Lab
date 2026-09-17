-- =====================================================================
-- rl_0016 — components through the coordinator, and stock from a purchase
-- =====================================================================
--
-- Stock. An engineer takes what they need from the Revive Lab's stock, and
-- the coordinator approves it before the count comes off — the stock is the
-- Revive Lab's, and somebody has to be answerable for it. The ticket waits
-- while that is decided, as it waits for anything else being bought.
--
-- Requests. Everything an engineer asks for now reaches the coordinator
-- first, whichever route was asked for: a local purchase they buy
-- themselves, and a purchase they pass on to Purchase — or keep, when the
-- part turns out to be down the road after all.
--
-- What was bought becomes stock. Whoever buys it attaches the bill; the
-- coordinator then writes what it is — value, item, type and how many were
-- bought — and it goes into the Revive Lab's stock under its part number,
-- new or existing. What the engineer asked for comes off that stock for
-- this repair, and the rest stays for the next one.
--
-- And who sees a ticket. The engineer it is assigned to, rather than every
-- engineer at the Revive Lab; Purchase only where a purchase request
-- brought it to them; and a Regional Revive Lab's manager sees every
-- Revive Lab's tickets.

-- ---------------------------------------------------------------------
-- Stock taken for a repair, once the coordinator says so
-- ---------------------------------------------------------------------
create table if not exists public.revive_stock_uses (
  id             uuid primary key default gen_random_uuid(),
  ticket_id      uuid not null references public.revive_tickets(id) on delete cascade,
  component_id   uuid not null references public.revive_components(id),
  trc_id         uuid not null references public.revive_trcs(id),
  qty            integer not null check (qty between 1 and 100000),
  status         text not null default 'requested'
                 check (status in ('requested', 'approved', 'declined', 'cancelled')),
  /* Set when the coordinator approves it, and when a purchase is stocked
     and the asked-for part of it goes straight to the repair. */
  source         text not null default 'stock' check (source in ('stock', 'bought')),
  requested_by   uuid not null references public.employees(id),
  requested_at   timestamptz not null default now(),
  decided_by     uuid references public.employees(id) on delete set null,
  decided_at     timestamptz,
  decision_note  text check (decision_note is null or length(decision_note) <= 500),
  updated_at     timestamptz not null default now()
);
create index if not exists revive_stock_uses_ticket on public.revive_stock_uses (ticket_id, requested_at);
create index if not exists revive_stock_uses_open on public.revive_stock_uses (trc_id, status);

alter table public.revive_stock_uses enable row level security;
drop policy if exists revive_stock_uses_read on public.revive_stock_uses;
create policy revive_stock_uses_read on public.revive_stock_uses
  for select to authenticated using (revive_can_see(ticket_id));
grant select on public.revive_stock_uses to authenticated;

/*
  What a ticket already took from stock is history, from before the
  coordinator approved any of it: those moves become approved uses, so one
  list on the ticket tells the whole story.
*/
insert into public.revive_stock_uses (
  ticket_id, component_id, trc_id, qty, status, requested_by, requested_at, decided_by, decided_at)
select m.ticket_id, m.component_id, m.trc_id, -m.change, 'approved', m.actor_id, m.at, m.actor_id, m.at
from public.revive_component_moves m
where m.kind = 'use' and m.ticket_id is not null
  and not exists (select 1 from public.revive_stock_uses u
                  where u.ticket_id = m.ticket_id and u.component_id = m.component_id and u.requested_at = m.at);

-- ---------------------------------------------------------------------
-- The request's own journey, and what the coordinator wrote about it
-- ---------------------------------------------------------------------
-- requested  with the coordinator, whichever route was asked for
-- forwarded  passed to Purchase, waiting for them to take it on
-- accepted   being bought — by the desk, or by Purchase
-- bought     bought, with the bill, waiting for the coordinator to stock it
-- sent       in the engineer's hands to confirm
-- received   confirmed by the engineer
update public.revive_part_requests set status = 'sent' where status = 'purchased';
alter table public.revive_part_requests drop constraint if exists revive_part_requests_status_check;
alter table public.revive_part_requests add constraint revive_part_requests_status_check check (status in (
  'requested', 'forwarded', 'accepted', 'bought', 'sent', 'received', 'declined', 'cancelled'));

alter table public.revive_part_requests
  add column if not exists component_id uuid references public.revive_components(id),
  add column if not exists bought_qty integer check (bought_qty is null or bought_qty between 1 and 100000),
  add column if not exists stocked_by uuid references public.employees(id) on delete set null,
  add column if not exists stocked_at timestamptz;

comment on column public.revive_part_requests.component_id is
  'The stock this purchase became when the coordinator wrote it up (rl_0016).';

alter table public.revive_component_moves drop constraint if exists revive_component_moves_kind_check;
alter table public.revive_component_moves add constraint revive_component_moves_kind_check
  check (kind in ('count', 'use', 'buy'));

-- ---------------------------------------------------------------------
-- Who sees a ticket
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
      )
  )
$fn$;

-- ---------------------------------------------------------------------
-- The ticket's status follows everything it is waiting for
-- ---------------------------------------------------------------------
create or replace function public.revive_parts_step(p_ticket_id uuid, p_action text, p_note text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t    revive_tickets;
  next text;
begin
  select * into t from revive_tickets where id = p_ticket_id;
  select case
           -- With the coordinator, or with Purchase: nobody has taken it on yet.
           when bool_or(r.status in ('requested', 'forwarded')) then 'parts_requested'
           when bool_or(r.status in ('accepted', 'bought')) then 'parts_ordered'
           when bool_or(r.status = 'sent') then 'parts_ready'
         end
    into next
    from revive_part_requests r
   where r.ticket_id = t.id;
  -- Stock waiting to be approved is the same wait: the repair cannot go on.
  if next is null and exists (
       select 1 from revive_stock_uses u where u.ticket_id = t.id and u.status = 'requested') then
    next := 'parts_requested';
  end if;
  next := coalesce(next, 'in_repair');

  if next <> t.status then
    update revive_tickets set status = next, updated_at = now() where id = t.id;
    perform revive_step(t.id, next, t.status, t.trc_id, 'status', p_action, p_note);
  else
    update revive_tickets set updated_at = now() where id = t.id;
    perform revive_step(t.id, t.status, t.status, t.trc_id, 'component', p_action, p_note);
  end if;
end $fn$;
revoke execute on function public.revive_parts_step(uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Taking stock for a repair
-- ---------------------------------------------------------------------
/** The engineer asks; the count comes off when the coordinator approves. */
drop function if exists public.revive_use_component(uuid, uuid, integer);
create function public.revive_use_component(p_ticket_id uuid, p_component_id uuid, p_qty integer)
returns uuid
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
  c revive_components;
  u revive_stock_uses;
begin
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can use components for it';
  end if;
  if t.status not in ('in_repair', 'parts_requested', 'parts_ordered', 'parts_ready') then
    raise exception 'Components are used while it is in repair';
  end if;
  select * into c from revive_components where id = p_component_id;
  if not found or c.trc_id <> t.trc_id then
    raise exception 'That component is not in this Revive Lab''s stock';
  end if;
  if p_qty is null or p_qty < 1 then
    raise exception 'Enter how many are needed';
  end if;
  if p_qty > c.qty then
    raise exception 'Only % of % in stock', c.qty, c.part_no;
  end if;

  insert into revive_stock_uses (ticket_id, component_id, trc_id, qty, requested_by)
  values (t.id, c.id, c.trc_id, p_qty, current_employee_id())
  returning * into u;
  perform revive_parts_step(t.id, 'stock_asked',
    p_qty || ' × ' || coalesce(c.value, c.item, c.part_no) || ' (' || c.part_no || ') — waiting for the coordinator');
  return u.id;
end $fn$;
revoke execute on function public.revive_use_component(uuid, uuid, integer) from public, anon;
grant execute on function public.revive_use_component(uuid, uuid, integer) to authenticated;

/** Locks one stock use, and its ticket, for the change about to be made. */
create or replace function public.revive_lock_use(p_use_id uuid)
returns revive_stock_uses
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  tid uuid;
  u   revive_stock_uses;
begin
  select ticket_id into tid from revive_stock_uses where id = p_use_id;
  if tid is null then raise exception 'That is not a component this repair asked for'; end if;
  perform revive_lock(tid);
  select * into u from revive_stock_uses where id = p_use_id for update;
  return u;
end $fn$;
revoke execute on function public.revive_lock_use(uuid) from public, anon, authenticated;

create or replace function public.revive_approve_use(p_use_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  u revive_stock_uses := revive_lock_use(p_use_id);
  c revive_components;
begin
  if not revive_runs_trc(u.trc_id) then
    raise exception 'Only a coordinator or manager of this Revive Lab can approve what comes off its stock';
  end if;
  if u.status <> 'requested' then
    raise exception 'That has already been decided';
  end if;
  select * into c from revive_components where id = u.component_id for update;
  if u.qty > c.qty then
    raise exception 'Only % of % left in stock', c.qty, c.part_no;
  end if;

  update revive_components set qty = qty - u.qty, updated_at = now(), updated_by = current_employee_id()
   where id = c.id;
  insert into revive_component_moves (component_id, trc_id, ticket_id, kind, change, qty_after, actor_id)
  values (c.id, c.trc_id, u.ticket_id, 'use', -u.qty, c.qty - u.qty, current_employee_id());
  update revive_stock_uses
     set status = 'approved', decided_by = current_employee_id(), decided_at = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
   where id = u.id;
  perform revive_parts_step(u.ticket_id, 'stock_used',
    u.qty || ' × ' || coalesce(c.value, c.item, c.part_no) || ' (' || c.part_no || ')');
end $fn$;
revoke execute on function public.revive_approve_use(uuid, text) from public, anon;
grant execute on function public.revive_approve_use(uuid, text) to authenticated;

create or replace function public.revive_decline_use(p_use_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  u revive_stock_uses := revive_lock_use(p_use_id);
  c revive_components;
  n text := btrim(coalesce(p_reason, ''));
begin
  if not revive_runs_trc(u.trc_id) then
    raise exception 'Only a coordinator or manager of this Revive Lab can decide what comes off its stock';
  end if;
  if u.status <> 'requested' then
    raise exception 'That has already been decided';
  end if;
  if length(n) < 3 then raise exception 'Say why it is not approved'; end if;
  select * into c from revive_components where id = u.component_id;

  update revive_stock_uses
     set status = 'declined', decided_by = current_employee_id(), decided_at = now(),
         decision_note = n, updated_at = now()
   where id = u.id;
  perform revive_parts_step(u.ticket_id, 'stock_declined',
    u.qty || ' × ' || c.part_no || ' · ' || n);
end $fn$;
revoke execute on function public.revive_decline_use(uuid, text) from public, anon;
grant execute on function public.revive_decline_use(uuid, text) to authenticated;

create or replace function public.revive_cancel_use(p_use_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  u revive_stock_uses := revive_lock_use(p_use_id);
  c revive_components;
begin
  if u.requested_by is distinct from current_employee_id() then
    raise exception 'Only the engineer who asked for it can take it back';
  end if;
  if u.status <> 'requested' then
    raise exception 'That has already been decided';
  end if;
  select * into c from revive_components where id = u.component_id;
  update revive_stock_uses set status = 'cancelled', updated_at = now() where id = u.id;
  perform revive_parts_step(u.ticket_id, 'stock_cancelled', u.qty || ' × ' || c.part_no);
end $fn$;
revoke execute on function public.revive_cancel_use(uuid) from public, anon;
grant execute on function public.revive_cancel_use(uuid) to authenticated;

/** What this repair took from stock, and what is still waiting to be approved. */
drop function if exists public.revive_component_uses(uuid);
create function public.revive_component_uses(p_ticket_id uuid)
returns table (
  id uuid, component_id uuid, part_no text, value text, item text, package text, qty integer,
  status text, source text, in_stock integer,
  requested_by uuid, requested_by_name text, requested_at timestamptz,
  decided_by_name text, decided_at timestamptz, decision_note text
)
language sql stable security definer set search_path to 'public'
as $fn$
  select u.id, u.component_id, c.part_no, c.value, c.item, c.package, u.qty,
         u.status, u.source, c.qty,
         u.requested_by, rq.full_name, u.requested_at,
         dc.full_name, u.decided_at, u.decision_note
  from revive_stock_uses u
  join revive_components c on c.id = u.component_id
  left join employees rq on rq.id = u.requested_by
  left join employees dc on dc.id = u.decided_by
  where u.ticket_id = p_ticket_id and revive_can_see(p_ticket_id)
  order by u.requested_at
$fn$;
revoke execute on function public.revive_component_uses(uuid) from public, anon;
grant execute on function public.revive_component_uses(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- A request reaches the coordinator first, whichever route it asked for
-- ---------------------------------------------------------------------
/** Taken on by whoever buys it: the desk for a local purchase, Purchase for a purchase. */
create or replace function public.revive_take_part(p_request_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  r revive_part_requests := revive_lock_part(p_request_id);
begin
  if r.route = 'local' then
    if r.status <> 'requested' then raise exception 'This request is not waiting to be taken on'; end if;
    if not revive_runs_trc(r.trc_id) then
      raise exception 'Only the Revive Lab''s coordinator or manager takes on a local purchase';
    end if;
  else
    if r.status <> 'forwarded' then
      raise exception '%', case r.status when 'requested'
        then 'The coordinator passes a purchase on before Purchase can take it'
        else 'This request is not waiting to be taken on' end;
    end if;
    if not revive_buys_for(r.trc_id) then
      raise exception 'Only Purchase takes on a purchase request';
    end if;
  end if;

  update revive_part_requests
     set status = 'accepted', accepted_by = current_employee_id(), accepted_at = now(), updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, 'accepted', revive_part_label(r));
end $fn$;
revoke execute on function public.revive_take_part(uuid) from public, anon;
grant execute on function public.revive_take_part(uuid) to authenticated;

/** The button from before rl_0016; the rules above decide what it means. */
create or replace function public.revive_accept_part(p_request_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
begin
  perform revive_take_part(p_request_id);
end $fn$;

/** Passed to Purchase, because it is not to be had locally. */
create or replace function public.revive_forward_part(p_request_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  r revive_part_requests := revive_lock_part(p_request_id);
begin
  if not revive_runs_trc(r.trc_id) then
    raise exception 'Only the Revive Lab''s coordinator or manager passes a request to Purchase';
  end if;
  if r.status <> 'requested' then
    raise exception 'This request is not with you';
  end if;
  if not exists (
    select 1 from revive_members m join revive_member_trcs mt on mt.employee_id = m.employee_id
    where m.is_purchase and mt.trc_id = r.trc_id) then
    raise exception 'Nobody holds Purchase for this Revive Lab yet — ask an admin, or buy it locally';
  end if;

  update revive_part_requests
     set route = 'purchase', status = 'forwarded', updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, 'forwarded',
    concat_ws(' · ', revive_part_label(r) || ' — passed to Purchase', nullif(btrim(coalesce(p_note, '')), '')));
end $fn$;
revoke execute on function public.revive_forward_part(uuid, text) from public, anon;
grant execute on function public.revive_forward_part(uuid, text) to authenticated;

/** Kept at the Revive Lab after all: the coordinator buys it locally. */
create or replace function public.revive_make_local(p_request_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  r revive_part_requests := revive_lock_part(p_request_id);
begin
  if not revive_runs_trc(r.trc_id) then
    raise exception 'Only the Revive Lab''s coordinator or manager can buy it locally';
  end if;
  if r.status not in ('requested', 'forwarded') then
    raise exception 'It is already being bought';
  end if;

  update revive_part_requests
     set route = 'local', status = 'accepted', accepted_by = current_employee_id(),
         accepted_at = now(), updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, 'made_local',
    concat_ws(' · ', revive_part_label(r) || ' — bought locally', nullif(btrim(coalesce(p_note, '')), '')));
end $fn$;
revoke execute on function public.revive_make_local(uuid, text) from public, anon;
grant execute on function public.revive_make_local(uuid, text) to authenticated;

/**
 * Not being bought. From the coordinator that is the end of it; from
 * Purchase it goes back to the coordinator, who may still find it locally.
 */
create or replace function public.revive_decline_part(p_request_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  r     revive_part_requests := revive_lock_part(p_request_id);
  n     text := btrim(coalesce(p_reason, ''));
  buyer boolean := revive_buys_for(r.trc_id);
  desk  boolean := revive_runs_trc(r.trc_id);
begin
  if not (desk or buyer) then
    raise exception 'Only whoever holds this request can decline it';
  end if;
  if r.status not in ('requested', 'forwarded', 'accepted') then
    raise exception 'This request is not open';
  end if;
  if length(n) < 3 then
    raise exception 'Say why it is not being bought';
  end if;

  -- Purchase handing it back rather than refusing it outright.
  if not desk and buyer and r.status in ('forwarded', 'accepted') then
    update revive_part_requests
       set status = 'requested', accepted_by = null, accepted_at = null, updated_at = now()
     where id = r.id;
    perform revive_parts_step(r.ticket_id, 'handed_back',
      revive_part_label(r) || ' — Purchase cannot buy it: ' || n);
    return;
  end if;

  update revive_part_requests
     set status = 'declined', declined_by = current_employee_id(), declined_at = now(),
         declined_reason = n, updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, 'declined', revive_part_label(r) || ' · ' || n);
end $fn$;
revoke execute on function public.revive_decline_part(uuid, text) from public, anon;
grant execute on function public.revive_decline_part(uuid, text) to authenticated;

/** Bought, with the bill. It then waits for the coordinator to write it into stock. */
create or replace function public.revive_purchase_part(
  p_request_id uuid, p_amount numeric, p_bill_paths text[], p_bill_no text default null, p_vendor text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  r    revive_part_requests := revive_lock_part(p_request_id);
  path text;
begin
  if not revive_handles_part(r.route, r.trc_id) then
    raise exception 'Only whoever buys this request can attach its bill';
  end if;
  if r.status <> 'accepted' then
    raise exception 'Take the request on before buying it';
  end if;
  if p_amount is null or p_amount < 0 or p_amount > 10000000 then
    raise exception 'Enter the bill amount';
  end if;
  if coalesce(array_length(p_bill_paths, 1), 0) = 0 then
    raise exception 'Attach the bill';
  end if;
  if array_length(p_bill_paths, 1) > 3 then
    raise exception 'Attach at most 3 pages of the bill';
  end if;
  foreach path in array p_bill_paths loop
    if path !~ ('^' || r.ticket_id || '/parts/' || r.id || '/bill-[1-3]\.(jpg|jpeg|png|webp)$') then
      raise exception 'That is not this request''s bill';
    end if;
  end loop;

  update revive_part_requests
     set status = 'bought', purchased_by = current_employee_id(), purchased_at = now(),
         bill_amount = round(p_amount, 2), bill_paths = p_bill_paths,
         bill_no = nullif(btrim(coalesce(p_bill_no, '')), ''),
         vendor = nullif(btrim(coalesce(p_vendor, '')), ''),
         updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, 'purchased',
    revive_part_label(r) || ' · ₹' || regexp_replace(to_char(round(p_amount, 2), 'FM9999999990.00'), '\.00$', ''));
end $fn$;

-- ---------------------------------------------------------------------
-- What was bought becomes stock, and the repair takes its share
-- ---------------------------------------------------------------------
/**
 * The part number for something bought: the one this Revive Lab already
 * uses for that value and item, or the next free C number.
 */
create or replace function public.revive_part_no_for(p_trc_id uuid, p_value text, p_item text)
returns text
language sql stable security definer set search_path to 'public'
as $fn$
  select coalesce(
    (select c.part_no from revive_components c
      where c.trc_id = p_trc_id
        and lower(btrim(coalesce(c.value, ''))) = lower(btrim(coalesce(p_value, '')))
        and lower(btrim(coalesce(c.item, ''))) = lower(btrim(coalesce(p_item, '')))
        and btrim(coalesce(p_value, '')) <> ''
      order by c.part_no limit 1),
    'C-' || lpad(((select coalesce(max((regexp_replace(c.part_no, '\D', '', 'g'))::bigint), 0)
                   from revive_components c
                   where c.trc_id = p_trc_id and c.part_no ~ '^[A-Za-z]*-?[0-9]+$') + 1)::text, 3, '0'))
$fn$;
revoke execute on function public.revive_part_no_for(uuid, text, text) from public, anon;
grant execute on function public.revive_part_no_for(uuid, text, text) to authenticated;

/**
 * The coordinator writes up what was bought and sends it to the engineer.
 *
 * It goes into the Revive Lab's stock under its part number — the one it
 * already has, or a new one — and what the engineer asked for comes off
 * that stock for this repair. Anything bought over and above stays for the
 * next one.
 */
create or replace function public.revive_stock_part(
  p_request_id uuid, p_value text, p_item text, p_package text,
  p_part_no text default null, p_qty integer default null, p_use_qty integer default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  r       revive_part_requests := revive_lock_part(p_request_id);
  val     text := nullif(btrim(coalesce(p_value, '')), '');
  itm     text := nullif(btrim(coalesce(p_item, '')), '');
  pkg     text := nullif(btrim(coalesce(p_package, '')), '');
  part    text := nullif(btrim(coalesce(p_part_no, '')), '');
  bought  integer := coalesce(p_qty, r.qty);
  used    integer := coalesce(p_use_qty, r.qty);
  c       revive_components;
begin
  if not revive_runs_trc(r.trc_id) then
    raise exception 'Only a coordinator or manager of this Revive Lab can write it into stock';
  end if;
  if r.status <> 'bought' then
    raise exception 'Attach the bill before writing it into stock';
  end if;
  if val is null then raise exception 'Enter the value — what is printed on the part'; end if;
  if length(val) > 160 or length(coalesce(itm, '')) > 80 or length(coalesce(pkg, '')) > 40 then
    raise exception 'Keep the value, item and type short';
  end if;
  if bought is null or bought < 1 or bought > 100000 then
    raise exception 'Enter how many were bought';
  end if;
  if used is null or used < 0 or used > bought then
    raise exception 'The repair cannot take more than was bought';
  end if;
  part := coalesce(part, revive_part_no_for(r.trc_id, val, itm));
  if length(part) > 40 then raise exception 'A part number is at most 40 characters'; end if;

  select * into c from revive_components
   where trc_id = r.trc_id and lower(btrim(part_no)) = lower(part) for update;
  if not found then
    insert into revive_components (trc_id, part_no, value, item, package, qty, updated_by)
    values (r.trc_id, part, val, itm, pkg, bought, current_employee_id())
    returning * into c;
  else
    update revive_components
       set qty = qty + bought,
           value = coalesce(c.value, val), item = coalesce(c.item, itm), package = coalesce(c.package, pkg),
           updated_at = now(), updated_by = current_employee_id()
     where id = c.id
    returning * into c;
  end if;
  insert into revive_component_moves (component_id, trc_id, ticket_id, kind, change, qty_after, actor_id)
  values (c.id, c.trc_id, r.ticket_id, 'buy', bought, c.qty, current_employee_id());

  -- What this repair asked for comes off it now; the coordinator wrote it, so it needs no second approval.
  if used > 0 then
    update revive_components set qty = qty - used, updated_at = now(), updated_by = current_employee_id()
     where id = c.id
    returning * into c;
    insert into revive_component_moves (component_id, trc_id, ticket_id, kind, change, qty_after, actor_id)
    values (c.id, c.trc_id, r.ticket_id, 'use', -used, c.qty, current_employee_id());
    insert into revive_stock_uses (
      ticket_id, component_id, trc_id, qty, status, source, requested_by, decided_by, decided_at)
    values (r.ticket_id, c.id, c.trc_id, used, 'approved', 'bought', r.requested_by,
            current_employee_id(), now());
  end if;

  update revive_part_requests
     set status = 'sent', component_id = c.id, bought_qty = bought,
         stocked_by = current_employee_id(), stocked_at = now(), updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, 'stocked',
    revive_part_label(r) || ' · ' || bought || ' into stock as ' || c.part_no
      || case when used > 0 then ', ' || used || ' for this repair' else '' end);
end $fn$;
revoke execute on function public.revive_stock_part(uuid, text, text, text, text, integer, integer) from public, anon;
grant execute on function public.revive_stock_part(uuid, text, text, text, text, integer, integer) to authenticated;

/** The engineer has what was bought, and carries on. */
create or replace function public.revive_confirm_part(p_request_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  r revive_part_requests := revive_lock_part(p_request_id);
  t revive_tickets;
begin
  select * into t from revive_tickets where id = r.ticket_id;
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can confirm the purchase';
  end if;
  if r.status <> 'sent' then
    raise exception 'This has not been sent to you yet';
  end if;
  update revive_part_requests
     set status = 'received', received_by = current_employee_id(), received_at = now(), updated_at = now()
   where id = r.id;
  perform revive_parts_step(r.ticket_id, 'confirmed', revive_part_label(r));
end $fn$;

create or replace function public.revive_cancel_part(p_request_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  r revive_part_requests := revive_lock_part(p_request_id);
  t revive_tickets;
begin
  select * into t from revive_tickets where id = r.ticket_id;
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can cancel a request';
  end if;
  if r.status not in ('requested', 'forwarded', 'accepted') then
    raise exception 'Only a request that has not been bought can be cancelled';
  end if;
  update revive_part_requests set status = 'cancelled', updated_at = now() where id = r.id;
  perform revive_parts_step(r.ticket_id, 'cancelled',
    concat_ws(' · ', revive_part_label(r), nullif(btrim(coalesce(p_reason, '')), '')));
end $fn$;

-- ---------------------------------------------------------------------
-- The request list carries what the coordinator wrote up
-- ---------------------------------------------------------------------
drop function if exists public.revive_part_request_list(uuid);
create function public.revive_part_request_list(p_ticket_id uuid default null)
returns table (
  id uuid, ticket_id uuid, ticket_code text, ticket_status text, facility text,
  trc_id uuid, trc_name text, route text, name text, qty integer, note text, link text, photo_path text,
  status text, bill_amount numeric, bill_no text, vendor text, bill_paths text[],
  requested_by uuid, requested_by_name text, requested_at timestamptz,
  accepted_by_name text, accepted_at timestamptz,
  declined_by_name text, declined_at timestamptz, declined_reason text,
  purchased_by_name text, purchased_at timestamptz,
  received_by_name text, received_at timestamptz,
  component_id uuid, part_no text, value text, item text, package text,
  bought_qty integer, stocked_by_name text, stocked_at timestamptz
)
language sql stable security definer set search_path to 'public'
as $fn$
  select r.id, r.ticket_id, t.code, t.status, t.facility,
         r.trc_id, trc.name, r.route, r.name, r.qty, r.note, r.link, r.photo_path,
         r.status, r.bill_amount, r.bill_no, r.vendor, r.bill_paths,
         r.requested_by, rq.full_name, r.requested_at,
         ac.full_name, r.accepted_at,
         dc.full_name, r.declined_at, r.declined_reason,
         pu.full_name, r.purchased_at,
         rc.full_name, r.received_at,
         r.component_id, c.part_no, c.value, c.item, c.package,
         r.bought_qty, st.full_name, r.stocked_at
  from revive_part_requests r
  join revive_tickets t on t.id = r.ticket_id
  join revive_trcs trc on trc.id = r.trc_id
  left join revive_components c on c.id = r.component_id
  left join employees rq on rq.id = r.requested_by
  left join employees ac on ac.id = r.accepted_by
  left join employees dc on dc.id = r.declined_by
  left join employees pu on pu.id = r.purchased_by
  left join employees rc on rc.id = r.received_by
  left join employees st on st.id = r.stocked_by
  where (p_ticket_id is null or r.ticket_id = p_ticket_id)
    and revive_can_see(r.ticket_id)
  order by r.requested_at desc
$fn$;
grant execute on function public.revive_part_request_list(uuid) to authenticated;
