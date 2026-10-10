-- =====================================================================
-- Revive Lab  ·  rl_0051  ·  Whose move it is, for every open ticket
--
-- The user, 10 Oct: Revive Lab on people's phones too — "tickets
-- assigned, that ticket transfer things". The app already knows whose
-- move a ticket is (waitingOnMe in src/lib/tickets.ts: the forward
-- moves of actionsFor, and components waiting on somebody). This is the
-- same, in the database, so the notification job (KPI 0160) can tell each
-- person when something new is waiting on them.
--
-- Mirrors src/lib/tickets.ts — change one, change the other:
--   awaiting_approval   the BEMMP project head; with none, the Regional admins
--   approved            raise: the field engineer; transfer: the desk
--   not_approved        the field engineer (another Revive Lab)
--   pending_acceptance / transferred      the desk accepts
--   accepted            the desk assigns
--   assigned / in_repair                  the engineer
--   repaired / service_denied             the desk dispatches
--   not_repairable      a manager approves; then the desk
--   in_transit_return   the field engineer; or whoever it is being handed to
--   received_back       the field engineer closes it
--   components          requested/bought: desk; forwarded: Purchase;
--                       accepted: desk (local) or Purchase; sent: the engineer
--   stock taken         the desk approves
-- "The desk" is a coordinator of that Revive Lab (an admin's queue is the
-- coordinator's, rl_0036). Observers are never waited on.
-- =====================================================================

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

revoke execute on function revive_waiting_now() from public, anon, authenticated;
grant execute on function revive_waiting_now() to service_role;
