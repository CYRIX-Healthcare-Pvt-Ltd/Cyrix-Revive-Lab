-- =====================================================================
-- Revive Lab  ·  rl_0008  ·  State, BEMMP, District — and a video
--
-- The route card asked for the district before the state, and let any
-- district be typed against any state. Now State comes first — every state
-- and union territory, alphabetically — and District offers only that
-- state's districts (the list lives in the app, src/lib/india.ts). Both
-- are required, because a spare nobody can place is a spare nobody can
-- route back.
--
-- Between them sits BEMMP: which programme the equipment belongs to. AP,
-- KL, RJ, UP and Pvt to start with; a Revive Lab admin, or the software
-- administrator, adds more from People & Revive Labs. A list rather than
-- free text so that "KL", "Kerala" and "kl bemmp" do not become three
-- programmes in every report.
--
-- The sender's function — KLBEMP, RJBEMP, Care 360 — travels with their
-- name, read from their employee record, so the Revive Lab can see which
-- part of the business a spare is coming from without asking. The field
-- engineer's too, for a spare a coordinator raised on their behalf.
--
-- And after the photos, an optional short video — then the voice note.
-- The app records it itself, at 640×480 and a low bitrate, capped at 30
-- seconds, so it lands at about 2 MB rather than a phone camera's 60. It
-- is deleted when the ticket closes: it explains a fault to the Revive
-- Lab, and once the spare is back that job is done. The bucket's rules
-- now allow a video.webm or video.mp4 per ticket, and the per-file ceiling
-- rises to 10 MB for a browser that ignores the requested bitrate.
-- =====================================================================

-- ---------------------------------------------------------------------
-- BEMMP programmes
-- ---------------------------------------------------------------------
create table public.revive_bemmp_projects (
  id          uuid primary key default gen_random_uuid(),
  code        text not null check (length(btrim(code)) between 1 and 20),
  is_active   boolean not null default true,
  sort_order  integer not null default 100,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.employees(id) on delete set null
);

create unique index revive_bemmp_projects_code_key on public.revive_bemmp_projects (lower(btrim(code)));

alter table public.revive_bemmp_projects enable row level security;

create policy revive_bemmp_projects_read on public.revive_bemmp_projects
  for select to authenticated using (revive_has_access());

grant select on public.revive_bemmp_projects to authenticated;

insert into public.revive_bemmp_projects (code, sort_order) values
  ('AP', 10), ('KL', 20), ('RJ', 30), ('UP', 40), ('Pvt', 50);

/** Adds a programme, or renames or retires one. Admins only. */
create or replace function public.revive_save_bemmp(
  p_id uuid, p_code text, p_active boolean default true)
returns uuid
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  pid   uuid := p_id;
  clean text := btrim(coalesce(p_code, ''));
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

  if pid is null then
    insert into revive_bemmp_projects (code, is_active, sort_order, created_by)
    values (clean, coalesce(p_active, true),
            coalesce((select max(sort_order) from revive_bemmp_projects), 0) + 10,
            current_employee_id())
    returning id into pid;
  else
    update revive_bemmp_projects set code = clean, is_active = coalesce(p_active, true)
    where id = pid;
    if not found then raise exception 'That BEMMP does not exist'; end if;
  end if;

  perform log_audit('revive_bemmp', pid, 'saved',
    jsonb_build_object('code', clean, 'active', coalesce(p_active, true)));
  return pid;
end $fn$;

grant execute on function public.revive_save_bemmp(uuid, text, boolean) to authenticated;

alter table public.revive_tickets
  add column bemmp_id uuid references public.revive_bemmp_projects(id);

-- ---------------------------------------------------------------------
-- Raising a ticket: state, BEMMP and district now required
-- ---------------------------------------------------------------------
drop function if exists public.revive_raise_ticket(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text, date, uuid);

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
    equipment_name, equipment_barcode, spare_name, issue, return_address, contact_number,
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
  uuid, text, text, uuid, text, text, text, text, text, text, text, text, text, text, date, uuid)
to authenticated;

-- ---------------------------------------------------------------------
-- The list carries the BEMMP. A changed return type is a drop and create.
-- ---------------------------------------------------------------------
drop function if exists public.revive_ticket_list();

create function public.revive_ticket_list()
returns table (
  id uuid, number integer, code text, status text,
  trc_kind text, trc_id uuid, trc_name text,
  source_ticket_no text, facility text, district text, state text,
  bemmp_id uuid, bemmp_code text,
  equipment_name text, equipment_barcode text, spare_name text,
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
         t.equipment_name, t.equipment_barcode, t.spare_name,
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

-- ---------------------------------------------------------------------
-- The video: one per ticket, and room for it in the bucket
-- ---------------------------------------------------------------------
update storage.buckets
set file_size_limit = 10485760,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp',
                               'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac',
                               'video/webm', 'video/mp4']
where id = 'revive-attachments';

drop policy if exists revive_attachments_insert on storage.objects;

create policy revive_attachments_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'revive-attachments'
    and storage.filename(objects.name) ~ '^(image-[12]\.(jpg|jpeg|png|webp)|video\.(webm|mp4)|voice\.(webm|ogg|m4a|mp4|mp3|aac))$'
    and exists (
      select 1 from public.revive_tickets t
      where t.id::text = (storage.foldername(objects.name))[1]
        and (t.raised_by = public.current_employee_id()
             or t.stakeholder_id = public.current_employee_id())
    )
  );
