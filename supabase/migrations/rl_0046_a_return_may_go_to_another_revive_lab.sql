-- =====================================================================
-- Revive Lab · rl_0046 · A spare that still does not work may go back to
-- another Revive Lab
--
-- The user, 8 Oct: "when eng received and not repaired, in that return to
-- [Revive Lab] is only showing [the one] from where it got, but need option
-- to send to other [Revive Labs] also". revive_return_to_lab takes the
-- Revive Lab it goes to; left out, it is the same one as before. Another
-- one follows the route card's rule: the ticket's state's own, or a
-- Regional one. The live definition, with that and nothing else moved.
-- =====================================================================

drop function if exists public.revive_return_to_lab(uuid, text, text, text, date, text[], text, text);

CREATE OR REPLACE FUNCTION public.revive_return_to_lab(p_ticket_id uuid, p_reason text, p_courier text, p_awb text, p_dispatched_on date, p_photos text[] DEFAULT NULL::text[], p_video text DEFAULT NULL::text, p_voice text DEFAULT NULL::text, p_trc_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t     revive_tickets := revive_lock(p_ticket_id);
  lab   revive_trcs;
  who   text;
  why   text := btrim(coalesce(p_reason, ''));
  c     text := nullif(btrim(coalesce(p_courier, '')), '');
  w     text := nullif(btrim(coalesce(p_awb, '')), '');
  shots text[] := coalesce(p_photos, '{}');
  vid   text := nullif(btrim(coalesce(p_video, '')), '');
  voc   text := nullif(btrim(coalesce(p_voice, '')), '');
  -- The round this return starts: its files carry it, resend-1-r2 and so on.
  nxt   text := '-r' || (jsonb_array_length(t.field_returns) + 2) || '\.[a-z0-9]+$';
  path  text;
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
  -- As when it was first sent: a photograph of it at least (rl_0030).
  if coalesce(array_length(shots, 1), 0) = 0 then
    raise exception 'Add a photo of the spare — one at least';
  end if;
  if array_length(shots, 1) > 2 then
    raise exception 'Two photographs, at most';
  end if;
  foreach path in array shots loop
    if not revive_file_ok(t.id, path, 'resend') or path !~ nxt then
      raise exception 'That is not a photograph of this spare going back';
    end if;
  end loop;
  if vid is not null and (not revive_file_ok(t.id, vid, 'resend_video') or vid !~ nxt) then
    raise exception 'That is not a video of this spare going back';
  end if;
  if voc is not null and (not revive_file_ok(t.id, voc, 'resend_voice') or voc !~ nxt) then
    raise exception 'That is not a voice note on this spare going back';
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
  -- The same Revive Lab, or another one (rl_0046): the state's own and the Regional
  -- ones, as on the route card. Back to where it was is always allowed.
  select * into lab from revive_trcs where id = coalesce(p_trc_id, t.trc_id);
  if lab.id is null then raise exception 'Choose the Revive Lab it is going to'; end if;
  if not lab.is_active then
    raise exception '% is no longer taking tickets — choose another Revive Lab', lab.name;
  end if;
  if lab.id <> t.trc_id and lab.state is not null and lab.state is distinct from t.state then
    raise exception '% is not a Revive Lab for % — choose one of its own, or a Regional one',
      lab.name, coalesce(t.state, 'this state');
  end if;
  select full_name into who from employees where id = t.stakeholder_id;

  update revive_tickets
     set field_returns = field_returns || jsonb_build_array(jsonb_build_object(
           'at', now(), 'by', t.stakeholder_id, 'by_name', who, 'trc_name', lab.name,
           'reason', why, 'courier', c, 'awb', w, 'dispatched_on', p_dispatched_on,
           -- What it looked like going back (rl_0030).
           'photos', to_jsonb(shots), 'video', vid, 'voice', voc,
           -- The round that ended, all of it: the ticket's own fields start the next one.
           'before', jsonb_build_object(
             'in_courier', t.in_courier, 'in_awb', t.in_awb, 'in_dispatched_on', t.in_dispatched_on,
             'accepted_at', t.accepted_at, 'trc_id', t.trc_id,
             'trc_name_before', (select x.name from revive_trcs x where x.id = t.trc_id),
             'spare_category', t.spare_category, 'criticality', t.criticality,
             'arrival_damaged', t.arrival_damaged, 'arrival_photos', to_jsonb(t.arrival_photos),
             'engineer_id', t.engineer_id,
             'engineer_name', (select e.full_name from employees e where e.id = t.engineer_id),
             'engineer_ecode', (select e.ecode from employees e where e.id = t.engineer_id),
             'expected_by', t.expected_by,
             'outcome', t.outcome, 'proposal', t.proposal,
             'done_photos', to_jsonb(t.done_photos), 'done_video', t.done_video, 'done_voice', t.done_voice,
             'out_courier', t.out_courier, 'out_awb', t.out_awb, 'out_dispatched_on', t.out_dispatched_on,
             -- When the repair was closed: that round's category TAT ended there (rl_0030).
             'repaired_at', (select max(ev.at) from revive_ticket_events ev
                              where ev.ticket_id = t.id and ev.kind = 'status'
                                and ev.status in ('repaired', 'not_repairable', 'service_denied')
                                and (t.accepted_at is null or ev.at >= t.accepted_at)),
             -- When it went back.
             'dispatched_at', (select min(ev.at) from revive_ticket_events ev
                                where ev.ticket_id = t.id and ev.kind = 'status' and ev.status = 'in_transit_return'
                                  and (t.accepted_at is null or ev.at >= t.accepted_at)),
             'billing_estimate', t.billing_estimate,
             'received_at', t.received_at, 'return_damaged', t.return_damaged,
             'return_photos', to_jsonb(t.return_photos)))),
         status = 'pending_acceptance',
         trc_id = lab.id, trc_kind = lab.kind,
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
  perform revive_step(t.id, 'pending_acceptance', t.status, lab.id, 'status', 'field_return',
    case when lab.id <> t.trc_id then 'To ' || lab.name || E'\n' else '' end || why || E'\n' || concat_ws(' · ', c, 'AWB ' || w, 'dispatched ' || to_char(p_dispatched_on, 'FMDD Mon YYYY')));
end $function$
;

revoke all on function public.revive_return_to_lab(uuid, text, text, text, date, text[], text, text, uuid) from public, anon;
grant execute on function public.revive_return_to_lab(uuid, text, text, text, date, text[], text, text, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
