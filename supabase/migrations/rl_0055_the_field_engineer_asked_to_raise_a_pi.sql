-- Revive Lab · rl_0055 · the field engineer asked to raise a PI
-- The user, 22 Oct: when the spare parts are many, the Revive Lab engineer asks the field engineer to raise a part
-- intent (PI) — raised in another software. One button tells the field engineer (a notification, through
-- revive_waiting_now) and writes it in the history; the ticket waits as "Waiting for PI parts" until the parts reach
-- the Revive Lab and the engineer carries on with the repair, as when a requested component comes. The wait is not
-- the repair's, as a component's is not, for the TAT.

alter table public.revive_tickets drop constraint revive_tickets_status_check;
alter table public.revive_tickets add constraint revive_tickets_status_check check (status = any (array[
  'awaiting_approval', 'approved', 'not_approved', 'pending_acceptance', 'transferred', 'accepted', 'assigned',
  'in_repair', 'parts_requested', 'parts_ordered', 'parts_ready', 'pi_requested', 'repaired', 'not_repairable',
  'service_denied', 'in_transit_return', 'received_back', 'closed']));

create or replace function public.revive_request_pi(p_ticket_id uuid, p_note text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  t revive_tickets := revive_lock(p_ticket_id);
  n text := btrim(coalesce(p_note, ''));
begin
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can ask for a PI';
  end if;
  if t.status <> 'in_repair' then
    raise exception 'A PI is asked for while it is in repair, with no component on its way';
  end if;
  if length(n) < 3 then
    raise exception 'Say which parts the PI is for';
  end if;
  if length(n) > 1000 then
    raise exception 'Keep it under 1000 characters';
  end if;
  update revive_tickets set status = 'pi_requested', updated_at = now() where id = t.id;
  perform revive_log(t.id, 'pi_requested', t.status, t.trc_id, n);
end $function$;

create or replace function public.revive_pi_received(p_ticket_id uuid, p_note text default null)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can say the PI parts came';
  end if;
  if t.status <> 'pi_requested' then
    raise exception 'This ticket is not waiting for PI parts';
  end if;
  update revive_tickets set status = 'in_repair', updated_at = now() where id = t.id;
  perform revive_log(t.id, 'in_repair', t.status, t.trc_id, p_note);
end $function$;

revoke all on function public.revive_request_pi(uuid, text) from public, anon;
revoke all on function public.revive_pi_received(uuid, text) from public, anon;
grant execute on function public.revive_request_pi(uuid, text) to authenticated;
grant execute on function public.revive_pi_received(uuid, text) to authenticated;

CREATE OR REPLACE FUNCTION public.revive_add_observation(p_ticket_id uuid, p_note text, p_voice_path text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t revive_tickets := revive_lock(p_ticket_id);
  n text := btrim(coalesce(p_note, ''));
  v text := nullif(btrim(coalesce(p_voice_path, '')), '');
begin
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can add an observation';
  end if;
  if t.status not in ('in_repair', 'parts_requested', 'parts_ordered', 'parts_ready', 'pi_requested') then
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
end $function$
;

CREATE OR REPLACE FUNCTION public.revive_set_expected_date(p_ticket_id uuid, p_expected_by date, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can change the expected date';
  end if;
  if t.status not in ('in_repair', 'parts_requested', 'parts_ordered', 'parts_ready', 'pi_requested') then
    raise exception 'The expected date can be changed while it is in repair';
  end if;
  if p_expected_by is null or p_expected_by < current_date - 1 or p_expected_by > current_date + 366 then
    raise exception 'Choose an expected date from today, within a year';
  end if;
  if p_expected_by = t.expected_by then
    raise exception 'That is already the expected date';
  end if;
  update revive_tickets set expected_by = p_expected_by, updated_at = now() where id = t.id;
  perform revive_step(t.id, t.status, t.status, t.trc_id, 'eta', 'expected',
    concat_ws(' · ', 'Expected by ' || to_char(p_expected_by, 'FMDD Mon YYYY'), nullif(btrim(coalesce(p_note, '')), '')));
end $function$
;

CREATE OR REPLACE FUNCTION public.revive_set_classification(p_ticket_id uuid, p_category text, p_criticality text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t    revive_tickets := revive_lock(p_ticket_id);
  cat  text := upper(nullif(btrim(coalesce(p_category, '')), ''));
  crit text := nullif(btrim(coalesce(p_criticality, '')), '');
begin
  if not revive_runs_trc(t.trc_id) then
    raise exception 'Only a coordinator of this Revive Lab can change the category and criticality';
  end if;
  if t.accepted_at is null or t.status not in (
       'accepted', 'assigned', 'in_repair', 'parts_requested', 'parts_ordered', 'parts_ready', 'pi_requested',
       'repaired', 'not_repairable', 'service_denied', 'awaiting_approval', 'approved') then
    raise exception 'The category and criticality can be changed from acceptance until it is dispatched back';
  end if;
  if cat is null or cat not in ('A', 'B', 'C') then
    raise exception 'Choose the spare category — A, B or C';
  end if;
  if crit is null or crit not in ('critical', 'non_critical') then
    raise exception 'Choose whether the spare is critical or non-critical';
  end if;
  if t.contract_type = 'CAMC' and crit <> 'critical' then
    raise exception 'A CAMC spare is always critical';
  end if;
  if cat is not distinct from t.spare_category and crit is not distinct from t.criticality then
    raise exception 'Nothing has changed';
  end if;

  update revive_tickets
     set spare_category = cat, criticality = crit, updated_at = now()
   where id = t.id;
  perform revive_step(t.id, t.status, t.status, t.trc_id, 'classify', null,
    concat_ws(' · ',
      case when cat is distinct from t.spare_category then
        case when t.spare_category is null then 'Category ' || cat
             else 'Category ' || t.spare_category || ' → ' || cat end end,
      case when crit is distinct from t.criticality then
        case when t.criticality is null then revive_crit_label(crit)
             else revive_crit_label(t.criticality) || ' → ' || revive_crit_label(crit) end end));
end $function$
;

CREATE OR REPLACE FUNCTION public.revive_parts_step(p_ticket_id uuid, p_action text, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- Waiting for the parts of a PI, it stays so until the engineer says they came (rl_0055).
  if t.status = 'pi_requested' then next := t.status; end if;

  if next <> t.status then
    update revive_tickets set status = next, updated_at = now() where id = t.id;
    perform revive_step(t.id, next, t.status, t.trc_id, 'status', p_action, p_note);
  else
    update revive_tickets set updated_at = now() where id = t.id;
    perform revive_step(t.id, t.status, t.status, t.trc_id, 'component', p_action, p_note);
  end if;
end $function$
;

create or replace function revive_waiting_now()
returns table (employee_id uuid, ticket_id uuid, code text, why text, at timestamptz)
language sql stable security definer set search_path = public as $$
  with
  staff as (
    select m.employee_id, mt.trc_id, m.is_coordinator, m.is_manager, m.is_purchase, m.is_admin
    from revive_members m join revive_member_trcs mt on mt.employee_id = m.employee_id
    join employees e on e.id = m.employee_id and e.is_active
  ),
  regional_admins as (
    select distinct s.employee_id from staff s join revive_trcs l on l.id = s.trc_id
    where s.is_admin and l.state is null
  ),
  approvers as (
    select employee_id from regional_admins
    union
    select distinct s.employee_id from staff s
    where s.is_admin and not exists (select 1 from regional_admins)
  ),
  t as (
    select t.*, a.kind as a_kind, a.status as a_status, a.head_id,
           (select h.to_id from revive_handovers h where h.ticket_id = t.id and h.status = 'pending' order by h.requested_at desc limit 1) as handing_to
    from revive_tickets t
    left join lateral (select * from revive_approvals a where a.ticket_id = t.id order by a.requested_at desc limit 1) a on true
    where t.closed_at is null
  ),
  waits as (
    -- going to another Revive Lab
    select head_id as who, t.id, 'Approve the move' as why, t.updated_at from t
     where status = 'awaiting_approval' and a_status = 'pending' and head_id is not null
    union all
    select ap.employee_id, t.id, 'Approve the move', t.updated_at from t cross join approvers ap
     where status = 'awaiting_approval' and not (a_status = 'pending' and head_id is not null)
    union all
    select w, t.id, 'Approved — send it', t.updated_at from t, unnest(array[raised_by, stakeholder_id]) w
     where status = 'approved' and a_kind = 'raise' and a_status in ('pending', 'approved')
    union all
    select s.employee_id, t.id, 'Approved — send it', t.updated_at from t join staff s on s.trc_id = t.trc_id and s.is_coordinator
     where status = 'approved' and a_kind = 'transfer' and a_status in ('pending', 'approved')
    union all
    select w, t.id, 'Not approved — choose another Revive Lab', t.updated_at from t, unnest(array[raised_by, stakeholder_id]) w
     where status = 'not_approved'
    -- the desk
    union all
    select s.employee_id, t.id,
           case when status = 'accepted' then 'To assign'
                when status in ('repaired', 'service_denied', 'not_repairable') then 'To dispatch'
                else 'To accept' end, t.updated_at
      from t join staff s on s.trc_id = t.trc_id and s.is_coordinator
     where status in ('pending_acceptance', 'transferred', 'accepted', 'repaired', 'service_denied')
        or (status = 'not_repairable' and nr_approved_at is not null)
    -- the engineer
    union all
    select engineer_id, t.id, case when status = 'assigned' then 'Assigned to you' else 'In repair with you' end, t.updated_at
      from t where status in ('assigned', 'in_repair') and engineer_id is not null
    -- the field engineer, asked to raise a PI for the parts (rl_0055)
    union all
    select stakeholder_id, t.id, 'Raise a PI for the parts', t.updated_at from t where status = 'pi_requested'
    -- not repairable: a manager first
    union all
    select s.employee_id, t.id, 'Not repairable — approve', t.updated_at from t join staff s on s.trc_id = t.trc_id and s.is_manager
     where status = 'not_repairable' and nr_approved_at is null
    -- on its way back
    union all
    select coalesce(handing_to, stakeholder_id), t.id,
           case when handing_to is not null then 'Asked to take it over' else 'On its way back to you' end, t.updated_at
      from t where status = 'in_transit_return'
    union all
    select stakeholder_id, t.id, 'Back with you — close it', t.updated_at from t where status = 'received_back'
    -- components
    union all
    select s.employee_id, t.id, 'Component request', coalesce(p.updated_at, t.updated_at)
      from revive_part_requests p join t on t.id = p.ticket_id
      join staff s on s.trc_id = p.trc_id
       and ((p.status in ('requested', 'bought') and s.is_coordinator)
         or (p.status = 'forwarded' and s.is_purchase)
         or (p.status = 'accepted' and ((p.route = 'local' and s.is_coordinator) or (p.route <> 'local' and s.is_purchase))))
    union all
    select t.engineer_id, t.id, 'Component sent to you', coalesce(p.updated_at, t.updated_at)
      from revive_part_requests p join t on t.id = p.ticket_id
     where p.status = 'sent' and t.engineer_id is not null
    union all
    select s.employee_id, t.id, 'Stock taken — approve', coalesce(u.updated_at, t.updated_at)
      from revive_stock_uses u join t on t.id = u.ticket_id
      join staff s on s.trc_id = u.trc_id and s.is_coordinator
     where u.status = 'requested'
  )
  select distinct on (w.who, w.id) w.who, w.id, tk.code, w.why, w.updated_at
  from waits w join revive_tickets tk on tk.id = w.id
  where w.who is not null
  order by w.who, w.id, w.updated_at desc
$$;
