/*
  rl_0027 — back to the Revive Lab, not working.

  The field engineer receives the spare, fits it, and it does not work.
  Until now they could only close the ticket saying so. The user, 23 Sep:
  "if no working, then 2 options, closed ticket button and return to trc
  … if eng clicks return, already all data is there, we need a why return
  and new courier details field also. then same flow."

  So the same ticket goes back to the Revive Lab that repaired it, waiting
  for its coordinator to accept it, and everything after is as the first
  time: accept, assign, repair, dispatch back, received, closed. And the
  first time stays (the user: "old history should also be there") — the
  history keeps every step, and nothing the round recorded is lost.

  - revive_tickets.field_returns: each time it was sent back — when, by
    whom, why, the courier — with everything the round that ended had
    recorded: its courier both ways, category, engineer, outcome,
    estimate, its photos, clip and voice note. The ticket's own fields
    then start the new round empty.
  - revive_return_to_lab: only the field engineer it was sent back to,
    only once they have confirmed it arrived. Why, and the courier, AWB
    and date it went with, are all required.
  - A later round's photos and recordings are files of their own,
    arrival-1-r2 … done-voice-r2, beside the first round's and never over
    them: revive_file_ok takes the round after the name.
  - The category TAT counts again from the next acceptance, and ends at
    the first dispatch after it.
*/

-- A later round's files: the same names, and -r2, -r3 … before the extension.
create or replace function public.revive_file_ok(p_ticket_id uuid, p_path text, p_kind text)
returns boolean
language sql immutable
as $fn$
  select p_path ~ ('^' || p_ticket_id || '/' || case p_kind
    when 'arrival'    then 'arrival-[12](-r[0-9]{1,2})?\.(jpg|jpeg|png|webp)'
    when 'done'       then 'done-[12](-r[0-9]{1,2})?\.(jpg|jpeg|png|webp)'
    when 'video'      then 'done(-r[0-9]{1,2})?\.(webm|mp4)'
    when 'return'     then 'return-[12](-r[0-9]{1,2})?\.(jpg|jpeg|png|webp)'
    when 'voice'      then '(voice-[0-9]{1,3}|done-voice(-r[0-9]{1,2})?)\.(webm|ogg|m4a|mp4|mp3|aac)'
    when 'done_voice' then 'done-voice(-r[0-9]{1,2})?\.(webm|ogg|m4a|mp4|mp3|aac)'
    else 'never' end || '$')
$fn$;

alter table public.revive_tickets
  add column if not exists field_returns jsonb not null default '[]'::jsonb;

alter table public.revive_tickets
  add constraint revive_tickets_field_returns_is_a_list check (jsonb_typeof(field_returns) = 'array');

-- ---------------------------------------------------------------------
-- The field engineer sends it back: fitted, and not working
-- ---------------------------------------------------------------------
create function public.revive_return_to_lab(
  p_ticket_id uuid, p_reason text, p_courier text, p_awb text, p_dispatched_on date)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t    revive_tickets := revive_lock(p_ticket_id);
  lab  revive_trcs;
  who  text;
  why  text := btrim(coalesce(p_reason, ''));
  c    text := nullif(btrim(coalesce(p_courier, '')), '');
  w    text := nullif(btrim(coalesce(p_awb, '')), '');
begin
  if t.stakeholder_id is distinct from current_employee_id() then
    raise exception 'Only the field engineer it was sent back to can return it';
  end if;
  if t.status <> 'received_back' then
    raise exception 'Confirm the spare arrived before sending it back';
  end if;
  if length(why) < 5 then
    raise exception 'Say why it is going back — what is not working';
  end if;
  if length(why) > 500 then
    raise exception 'Keep the reason under 500 characters';
  end if;
  if c is null then raise exception 'Enter the courier it is going back with'; end if;
  if w is null then raise exception 'Enter the tracking / AWB number'; end if;
  if p_dispatched_on is null then raise exception 'Enter the date of dispatch'; end if;
  if length(c) > 80 or length(w) > 80 then
    raise exception 'Keep the courier and the tracking number under 80 characters';
  end if;
  -- A day's grace: current_date is the database's, and India is ahead of it.
  if p_dispatched_on > current_date + 1 then
    raise exception 'The date of dispatch cannot be in the future';
  end if;
  select * into lab from revive_trcs where id = t.trc_id;
  if not lab.is_active then
    raise exception '% is no longer taking tickets — close this one and raise a new ticket', lab.name;
  end if;
  select full_name into who from employees where id = t.stakeholder_id;

  update revive_tickets
     set field_returns = field_returns || jsonb_build_array(jsonb_build_object(
           'at', now(), 'by', t.stakeholder_id, 'by_name', who, 'trc_name', lab.name,
           'reason', why, 'courier', c, 'awb', w, 'dispatched_on', p_dispatched_on,
           -- The round that ended, all of it: the ticket's own fields start the next one.
           'before', jsonb_build_object(
             'in_courier', t.in_courier, 'in_awb', t.in_awb, 'in_dispatched_on', t.in_dispatched_on,
             'accepted_at', t.accepted_at,
             'spare_category', t.spare_category, 'criticality', t.criticality,
             'arrival_damaged', t.arrival_damaged, 'arrival_photos', to_jsonb(t.arrival_photos),
             'engineer_id', t.engineer_id,
             'engineer_name', (select e.full_name from employees e where e.id = t.engineer_id),
             'engineer_ecode', (select e.ecode from employees e where e.id = t.engineer_id),
             'expected_by', t.expected_by,
             'outcome', t.outcome, 'proposal', t.proposal,
             'done_photos', to_jsonb(t.done_photos), 'done_video', t.done_video, 'done_voice', t.done_voice,
             'out_courier', t.out_courier, 'out_awb', t.out_awb, 'out_dispatched_on', t.out_dispatched_on,
             -- When it went back: that round's category TAT ended there.
             'dispatched_at', (select min(ev.at) from revive_ticket_events ev
                                where ev.ticket_id = t.id and ev.kind = 'status' and ev.status = 'in_transit_return'
                                  and (t.accepted_at is null or ev.at >= t.accepted_at)),
             'billing_estimate', t.billing_estimate,
             'received_at', t.received_at, 'return_damaged', t.return_damaged,
             'return_photos', to_jsonb(t.return_photos)))),
         status = 'pending_acceptance',
         in_courier = c, in_awb = w, in_dispatched_on = p_dispatched_on,
         -- A new round: its TAT starts when it is accepted again, any engineer may have it.
         accepted_at = null, engineer_id = null, expected_by = null,
         outcome = null, proposal = null, closure = null,
         arrival_damaged = false, arrival_photos = '{}',
         done_photos = '{}', done_video = null, done_voice = null,
         out_courier = null, out_awb = null, out_dispatched_on = null,
         billing_estimate = null,
         received_at = null, return_damaged = false, return_photos = '{}',
         updated_at = now()
   where id = t.id;
  perform revive_step(t.id, 'pending_acceptance', t.status, t.trc_id, 'status', 'field_return',
    why || E'\n' || concat_ws(' · ', c, 'AWB ' || w, 'dispatched ' || to_char(p_dispatched_on, 'FMDD Mon YYYY')));
end $fn$;

revoke all on function public.revive_return_to_lab(uuid, text, text, text, date) from public, anon;
grant execute on function public.revive_return_to_lab(uuid, text, text, text, date) to authenticated;

-- ---------------------------------------------------------------------
-- The ticket list: each return; the TAT's end is this round's dispatch
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
  billing_estimate numeric, asks_billing_estimate boolean, field_returns jsonb)
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
         t.field_returns
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
