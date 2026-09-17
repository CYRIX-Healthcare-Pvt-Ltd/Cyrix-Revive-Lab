-- =====================================================================
-- rl_0015 — what arrived, what was found, what works, and what came back
-- =====================================================================
--
-- On arrival. The coordinator accepting a spare can photograph it, and
-- ticks Damaged in transit when the courier has done something to it — a
-- tick that asks for a photo, because that is the only proof anybody will
-- have. The courier details are on the same form: a field engineer who
-- raised the card before the courier gave a tracking number often never
-- came back to add it, and the desk has the consignment note in its hand.
--
-- While repairing. An observation can carry a voice note. Saying what is
-- wrong is quicker than typing it, one-handed, over a bench.
--
-- Repaired. Closing a repair as repaired asks for a photo of the working
-- spare, and takes a short video if the engineer wants to show it running.
--
-- Coming back. The field engineer confirms it arrived — with the same
-- damage tick and photo — and that is a step of its own: the ticket is
-- with them, not closed. They close it when they have fitted it, saying
-- whether it works.

-- ---------------------------------------------------------------------
-- What each stage records
-- ---------------------------------------------------------------------
alter table public.revive_tickets
  add column if not exists arrival_damaged boolean not null default false,
  add column if not exists arrival_photos  text[] not null default '{}',
  add column if not exists done_photos     text[] not null default '{}',
  add column if not exists done_video      text,
  add column if not exists return_damaged  boolean not null default false,
  add column if not exists return_photos   text[] not null default '{}',
  add column if not exists final_working   boolean,
  add column if not exists received_at     timestamptz;

comment on column public.revive_tickets.arrival_damaged is
  'The coordinator found it damaged in transit when it arrived (rl_0015).';
comment on column public.revive_tickets.final_working is
  'What the field engineer said when they closed the ticket: it works, or it does not.';

alter table public.revive_ticket_events
  add column if not exists voice_path text;

alter table public.revive_tickets drop constraint if exists revive_tickets_status_check;
alter table public.revive_tickets add constraint revive_tickets_status_check check (status in (
  'awaiting_approval', 'approved', 'not_approved',
  'pending_acceptance', 'transferred', 'accepted', 'assigned', 'in_repair',
  'parts_requested', 'parts_ordered', 'parts_ready',
  'repaired', 'not_repairable', 'service_denied', 'in_transit_return', 'received_back', 'closed'));

/** Every file a ticket's own folder may hold, by the step that adds it. */
create or replace function public.revive_file_ok(p_ticket_id uuid, p_path text, p_kind text)
returns boolean
language sql immutable
as $fn$
  select p_path ~ ('^' || p_ticket_id || '/' || case p_kind
    when 'arrival' then 'arrival-[12]\.(jpg|jpeg|png|webp)'
    when 'done'    then 'done-[12]\.(jpg|jpeg|png|webp)'
    when 'video'   then 'done\.(webm|mp4)'
    when 'return'  then 'return-[12]\.(jpg|jpeg|png|webp)'
    when 'voice'   then 'voice-[0-9]{1,3}\.(webm|ogg|m4a|mp4|mp3|aac)'
    else 'never' end || '$')
$fn$;
revoke execute on function public.revive_file_ok(uuid, text, text) from public, anon;
grant execute on function public.revive_file_ok(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Accepting: the photographs, the damage, and the courier details
-- ---------------------------------------------------------------------
drop function if exists public.revive_accept(uuid, text);
create function public.revive_accept(
  p_ticket_id uuid, p_note text default null,
  p_damaged boolean default false, p_photos text[] default null,
  p_courier text default null, p_awb text default null, p_dispatched_on date default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t      revive_tickets := revive_lock(p_ticket_id);
  photos text[] := coalesce(p_photos, '{}');
  path   text;
  c      text := nullif(btrim(coalesce(p_courier, '')), '');
  w      text := nullif(btrim(coalesce(p_awb, '')), '');
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator or manager of this Revive Lab can accept it';
  end if;
  if t.status not in ('pending_acceptance', 'transferred') then
    raise exception 'This ticket is not waiting to be accepted';
  end if;
  if array_length(photos, 1) > 2 then
    raise exception 'Two photographs of the spare as it arrived, at most';
  end if;
  foreach path in array photos loop
    if not revive_file_ok(t.id, path, 'arrival') then
      raise exception 'That is not a photograph of this spare arriving';
    end if;
  end loop;
  -- The one thing a damaged spare needs is the picture of it.
  if coalesce(p_damaged, false) and coalesce(array_length(photos, 1), 0) = 0 then
    raise exception 'Photograph the damage — it is the only proof there will be';
  end if;
  if length(c) > 80 or length(w) > 80 then
    raise exception 'Keep the courier and the tracking number under 80 characters';
  end if;
  if p_dispatched_on > current_date + 1 then
    raise exception 'The date of dispatch cannot be in the future';
  end if;

  update revive_tickets
     set status = 'accepted',
         arrival_damaged = coalesce(p_damaged, false),
         arrival_photos = photos,
         in_courier = coalesce(c, in_courier),
         in_awb = coalesce(w, in_awb),
         in_dispatched_on = coalesce(p_dispatched_on, in_dispatched_on),
         updated_at = now()
   where id = t.id;
  perform revive_step(t.id, 'accepted', t.status, t.trc_id, 'status',
    case when coalesce(p_damaged, false) then 'damaged' end,
    concat_ws(' · ',
      case when coalesce(p_damaged, false) then 'Damaged in transit' end,
      nullif(btrim(coalesce(p_note, '')), '')));
end $fn$;
revoke execute on function public.revive_accept(uuid, text, boolean, text[], text, text, date) from public, anon;
grant execute on function public.revive_accept(uuid, text, boolean, text[], text, text, date) to authenticated;

-- ---------------------------------------------------------------------
-- An observation, said rather than typed
-- ---------------------------------------------------------------------
drop function if exists public.revive_add_observation(uuid, text);
create function public.revive_add_observation(p_ticket_id uuid, p_note text, p_voice_path text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
  n text := btrim(coalesce(p_note, ''));
  v text := nullif(btrim(coalesce(p_voice_path, '')), '');
begin
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can add an observation';
  end if;
  if t.status not in ('in_repair', 'parts_requested', 'parts_ordered', 'parts_ready') then
    raise exception 'Observations are added while it is in repair';
  end if;
  if v is not null and not revive_file_ok(t.id, v, 'voice') then
    raise exception 'That is not this ticket''s voice note';
  end if;
  -- A voice note says it; the words beside it are then a label, not the note.
  if v is null and length(n) < 3 then
    raise exception 'Write what was found, or record it';
  end if;
  if length(n) > 1000 then
    raise exception 'Keep an observation under 1000 characters';
  end if;

  insert into revive_ticket_events (ticket_id, status, from_status, trc_id, actor_id, note, kind, voice_path)
  values (t.id, t.status, t.status, t.trc_id, current_employee_id(), nullif(n, ''), 'observation', v);
  update revive_tickets set updated_at = now() where id = t.id;
end $fn$;
revoke execute on function public.revive_add_observation(uuid, text, text) from public, anon;
grant execute on function public.revive_add_observation(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Repaired: the spare, working, in a photograph
-- ---------------------------------------------------------------------
drop function if exists public.revive_complete_repair(uuid, text, text, text);
create function public.revive_complete_repair(
  p_ticket_id uuid, p_note text default null, p_outcome text default 'repaired',
  p_proposal text default null, p_photos text[] default null, p_video text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t      revive_tickets := revive_lock(p_ticket_id);
  next   text;
  photos text[] := coalesce(p_photos, '{}');
  video  text := nullif(btrim(coalesce(p_video, '')), '');
  path   text;
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
  -- The photograph and the video belong to a repair that worked.
  if p_outcome <> 'repaired' and (coalesce(array_length(photos, 1), 0) > 0 or video is not null) then
    raise exception 'The photograph and the video are for a spare that was repaired';
  end if;
  if array_length(photos, 1) > 2 then
    raise exception 'Two photographs of the repaired spare, at most';
  end if;
  foreach path in array photos loop
    if not revive_file_ok(t.id, path, 'done') then
      raise exception 'That is not a photograph of this repair';
    end if;
  end loop;
  if video is not null and not revive_file_ok(t.id, video, 'video') then
    raise exception 'That is not this repair''s video';
  end if;

  next := case p_outcome
            when 'repaired' then 'repaired'
            when 'not_repairable' then 'not_repairable'
            else 'service_denied' end;
  update revive_tickets
     set status = next, outcome = p_outcome, proposal = p_proposal,
         done_photos = photos, done_video = video, updated_at = now()
   where id = t.id;
  perform revive_step(t.id, next, t.status, t.trc_id, 'status', p_outcome, p_note);
end $fn$;
revoke execute on function public.revive_complete_repair(uuid, text, text, text, text[], text) from public, anon;
grant execute on function public.revive_complete_repair(uuid, text, text, text, text[], text) to authenticated;

-- ---------------------------------------------------------------------
-- Back with the field engineer, and then closed
-- ---------------------------------------------------------------------
drop function if exists public.revive_mark_received(uuid, text);
create function public.revive_mark_received(
  p_ticket_id uuid, p_note text default null,
  p_damaged boolean default false, p_photos text[] default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t      revive_tickets := revive_lock(p_ticket_id);
  photos text[] := coalesce(p_photos, '{}');
  path   text;
begin
  -- The one person who can know it arrived is the one it arrived to. The
  -- Revive Lab sent it, and can only guess.
  if t.stakeholder_id is distinct from current_employee_id() then
    raise exception 'Only the field engineer it was sent back to can confirm it arrived';
  end if;
  if t.status <> 'in_transit_return' then
    raise exception 'This spare has not been dispatched back yet';
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
     set status = 'received_back', received_at = now(),
         return_damaged = coalesce(p_damaged, false), return_photos = photos, updated_at = now()
   where id = t.id;
  perform revive_step(t.id, 'received_back', t.status, t.trc_id, 'status',
    case when coalesce(p_damaged, false) then 'damaged' end,
    concat_ws(' · ',
      case when coalesce(p_damaged, false) then 'Damaged in transit' end,
      nullif(btrim(coalesce(p_note, '')), '')));
end $fn$;
revoke execute on function public.revive_mark_received(uuid, text, boolean, text[]) from public, anon;
grant execute on function public.revive_mark_received(uuid, text, boolean, text[]) to authenticated;

/*
  Closed by the field engineer once the spare is back in the machine:
  working, or not. Either way the ticket ends here — a spare that came back
  not working starts a new one, with its own card.
*/
create or replace function public.revive_close_ticket(p_ticket_id uuid, p_working boolean, p_note text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
  n text := btrim(coalesce(p_note, ''));
begin
  if t.stakeholder_id is distinct from current_employee_id() then
    raise exception 'Only the field engineer it was sent back to can close it';
  end if;
  if t.status <> 'received_back' then
    raise exception 'Confirm the spare arrived before closing the ticket';
  end if;
  if p_working is null then
    raise exception 'Say whether it works';
  end if;
  if length(n) < 2 then
    raise exception 'Give the final status';
  end if;

  update revive_tickets
     set status = 'closed', final_working = p_working, closed_at = now(), updated_at = now()
   where id = t.id;
  perform revive_step(t.id, 'closed', t.status, t.trc_id, 'status',
    case when p_working then 'working' else 'not_working' end,
    concat_ws(' · ', case when p_working then 'Working' else 'Not working' end, n));
end $fn$;
revoke execute on function public.revive_close_ticket(uuid, boolean, text) from public, anon;
grant execute on function public.revive_close_ticket(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------
-- The files: who may put what into a ticket's folder
-- ---------------------------------------------------------------------
/*
  Until now a ticket's folder held only what the sender put in it. It now
  also holds what the Revive Lab and the field engineer photograph along
  the way, and each of those is for the person whose step it is.
*/
drop policy if exists revive_attachments_insert on storage.objects;
create policy revive_attachments_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'revive-attachments'
    and exists (
      select 1 from revive_tickets t
      where t.id::text = (storage.foldername(name))[1]
        and (
          -- The route card: the sender's own photographs, video and voice note.
          (storage.filename(name) ~ '^(image-[12]\.(jpg|jpeg|png|webp)|video\.(webm|mp4)|voice\.(webm|ogg|m4a|mp4|mp3|aac))$'
           and (t.raised_by = current_employee_id() or t.stakeholder_id = current_employee_id()))
          -- How it arrived: the desk that accepted it.
          or (revive_file_ok(t.id, name, 'arrival') and revive_runs_trc(t.trc_id))
          -- The repair: its engineer.
          or ((revive_file_ok(t.id, name, 'done') or revive_file_ok(t.id, name, 'video')
               or revive_file_ok(t.id, name, 'voice'))
              and t.engineer_id = current_employee_id())
          -- How it came back: the field engineer it went to.
          or (revive_file_ok(t.id, name, 'return') and t.stakeholder_id = current_employee_id())
        )
    )
  );

-- Replacing one of those files is the same right as adding it.
drop policy if exists revive_attachments_update on storage.objects;
create policy revive_attachments_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'revive-attachments'
    and exists (
      select 1 from revive_tickets t
      where t.id::text = (storage.foldername(name))[1]
        and (
          (storage.filename(name) ~ '^(image-[12]\.(jpg|jpeg|png|webp)|video\.(webm|mp4)|voice\.(webm|ogg|m4a|mp4|mp3|aac))$'
           and (t.raised_by = current_employee_id() or t.stakeholder_id = current_employee_id()))
          or (revive_file_ok(t.id, name, 'arrival') and revive_runs_trc(t.trc_id))
          or ((revive_file_ok(t.id, name, 'done') or revive_file_ok(t.id, name, 'video')
               or revive_file_ok(t.id, name, 'voice'))
              and t.engineer_id = current_employee_id())
          or (revive_file_ok(t.id, name, 'return') and t.stakeholder_id = current_employee_id())
        )
    )
  );

-- ---------------------------------------------------------------------
-- The lists carry what was recorded
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
  proposal text, trc_state text, approval jsonb,
  arrival_damaged boolean, arrival_photos text[], done_photos text[], done_video text,
  return_damaged boolean, return_photos text[], final_working boolean, received_at timestamptz
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
           limit 1),
         t.arrival_damaged, t.arrival_photos, t.done_photos, t.done_video,
         t.return_damaged, t.return_photos, t.final_working, t.received_at
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

drop function if exists public.revive_ticket_trail(uuid);
create function public.revive_ticket_trail(p_ticket_id uuid)
returns table (
  id bigint, status text, from_status text, trc_id uuid, trc_name text,
  actor_name text, actor_ecode text, note text, at timestamptz,
  engineer_name text, engineer_ecode text, kind text, action text, voice_path text
)
language sql stable security definer set search_path to 'public'
as $fn$
  select ev.id, ev.status, ev.from_status, ev.trc_id, trc.name,
         e.full_name, e.ecode, ev.note, ev.at,
         en.full_name, en.ecode, ev.kind, ev.action, ev.voice_path
  from revive_ticket_events ev
  left join revive_trcs trc on trc.id = ev.trc_id
  left join employees e on e.id = ev.actor_id
  left join employees en on en.id = ev.engineer_id
  where ev.ticket_id = p_ticket_id
    and revive_can_see(p_ticket_id)
  order by ev.at, ev.id
$fn$;
grant execute on function public.revive_ticket_trail(uuid) to anon, authenticated, service_role;
