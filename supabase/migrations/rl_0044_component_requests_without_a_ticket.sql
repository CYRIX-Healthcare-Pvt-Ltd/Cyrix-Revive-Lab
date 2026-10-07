-- =====================================================================
-- Revive Lab · rl_0044 · Component requests without a ticket: PR-01, PR-02 …
--
-- The user, 7 Oct: "TRC eng, or coordinator should have option to reqst
-- component locally or to purchase, the same flow but without any ticket.
-- so if trc eng rqsts, it goes to coordinator … in that PR no PR-01, like
-- that, so when coordinator recevies it they can add it into stock".
--
-- The same request, the same journey, with no ticket under it:
--   * A Revive Lab engineer asks: it is with the coordinator, who
--     purchases it locally or passes it to Purchase — as on a ticket.
--   * The coordinator asks: they have already decided, so a local
--     purchase is theirs to purchase and a purchase goes to Purchase.
--   * Purchased (a bill, or Purchase's order), the coordinator adds it to
--     the Revive Lab's stock, all of it, and the request is done: stocked.
-- Each has its own number, PR-01 on, made the way ticket numbers are.
-- Its history — passed on, handed back, cancelled, and why — is kept in
-- revive_part_events, since there is no ticket history to write it into.
--
-- Functions are the live definitions with the changes swapped in
-- (make_rl0044.mjs); requests on a ticket go exactly as before.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. A request may stand without a ticket, and then carries a number.
-- ---------------------------------------------------------------------
alter table public.revive_part_requests alter column ticket_id drop not null;

create sequence if not exists public.revive_pr_number;
revoke all on sequence public.revive_pr_number from anon, authenticated;

alter table public.revive_part_requests add column if not exists number integer;
alter table public.revive_part_requests add column if not exists code text
  generated always as (case when number is null then null
                            else 'PR-' || case when number < 10 then '0' else '' end || number::text end) stored;

alter table public.revive_part_requests drop constraint if exists revive_part_requests_pr_number_check;
alter table public.revive_part_requests add constraint revive_part_requests_pr_number_check
  check ((ticket_id is null) = (number is not null));
create unique index if not exists revive_part_requests_number_key
  on public.revive_part_requests (number) where number is not null;
create index if not exists revive_part_requests_stock_idx
  on public.revive_part_requests (trc_id, requested_at desc) where ticket_id is null;

-- Done for the stock: added to it, with nobody to send it to.
alter table public.revive_part_requests drop constraint revive_part_requests_status_check;
alter table public.revive_part_requests add constraint revive_part_requests_status_check
  check (status = any (array['requested', 'forwarded', 'accepted', 'bought', 'sent', 'received', 'stocked', 'declined', 'cancelled']));
alter table public.revive_part_requests drop constraint if exists revive_part_requests_stocked_check;
alter table public.revive_part_requests add constraint revive_part_requests_stocked_check
  check (status <> 'stocked' or ticket_id is null);

-- ---------------------------------------------------------------------
-- 2. The history of a request without a ticket.
-- ---------------------------------------------------------------------
create table if not exists public.revive_part_events (
  id          bigserial primary key,
  request_id  uuid not null references public.revive_part_requests(id) on delete cascade,
  at          timestamptz not null default now(),
  actor_id    uuid references public.employees(id) on delete set null,
  action      text not null,
  note        text
);
create index if not exists revive_part_events_request_idx on public.revive_part_events (request_id, at);
alter table public.revive_part_events enable row level security;
-- Read through revive_part_request_list and written by the request functions; nobody touches it directly.
revoke all on public.revive_part_events from anon, authenticated;
revoke all on sequence public.revive_part_events_id_seq from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Who sees a request.
--    On a ticket: whoever sees the ticket, as before.
--    Without one: whoever asked for it, the Revive Lab's coordinators and
--    managers, every Revive Lab admin, and Purchase once it is a purchase.
-- ---------------------------------------------------------------------
create or replace function public.revive_can_see_part(p_request_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from revive_part_requests r
     where r.id = p_request_id
       and case when r.ticket_id is not null then revive_can_see(r.ticket_id)
                else r.requested_by = current_employee_id()
                  or revive_runs_trc(r.trc_id)
                  or revive_manages_trc(r.trc_id)
                  or (r.route = 'purchase' and revive_buys_for(r.trc_id))
           end)
$function$;
revoke execute on function public.revive_can_see_part(uuid) from public, anon;
grant execute on function public.revive_can_see_part(uuid) to authenticated;

drop policy if exists revive_part_requests_read on public.revive_part_requests;
create policy revive_part_requests_read on public.revive_part_requests
  for select to authenticated
  using (case when ticket_id is not null then revive_can_see(ticket_id) else revive_can_see_part(id) end);

-- ---------------------------------------------------------------------
-- 4. Where a request's photo and bill live: in its ticket's folder, as
--    before, or — without a ticket — requests/<request>/.
-- ---------------------------------------------------------------------
create or replace function public.revive_part_folder(r revive_part_requests)
returns text
language sql
immutable
as $function$
  select case when r.ticket_id is null then 'requests/' || r.id::text
              else r.ticket_id::text || '/parts/' || r.id::text end
$function$;
revoke execute on function public.revive_part_folder(revive_part_requests) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. A step: on a ticket, its history and status (revive_parts_step, as
--    before); without one, the request's own history, with the reason.
-- ---------------------------------------------------------------------
create or replace function public.revive_part_step(p_request revive_part_requests, p_action text, p_note text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if p_request.ticket_id is not null then
    perform revive_parts_step(p_request.ticket_id, p_action, p_note);
  else
    insert into revive_part_events (request_id, actor_id, action, note)
    values (p_request.id, current_employee_id(), p_action, nullif(btrim(coalesce(p_reason, '')), ''));
  end if;
end $function$;
revoke execute on function public.revive_part_step(revive_part_requests, text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Asking for a component for the Revive Lab's stock.
-- ---------------------------------------------------------------------
create or replace function public.revive_request_stock_part(
  p_trc_id uuid, p_route text, p_name text, p_qty integer, p_note text default null, p_link text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  me    uuid := current_employee_id();
  desk  boolean := revive_runs_trc(p_trc_id);
  lnk   text := nullif(btrim(coalesce(p_link, '')), '');
  r     revive_part_requests;
begin
  if not exists (select 1 from revive_trcs where id = p_trc_id and is_active) then
    raise exception 'Choose the Revive Lab it is for';
  end if;
  if not desk and not exists (
    select 1 from revive_members m join revive_member_trcs mt on mt.employee_id = m.employee_id
     where m.employee_id = me and mt.trc_id = p_trc_id and m.is_engineer) then
    raise exception 'Only the Revive Lab''s engineers and coordinator request components for its stock';
  end if;
  if coalesce(p_route, '') not in ('local', 'purchase') then
    raise exception 'Choose local purchase or purchase';
  end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then
    raise exception 'Enter the component name';
  end if;
  if length(btrim(p_name)) > 160 then
    raise exception 'Keep the component name under 160 characters';
  end if;
  if p_qty is null or p_qty < 1 or p_qty > 100000 then
    raise exception 'Enter how many are needed';
  end if;
  if lnk is not null and (lnk !~* '^https?://' or length(lnk) > 1000) then
    raise exception 'The link should start with http:// or https://';
  end if;
  if p_route = 'purchase' and not exists (
    select 1 from revive_members m join revive_member_trcs mt on mt.employee_id = m.employee_id
    where m.is_purchase and mt.trc_id = p_trc_id) then
    raise exception 'Nobody has the Purchase role for this Revive Lab yet — ask an admin, or make it a local purchase';
  end if;

  -- An engineer's request goes to the coordinator. The coordinator's own is already decided:
  -- a local purchase is theirs to purchase, a purchase goes to Purchase.
  insert into revive_part_requests (ticket_id, number, trc_id, route, name, qty, note, link, requested_by,
                                    status, accepted_by, accepted_at)
  values (null, nextval('revive_pr_number'), p_trc_id, p_route, btrim(p_name), p_qty,
          nullif(btrim(coalesce(p_note, '')), ''), lnk, me,
          case when not desk then 'requested' when p_route = 'local' then 'accepted' else 'forwarded' end,
          case when desk and p_route = 'local' then me end,
          case when desk and p_route = 'local' then now() end)
  returning * into r;

  perform revive_part_step(r, 'requested', concat_ws(' · ', revive_part_label(r), r.note));
  if desk and p_route = 'purchase' then
    perform revive_part_step(r, 'forwarded', revive_part_label(r) || ' — passed to Purchase');
  end if;
  return jsonb_build_object('id', r.id, 'code', r.code, 'status', r.status);
end $function$;
revoke execute on function public.revive_request_stock_part(uuid, text, text, integer, text, text) from public, anon;
grant execute on function public.revive_request_stock_part(uuid, text, text, integer, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 7. The request functions, live, with the changes above swapped in.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revive_take_part(p_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r revive_part_requests := revive_lock_part(p_request_id);
begin
  if r.route = 'local' then
    if r.status <> 'requested' then raise exception 'This request is not waiting to be taken on'; end if;
    if not revive_runs_trc(r.trc_id) then
      raise exception 'Only the Revive Lab''s coordinator takes on a local purchase';
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
  perform revive_part_step(r, 'accepted', revive_part_label(r));
end $function$;

CREATE OR REPLACE FUNCTION public.revive_set_part_progress(p_request_id uuid, p_progress text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r    revive_part_requests := revive_lock_part(p_request_id);
  next text := nullif(btrim(coalesce(p_progress, '')), '');
begin
  if not revive_runs_trc(r.trc_id) then
    raise exception 'Only the Revive Lab''s coordinator keeps a local purchase up to date';
  end if;
  if r.route <> 'local' or r.status <> 'accepted' then
    raise exception 'Only a local purchase under way has this status';
  end if;
  if next is not null and next not in ('enquiry_given', 'order_placed') then
    raise exception 'Choose Enquiry given or Order placed';
  end if;
  if next is not distinct from r.progress then return; end if;

  update revive_part_requests
     set progress = next, progress_by = current_employee_id(), progress_at = now(), updated_at = now()
   where id = r.id;
  perform revive_part_step(r, coalesce(next, 'progress_cleared'), revive_part_label(r));
end $function$;

CREATE OR REPLACE FUNCTION public.revive_order_part(p_request_id uuid, p_po_number text, p_po_date date, p_edd date, p_vendor text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r   revive_part_requests := revive_lock_part(p_request_id);
  po  text := btrim(coalesce(p_po_number, ''));
  who text := btrim(coalesce(p_vendor, ''));
begin
  if r.route <> 'purchase' or not revive_buys_for(r.trc_id) then
    raise exception 'Only Purchase places the order for a purchase request';
  end if;
  if r.status not in ('forwarded', 'accepted') then
    raise exception 'This request is not waiting for an order';
  end if;
  if length(po) < 1 then raise exception 'Enter the PO number'; end if;
  if length(po) > 60 then raise exception 'A PO number is at most 60 characters'; end if;
  if p_po_date is null then raise exception 'Enter the PO date'; end if;
  if p_po_date > current_date + 1 then raise exception 'The PO date cannot be in the future'; end if;
  if p_edd is null then raise exception 'Enter the expected delivery date'; end if;
  if p_edd < p_po_date then raise exception 'The expected delivery date cannot be before the PO date'; end if;
  if length(who) < 2 then raise exception 'Enter the vendor''s name'; end if;
  if length(who) > 120 then raise exception 'Keep the vendor''s name under 120 characters'; end if;

  update revive_part_requests
     set status = 'bought',
         accepted_by = coalesce(accepted_by, current_employee_id()),
         accepted_at = coalesce(accepted_at, now()),
         purchased_by = current_employee_id(), purchased_at = now(),
         po_number = po, po_date = p_po_date, edd = p_edd, vendor = who,
         updated_at = now()
   where id = r.id;
  perform revive_part_step(r, 'ordered',
    revive_part_label(r) || ' · PO ' || po || ' · ' || who || ' · due ' || to_char(p_edd, 'DD Mon YYYY'));
end $function$;

CREATE OR REPLACE FUNCTION public.revive_confirm_part(p_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  perform revive_part_step(r, 'confirmed', revive_part_label(r));
end $function$;

CREATE OR REPLACE FUNCTION public.revive_forward_part(p_request_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r revive_part_requests := revive_lock_part(p_request_id);
begin
  if not revive_runs_trc(r.trc_id) then
    raise exception 'Only the Revive Lab''s coordinator passes a request to Purchase';
  end if;
  if r.status <> 'requested' then
    raise exception 'This request is not with you';
  end if;
  if not exists (
    select 1 from revive_members m join revive_member_trcs mt on mt.employee_id = m.employee_id
    where m.is_purchase and mt.trc_id = r.trc_id) then
    raise exception 'Nobody holds Purchase for this Revive Lab yet — ask an admin, or purchase it locally';
  end if;

  update revive_part_requests
     set route = 'purchase', status = 'forwarded', updated_at = now()
   where id = r.id;
  perform revive_part_step(r, 'forwarded',
    concat_ws(' · ', revive_part_label(r) || ' — passed to Purchase', nullif(btrim(coalesce(p_note, '')), '')),
    nullif(btrim(coalesce(p_note, '')), ''));
end $function$;

CREATE OR REPLACE FUNCTION public.revive_make_local(p_request_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r revive_part_requests := revive_lock_part(p_request_id);
begin
  if not revive_runs_trc(r.trc_id) then
    raise exception 'Only the Revive Lab''s coordinator can purchase it locally';
  end if;
  if r.status not in ('requested', 'forwarded') then
    raise exception 'It is already being purchased';
  end if;

  update revive_part_requests
     set route = 'local', status = 'accepted', accepted_by = current_employee_id(),
         accepted_at = now(), updated_at = now()
   where id = r.id;
  perform revive_part_step(r, 'made_local',
    concat_ws(' · ', revive_part_label(r) || ' — purchased locally', nullif(btrim(coalesce(p_note, '')), '')),
    nullif(btrim(coalesce(p_note, '')), ''));
end $function$;

CREATE OR REPLACE FUNCTION public.revive_decline_part(p_request_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    raise exception 'Say why it is not being purchased';
  end if;

  -- Purchase handing it back rather than refusing it outright.
  if not desk and buyer and r.status in ('forwarded', 'accepted') then
    update revive_part_requests
       set status = 'requested', accepted_by = null, accepted_at = null, updated_at = now()
     where id = r.id;
    perform revive_part_step(r, 'handed_back',
      revive_part_label(r) || ' — handed back by Purchase: ' || n, n);
    return;
  end if;

  update revive_part_requests
     set status = 'declined', declined_by = current_employee_id(), declined_at = now(),
         declined_reason = n, updated_at = now()
   where id = r.id;
  perform revive_part_step(r, 'declined', revive_part_label(r) || ' · ' || n, n);
end $function$;

CREATE OR REPLACE FUNCTION public.revive_cancel_part(p_request_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r revive_part_requests := revive_lock_part(p_request_id);
  t revive_tickets;
begin
  if r.ticket_id is null then
    -- For the Revive Lab's stock (rl_0044): whoever asked for it.
    if r.requested_by is distinct from current_employee_id() then
      raise exception 'Only whoever requested it can cancel it';
    end if;
  else
    select * into t from revive_tickets where id = r.ticket_id;
    if t.engineer_id is distinct from current_employee_id() then
      raise exception 'Only the engineer repairing it can cancel a request';
    end if;
  end if;
  if r.status not in ('requested', 'forwarded', 'accepted') then
    raise exception 'Only a request that has not been purchased can be cancelled';
  end if;
  update revive_part_requests set status = 'cancelled', updated_at = now() where id = r.id;
  perform revive_part_step(r, 'cancelled',
    concat_ws(' · ', revive_part_label(r), nullif(btrim(coalesce(p_reason, '')), '')),
    nullif(btrim(coalesce(p_reason, '')), ''));
end $function$;

CREATE OR REPLACE FUNCTION public.revive_purchase_part(p_request_id uuid, p_amount numeric, p_bill_paths text[], p_bill_no text DEFAULT NULL::text, p_vendor text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r    revive_part_requests := revive_lock_part(p_request_id);
  path text;
begin
  if not revive_handles_part(r.route, r.trc_id) then
    raise exception 'Only whoever purchases this request can attach its bill';
  end if;
  if r.status <> 'accepted' then
    raise exception 'Take the request on before purchasing it';
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
    if path !~ ('^' || revive_part_folder(r) || '/bill-[1-3]\.(jpg|jpeg|png|webp)$') then
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
  perform revive_part_step(r, 'purchased',
    revive_part_label(r) || ' · ₹' || regexp_replace(to_char(round(p_amount, 2), 'FM9999999990.00'), '\.00$', ''));
end $function$;

CREATE OR REPLACE FUNCTION public.revive_stock_part(p_request_id uuid, p_value text, p_item text, p_package text, p_part_no text DEFAULT NULL::text, p_qty integer DEFAULT NULL::integer, p_use_qty integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r       revive_part_requests := revive_lock_part(p_request_id);
  val     text := nullif(btrim(coalesce(p_value, '')), '');
  itm     text := nullif(btrim(coalesce(p_item, '')), '');
  pkg     text := nullif(btrim(coalesce(p_package, '')), '');
  part    text := nullif(btrim(coalesce(p_part_no, '')), '');
  bought  integer := coalesce(p_qty, r.qty);
  -- Without a ticket there is no repair to take any (rl_0044): all of it stays in stock.
  used    integer := case when r.ticket_id is null then 0 else coalesce(p_use_qty, r.qty) end;
  c       revive_components;
begin
  if not revive_runs_trc(r.trc_id) then
    raise exception 'Only a coordinator of this Revive Lab can add it to stock';
  end if;
  if r.status <> 'bought' then
    raise exception 'It is not purchased yet — the bill, or Purchase''s order, comes first';
  end if;
  if val is null then raise exception 'Enter the value — what is printed on the part'; end if;
  if length(val) > 160 or length(coalesce(itm, '')) > 80 or length(coalesce(pkg, '')) > 40 then
    raise exception 'Keep the value, item and type short';
  end if;
  if bought is null or bought < 1 or bought > 100000 then
    raise exception 'Enter how many were purchased';
  end if;
  if used is null or used < 0 or used > bought then
    raise exception 'The repair cannot take more than was purchased';
  end if;
  part := coalesce(part, revive_part_no_for(r.trc_id, val, itm));
  if length(part) > 40 then raise exception 'A part number is at most 40 characters'; end if;

  select * into c from revive_components
   where trc_id = r.trc_id and lower(btrim(part_no)) = lower(part) for update;
  -- A number that is already another part is not this one's.
  if found and c.value is not null
     and lower(regexp_replace(c.value, '\s', '', 'g')) <> lower(regexp_replace(val, '\s', '', 'g')) then
    raise exception '% is already % in this Revive Lab''s stock — leave the part number empty for a new one, or enter % to add to it',
      c.part_no, concat_ws(' · ', c.value, c.item), c.value;
  end if;
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
     set status = case when r.ticket_id is null then 'stocked' else 'sent' end, component_id = c.id, bought_qty = bought,
         stocked_by = current_employee_id(), stocked_at = now(), updated_at = now()
   where id = r.id;
  perform revive_part_step(r, 'stocked',
    revive_part_label(r) || ' · ' || bought || ' into stock as ' || c.part_no
      || case when used > 0 then ', ' || used || ' for this repair' else '' end);
end $function$;

CREATE OR REPLACE FUNCTION public.revive_lock_part(p_request_id uuid)
 RETURNS revive_part_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  tid uuid;
  r   revive_part_requests;
begin
  select ticket_id into tid from revive_part_requests where id = p_request_id;
  if not found then raise exception 'That request does not exist'; end if;
  if tid is not null then perform revive_lock(tid); end if;
  select * into r from revive_part_requests where id = p_request_id for update;
  return r;
end $function$;

CREATE OR REPLACE FUNCTION public.revive_set_part_photo(p_request_id uuid, p_path text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r revive_part_requests;
begin
  select * into r from revive_part_requests where id = p_request_id for update;
  if not found then raise exception 'That request does not exist'; end if;
  if r.requested_by is distinct from current_employee_id() then
    raise exception 'Only the engineer who asked for it can add its photo';
  end if;
  if p_path !~ ('^' || revive_part_folder(r) || '/photo\.(jpg|jpeg|png|webp)$') then
    raise exception 'That is not this request''s photo';
  end if;
  update revive_part_requests set photo_path = p_path, updated_at = now() where id = r.id;
end $function$;

CREATE OR REPLACE FUNCTION public.revive_component_history(p_component_id uuid)
 RETURNS TABLE(at timestamp with time zone, kind text, who text, who_ecode text, ticket_code text, qty integer, qty_after integer, changes jsonb, note text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with c as (
    select * from revive_components
     where id = p_component_id and (revive_in_trc(trc_id) or revive_is_admin())
  )
  -- Added or edited, by hand or by a sheet.
  -- Each with the person's name and E-code: "if any doubt we can see who updated it" (the user).
  select l.at, l.action, e.full_name, e.ecode, null::text, null::integer, null::integer, l.changes, null::text
    from revive_component_log l join c on c.id = l.component_id
    left join employees e on e.id = l.actor_id
  union all
  -- Counted by a sheet before the log began: the quantity it was set to.
  select m.at, 'counted', e.full_name, e.ecode, null, m.change, m.qty_after, null, null
    from revive_component_moves m join c on c.id = m.component_id
    left join employees e on e.id = m.actor_id
   where m.kind = 'count'
     and not exists (select 1 from revive_component_log l where l.component_id = m.component_id and l.at = m.at)
  union all
  -- Asked for, for a repair.
  select u.requested_at, 'requested', rq.full_name, rq.ecode, t.code, u.qty, null, null, null
    from revive_stock_uses u join c on c.id = u.component_id
    join revive_tickets t on t.id = u.ticket_id
    left join employees rq on rq.id = u.requested_by
   where u.source = 'stock'
  union all
  -- What the coordinator said, or the engineer taking it back.
  select u.decided_at, u.status, dc.full_name, dc.ecode, t.code, u.qty,
         (select m.qty_after from revive_component_moves m
           where m.component_id = u.component_id and m.kind = 'use' and m.ticket_id = u.ticket_id and m.at = u.decided_at
           limit 1),
         null, u.decision_note
    from revive_stock_uses u join c on c.id = u.component_id
    join revive_tickets t on t.id = u.ticket_id
    left join employees dc on dc.id = u.decided_by
   where u.decided_at is not null and u.status <> 'requested' and u.source = 'stock'
  union all
  -- Purchased for a repair, and put into this part.
  select r.stocked_at, 'purchased', sb.full_name, sb.ecode, coalesce(t.code, r.code), r.bought_qty, null, null, null
    from revive_part_requests r join c on c.id = r.component_id
    left join revive_tickets t on t.id = r.ticket_id
    left join employees sb on sb.id = r.stocked_by
   where r.stocked_at is not null
  order by 1 desc
$function$;

-- The list returns three more columns, so it is made again.
drop function if exists public.revive_part_request_list(uuid);
CREATE OR REPLACE FUNCTION public.revive_part_request_list(p_ticket_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, ticket_id uuid, ticket_code text, ticket_status text, facility text, trc_id uuid, trc_name text, route text, name text, qty integer, note text, link text, photo_path text, status text, bill_amount numeric, bill_no text, vendor text, bill_paths text[], requested_by uuid, requested_by_name text, requested_at timestamp with time zone, accepted_by_name text, accepted_at timestamp with time zone, declined_by_name text, declined_at timestamp with time zone, declined_reason text, purchased_by_name text, purchased_at timestamp with time zone, received_by_name text, received_at timestamp with time zone, component_id uuid, part_no text, value text, item text, package text, bought_qty integer, stocked_by_name text, stocked_at timestamp with time zone, progress text, progress_by_name text, progress_at timestamp with time zone, po_number text, po_date date, edd date, number integer, code text, events jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select r.id, r.ticket_id, t.code, t.status, t.facility,
         r.trc_id, trc.name, r.route, r.name, r.qty, r.note, r.link, r.photo_path,
         r.status, r.bill_amount, r.bill_no, r.vendor, r.bill_paths,
         r.requested_by, rq.full_name, r.requested_at,
         ac.full_name, r.accepted_at,
         dc.full_name, r.declined_at, r.declined_reason,
         pu.full_name, r.purchased_at,
         rc.full_name, r.received_at,
         r.component_id, c.part_no, c.value, c.item, c.package,
         r.bought_qty, st.full_name, r.stocked_at,
         r.progress, pg.full_name, r.progress_at,
         r.po_number, r.po_date, r.edd,
         r.number, r.code,
         -- What the columns do not hold for a request without a ticket: passed on, handed back, cancelled, and why.
         case when r.ticket_id is null then coalesce((
           select jsonb_agg(jsonb_build_object('action', ev.action, 'at', ev.at, 'who', ev_e.full_name, 'note', ev.note) order by ev.at, ev.id)
             from revive_part_events ev left join employees ev_e on ev_e.id = ev.actor_id
            where ev.request_id = r.id), '[]'::jsonb) else '[]'::jsonb end
  from revive_part_requests r
  left join revive_tickets t on t.id = r.ticket_id
  join revive_trcs trc on trc.id = r.trc_id
  left join revive_components c on c.id = r.component_id
  left join employees rq on rq.id = r.requested_by
  left join employees ac on ac.id = r.accepted_by
  left join employees dc on dc.id = r.declined_by
  left join employees pu on pu.id = r.purchased_by
  left join employees rc on rc.id = r.received_by
  left join employees st on st.id = r.stocked_by
  left join employees pg on pg.id = r.progress_by
  where (p_ticket_id is null or r.ticket_id = p_ticket_id)
    and case when r.ticket_id is not null then revive_can_see(r.ticket_id) else revive_can_see_part(r.id) end
  order by r.requested_at desc
$function$;
revoke execute on function public.revive_part_request_list(uuid) from public, anon;
grant execute on function public.revive_part_request_list(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 8. Files of a request without a ticket: requests/<request>/photo.* by
--    whoever asked for it; bill-1..3.* by whoever purchases it, while it
--    is being purchased; read by whoever sees the request.
-- ---------------------------------------------------------------------
drop policy if exists revive_stock_parts_read on storage.objects;
create policy revive_stock_parts_read on storage.objects for select to authenticated
  using (bucket_id = 'revive-attachments' and (storage.foldername(name))[1] = 'requests'
         and exists (select 1 from public.revive_part_requests r
                      where r.id::text = (storage.foldername(objects.name))[2] and r.ticket_id is null
                        and public.revive_can_see_part(r.id)));

drop policy if exists revive_stock_parts_insert on storage.objects;
create policy revive_stock_parts_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'revive-attachments' and (storage.foldername(name))[1] = 'requests'
              and exists (select 1 from public.revive_part_requests r
                           where r.id::text = (storage.foldername(objects.name))[2] and r.ticket_id is null
                             and ((storage.filename(objects.name) ~ '^photo\.(jpg|jpeg|png|webp)$' and r.requested_by = public.current_employee_id())
                               or (storage.filename(objects.name) ~ '^bill-[1-3]\.(jpg|jpeg|png|webp)$' and r.status = 'accepted'
                                   and public.revive_handles_part(r.route, r.trc_id)))));

drop policy if exists revive_stock_parts_update on storage.objects;
create policy revive_stock_parts_update on storage.objects for update to authenticated
  using (bucket_id = 'revive-attachments' and (storage.foldername(name))[1] = 'requests'
         and exists (select 1 from public.revive_part_requests r
                      where r.id::text = (storage.foldername(objects.name))[2] and r.ticket_id is null
                        and ((storage.filename(objects.name) ~ '^photo\.(jpg|jpeg|png|webp)$' and r.requested_by = public.current_employee_id())
                          or (storage.filename(objects.name) ~ '^bill-[1-3]\.(jpg|jpeg|png|webp)$' and r.status = 'accepted'
                              and public.revive_handles_part(r.route, r.trc_id)))));

-- ---------------------------------------------------------------------
-- 9. Deleting a component request, for the software administrator: the
--    same field as Delete a ticket takes PR-01 too (the user, 7 Oct). For
--    clearing out test requests; one audit line keeps what went, and the
--    numbering starts again at PR-01 once none are left. What it added to
--    stock stays in stock. A request on a ticket goes with its ticket.
-- ---------------------------------------------------------------------
create or replace function public.revive_delete_part_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r         revive_part_requests;
  n_events  integer;
  remaining integer;
begin
  if not is_sw_admin() then
    raise exception 'Only the software administrator can delete a component request';
  end if;
  select * into r from revive_part_requests where id = p_request_id for update;
  if not found then
    raise exception 'That component request does not exist';
  end if;
  if r.ticket_id is not null then
    raise exception 'A request on a ticket goes with its ticket';
  end if;

  select count(*) into n_events from revive_part_events where request_id = r.id;
  perform log_audit('revive_part_request', r.id, 'deleted', jsonb_build_object(
    'code', r.code, 'status', r.status, 'route', r.route, 'name', r.name, 'qty', r.qty,
    'trc_id', r.trc_id, 'requested_by', r.requested_by, 'requested_at', r.requested_at,
    'bill_amount', r.bill_amount, 'po_number', r.po_number,
    'component_id', r.component_id, 'bought_qty', r.bought_qty, 'events', n_events));

  delete from revive_part_requests where id = r.id;

  select count(*) into remaining from revive_part_requests where ticket_id is null;
  if remaining = 0 then
    perform setval('public.revive_pr_number', 1, false);
  end if;
  return jsonb_build_object('code', r.code, 'numbering_restarted', remaining = 0);
end $function$;
revoke execute on function public.revive_delete_part_request(uuid) from public, anon;
grant execute on function public.revive_delete_part_request(uuid) to authenticated;
