/*
  rl_0029 — a manager's view of their team's spares.

  The user, 23 Sep: "under his engineer put a ticket, so the manager can see,
  isn't it? So can this same ticket be viewed by this employee's manager's
  manager? … and a beautiful dashboard with everything explained and brief
  data."

  Seeing them already worked at any depth: revive_can_see lets everyone
  above the field engineer see the ticket (is_in_my_downline walks the whole
  reporting line). This adds two things:

  - A ticket transferred to a field engineer in another team (rl_0028) stays
    visible to the managers of whoever held it before. Visibility followed
    only the person holding it now, so the first team's managers lost it at
    the moment they would most want to follow it.
  - revive_my_team(): everyone under the caller, each with their manager,
    and which of those people each ticket belongs to. The My team page groups
    tickets by team at any level from that. A ticket belongs to the field
    engineer holding it or, after a transfer out of the team, to the last
    person in the team who held it.
*/

create or replace function public.revive_can_see(p_ticket_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
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
        -- The managers of anyone who held it before a transfer (rl_0029):
        -- following only the one holding it now lost it for the first team.
        or exists (
          select 1 from revive_handovers h
          where h.ticket_id = t.id and h.status = 'accepted' and is_in_my_downline(h.from_id))
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
$$;

/*
  The caller's team: everyone under them at any depth, as downline_of
  counts them (left the company or not, so a leaver's open ticket still has
  a team), and the tickets that belong to one of them.

  Names and designations of one's own people only. Nothing here is more than
  the caller may already see: the tickets are the ones revive_can_see gives
  them through their team.
*/
create or replace function public.revive_my_team()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with recursive down as (
    select e.id, 1 as depth
    from employees e
    where e.reporting_manager_id = current_employee_id()
    union all
    select e.id, d.depth + 1
    from employees e
    join down d on e.reporting_manager_id = d.id
    -- The same guard as downline_of: a manager set to one of their own
    -- reportees would otherwise run until the connection dies.
    where d.depth < 12
  ),
  people as (
    select distinct on (e.id) e.id, e.full_name, e.ecode, e.designation, e.reporting_manager_id, e.is_active
    from down d
    join employees e on e.id = d.id
  ),
  owned as (
    select t.id as ticket_id,
      coalesce(
        (select p.id from people p where p.id = t.stakeholder_id),
        (select h.from_id from revive_handovers h
          join people p on p.id = h.from_id
          where h.ticket_id = t.id and h.status = 'accepted'
          order by h.decided_at desc nulls last
          limit 1)
      ) as person_id
    from revive_tickets t
  )
  select jsonb_build_object(
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.full_name, 'ecode', p.ecode, 'designation', p.designation,
        'manager_id', p.reporting_manager_id, 'active', p.is_active)
        order by p.full_name)
      from people p), '[]'::jsonb),
    'tickets', coalesce((
      select jsonb_agg(jsonb_build_object('ticket_id', o.ticket_id, 'person_id', o.person_id))
      from owned o where o.person_id is not null), '[]'::jsonb)
  )
$$;

revoke all on function public.revive_can_see(uuid) from public, anon;
revoke all on function public.revive_my_team() from public, anon;
grant execute on function public.revive_my_team() to authenticated;
