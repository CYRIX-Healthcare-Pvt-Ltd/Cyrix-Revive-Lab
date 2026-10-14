-- Purchase sees a component request only once the coordinator has passed it to them (the purchase
-- team, 14 Oct). An engineer choosing "Purchase" leaves the request with the coordinator ("requested")
-- until it is forwarded; till then Purchase cannot read it, nor the ticket through it. A request
-- Purchase declined stays theirs to see; one the coordinator declined never reached them.
create or replace function public.revive_passed_to_purchase(p_route text, p_status text, p_declined_by uuid, p_trc_id uuid)
returns boolean language sql stable security definer set search_path to 'public' as $f$
  select p_route = 'purchase' and (
    p_status in ('forwarded', 'accepted', 'bought', 'sent', 'received', 'stocked')
    or (p_status = 'declined' and exists (
      select 1 from revive_members m join revive_member_trcs mt on mt.employee_id = m.employee_id
      where m.employee_id = p_declined_by and m.is_purchase and mt.trc_id = p_trc_id)))
$f$;

CREATE OR REPLACE FUNCTION public.revive_can_see(p_ticket_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        -- The project head asked to approve it going to another state (rl_0047).
        or exists (select 1 from revive_approvals a where a.ticket_id = t.id and a.head_id = current_employee_id())
        -- Every Revive Lab admin, and the software administrator.
        or revive_is_admin()
        -- A Regional Revive Lab's manager sees every Revive Lab's work.
        or exists (
          select 1 from revive_members m
          join revive_member_trcs mt on mt.employee_id = m.employee_id
          join revive_trcs l on l.id = mt.trc_id
          where m.employee_id = current_employee_id() and m.is_manager and l.state is null)
        -- The desk of the Revive Lab that has it, or that sent it on — its manager and its observers too (rl_0039).
        or exists (
          select 1 from revive_members m
          join revive_member_trcs mt on mt.employee_id = m.employee_id
          where m.employee_id = current_employee_id()
            and (m.is_coordinator or m.is_manager or m.is_observer)
            and (mt.trc_id = t.trc_id
                 or mt.trc_id in (select x.from_trc_id from revive_transfers x where x.ticket_id = t.id)))
        -- Purchase, where a purchase request brought it to them.
        or exists (
          select 1 from revive_part_requests r
          join revive_member_trcs mt on mt.trc_id = r.trc_id
          join revive_members m on m.employee_id = mt.employee_id
          where r.ticket_id = t.id and revive_passed_to_purchase(r.route, r.status, r.declined_by, r.trc_id)
            and m.employee_id = current_employee_id() and m.is_purchase)
        -- The field engineer asked to take it over, while they decide (rl_0028).
        or exists (
          select 1 from revive_handovers h
          where h.ticket_id = t.id and h.status = 'pending' and h.to_id = current_employee_id())
      )
  )
$function$;


CREATE OR REPLACE FUNCTION public.revive_can_see_part(p_request_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from revive_part_requests r
     where r.id = p_request_id
       and case when r.ticket_id is not null then revive_can_see(r.ticket_id)
                else r.requested_by = current_employee_id()
                  or revive_runs_trc(r.trc_id)
                  or revive_manages_trc(r.trc_id)
                  or (revive_passed_to_purchase(r.route, r.status, r.declined_by, r.trc_id) and revive_buys_for(r.trc_id))
           end)
$function$;

