-- =====================================================================
-- Revive Lab  ·  rl_0007  ·  The route card
--
-- Field engineers already send spares in with a paper card tied to them:
-- "SPARE PART / EQUIPMENT Service Route card — Cyrix Revive Lab (CRL)",
-- form CHPL/CRL/SRC. The ticket now asks what the card asks, in its order,
-- so nobody fills in two different forms about one spare:
--
--   District name        district            (was already here)
--   Equipment name       equipment_name      new
--   Hospital name        facility            (the screen now says Hospital)
--   Equipment barcode    equipment_barcode   new
--   Date of dispatch     in_dispatched_on    (the inbound courier's date)
--   Spare name           spare_name          renamed from item
--   Issue identified     issue               new — plus up to two photos
--                                             and a voice note of a minute
--   Ticket ID            source_ticket_no    (the field service ticket)
--   Sent by (Name)       raised_by           filled in, never typed
--   Contact number       contact_number      new — the employee record has
--                                             no phone number to read
--   Spare return address return_address      new — where it is dispatched
--
-- The back of the card — Action taken, CRL engineer, Final status by the
-- field engineer — is the existing Close repair and Received back steps,
-- whose notes the screens now label that way.
--
-- Photos and the voice note are files, not rows: a private Storage bucket,
-- one folder per ticket, compressed in the browser before they are sent.
-- Base64 in a table would be a third larger and would sit in the database
-- every module shares. The bucket's rules mirror kpi-evidence: a file can be
-- read by exactly the people who can see its ticket (revive_can_see), added
-- only by whoever raised the ticket or the field engineer named on it, and
-- the names allowed — image-1, image-2, voice — are what cap a ticket at two
-- photos and one voice note, on the server rather than only on the screen.
-- =====================================================================

-- ---------------------------------------------------------------------
-- The card's fields
-- ---------------------------------------------------------------------
alter table public.revive_tickets rename column item to spare_name;

alter table public.revive_tickets
  add column equipment_name    text check (equipment_name is null or length(equipment_name) <= 200),
  add column equipment_barcode text check (equipment_barcode is null or length(equipment_barcode) <= 100),
  add column issue             text check (issue is null or length(issue) <= 2000),
  add column return_address    text check (return_address is null or length(return_address) <= 500),
  add column contact_number    text check (contact_number is null or length(contact_number) <= 20);

-- ---------------------------------------------------------------------
-- Raising a ticket, with the card
--
-- A new signature, so the old one goes: PostgREST picks a function by its
-- argument names, and two versions side by side would leave the old form
-- able to raise a ticket without the card.
-- ---------------------------------------------------------------------
drop function if exists public.revive_raise_ticket(uuid, text, text, text, text, text, text, text, date, uuid);

create function public.revive_raise_ticket(
  p_trc_id            uuid,
  p_hospital          text,
  p_district          text,
  p_state             text,
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
  p_stakeholder_id    uuid default null)
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
begin
  if me is null then raise exception 'Only a signed-in employee can raise a ticket'; end if;
  if not revive_has_access() then
    raise exception 'Revive Lab has not been given to you yet — ask the software administrator';
  end if;

  select * into trc from revive_trcs where id = p_trc_id and is_active;
  if not found then raise exception 'Choose the Revive Lab the spare is going to'; end if;

  -- The card's lines that a Revive Lab cannot work without.
  if length(btrim(coalesce(p_hospital, ''))) < 2 then
    raise exception 'Enter the hospital the spare came from';
  end if;
  if length(btrim(coalesce(p_spare_name, ''))) < 2 then
    raise exception 'Enter the spare''s name';
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
    trc_kind, trc_id, facility, district, state, source_ticket_no,
    equipment_name, equipment_barcode, spare_name, issue, return_address, contact_number,
    in_courier, in_awb, in_dispatched_on,
    stakeholder_id, raised_by, raised_as)
  values (
    trc.kind, trc.id,
    btrim(p_hospital),
    nullif(btrim(coalesce(p_district, '')), ''),
    nullif(btrim(coalesce(p_state, '')), ''),
    nullif(btrim(coalesce(p_source_ticket_no, '')), ''),
    nullif(btrim(coalesce(p_equipment_name, '')), ''),
    nullif(btrim(coalesce(p_equipment_barcode, '')), ''),
    btrim(p_spare_name),
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
  uuid, text, text, text, text, text, text, text, text, text, text, text, text, date, uuid)
to authenticated;

-- ---------------------------------------------------------------------
-- The list carries the card. A changed return type is a drop and create.
-- ---------------------------------------------------------------------
drop function if exists public.revive_ticket_list();

create function public.revive_ticket_list()
returns table (
  id uuid, number integer, code text, status text,
  trc_kind text, trc_id uuid, trc_name text,
  source_ticket_no text, facility text, district text, state text,
  equipment_name text, equipment_barcode text, spare_name text,
  issue text, return_address text, contact_number text,
  in_courier text, in_awb text, in_dispatched_on date,
  stakeholder_id uuid, stakeholder_name text, stakeholder_ecode text,
  stakeholder_manager_name text,
  raised_by uuid, raised_by_name text, raised_as text,
  engineer_id uuid, engineer_name text, engineer_ecode text,
  out_courier text, out_awb text, out_dispatched_on date,
  created_at timestamptz, updated_at timestamptz, closed_at timestamptz
)
language sql stable security definer set search_path to 'public'
as $fn$
  select t.id, t.number, t.code, t.status,
         t.trc_kind, t.trc_id, trc.name,
         t.source_ticket_no, t.facility, t.district, t.state,
         t.equipment_name, t.equipment_barcode, t.spare_name,
         t.issue, t.return_address, t.contact_number,
         t.in_courier, t.in_awb, t.in_dispatched_on,
         t.stakeholder_id, sh.full_name, sh.ecode,
         shm.full_name,
         t.raised_by, rb.full_name, t.raised_as,
         t.engineer_id, en.full_name, en.ecode,
         t.out_courier, t.out_awb, t.out_dispatched_on,
         t.created_at, t.updated_at, t.closed_at
  from revive_tickets t
  join revive_trcs trc on trc.id = t.trc_id
  join employees sh on sh.id = t.stakeholder_id
  left join employees shm on shm.id = sh.reporting_manager_id
  join employees rb on rb.id = t.raised_by
  left join employees en on en.id = t.engineer_id
  where revive_can_see(t.id)
  order by t.number desc
$fn$;

grant execute on function public.revive_ticket_list() to authenticated;

-- ---------------------------------------------------------------------
-- The delete's audit line names the spare by its new column.
-- ---------------------------------------------------------------------
create or replace function public.revive_delete_ticket(p_ticket_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t         revive_tickets;
  n_events  integer;
  n_hops    integer;
  remaining integer;
begin
  if not is_sw_admin() then
    raise exception 'Only the software administrator can delete a ticket';
  end if;

  select * into t from revive_tickets where id = p_ticket_id for update;
  if not found then
    raise exception 'That ticket does not exist';
  end if;

  select count(*) into n_events from revive_ticket_events where ticket_id = t.id;
  select count(*) into n_hops from revive_transfers where ticket_id = t.id;

  perform log_audit('revive_ticket', t.id, 'deleted', jsonb_build_object(
    'code', t.code,
    'status', t.status,
    'hospital', t.facility,
    'source_ticket_no', t.source_ticket_no,
    'equipment_name', t.equipment_name,
    'spare_name', t.spare_name,
    'trc_id', t.trc_id,
    'stakeholder_id', t.stakeholder_id,
    'raised_by', t.raised_by,
    'created_at', t.created_at,
    'events', n_events,
    'transfers', n_hops));

  delete from revive_tickets where id = t.id;

  select count(*) into remaining from revive_tickets;
  if remaining = 0 then
    perform setval('public.revive_ticket_number', 1, false);
  end if;

  return jsonb_build_object('code', t.code, 'numbering_restarted', remaining = 0);
end $fn$;

-- ---------------------------------------------------------------------
-- Photos and the voice note
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'revive-attachments', 'revive-attachments', false,
  -- Compressed photos land far under this; it is the ceiling for a phone
  -- that could not compress, not a size anybody should approach.
  5242880,
  array['image/jpeg', 'image/png', 'image/webp',
        'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac']
)
on conflict (id) do nothing;

-- Read: whoever can see the ticket the folder is named for.
create policy revive_attachments_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'revive-attachments'
    and exists (
      select 1 from public.revive_tickets t
      where t.id::text = (storage.foldername(objects.name))[1]
        and public.revive_can_see(t.id)
    )
  );

-- Add: the person who raised it, or the field engineer named on it — and
-- only under the three names a ticket has room for.
create policy revive_attachments_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'revive-attachments'
    and storage.filename(objects.name) ~ '^(image-[12]\.(jpg|jpeg|png|webp)|voice\.(webm|ogg|m4a|mp4|mp3|aac))$'
    and exists (
      select 1 from public.revive_tickets t
      where t.id::text = (storage.foldername(objects.name))[1]
        and (t.raised_by = public.current_employee_id()
             or t.stakeholder_id = public.current_employee_id())
    )
  );

-- Remove: the same two people, to replace a photo; and the software
-- administrator, who clears a ticket's files before deleting the ticket.
create policy revive_attachments_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'revive-attachments'
    and (
      public.is_sw_admin()
      or exists (
        select 1 from public.revive_tickets t
        where t.id::text = (storage.foldername(objects.name))[1]
          and (t.raised_by = public.current_employee_id()
               or t.stakeholder_id = public.current_employee_id())
      )
    )
  );
