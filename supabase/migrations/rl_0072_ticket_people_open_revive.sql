/*
  rl_0072 — Revive Lab opens for everyone a ticket belongs to (the user, 24 Nov: E773 Arjun Kumar R could not see
  RL-702, RL-679 and RL-842, raised for him by his coordinator; "ok give"). The stakeholder, whoever raised it and the
  engineer repairing it get in without being ticked, and see what revive_visible_ids already lets them see: their own
  tickets. The stakeholder is the one who marks a returned part received and closes the ticket, so 25 people with 112
  open tickets could not finish them.
*/
create or replace function public.revive_has_access()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select is_sw_admin()
      or exists (select 1 from revive_members m where m.employee_id = current_employee_id())
      -- A BEMMP's project head (rl_0047).
      or exists (select 1 from revive_bemmp_projects b where b.head_id = current_employee_id())
      or exists (select 1 from employee_modules em
                 where em.employee_id = current_employee_id() and em.module_code = 'revive')
      -- Someone a ticket belongs to (rl_0072).
      or exists (select 1 from revive_tickets t
                 where t.stakeholder_id = current_employee_id() or t.raised_by = current_employee_id() or t.engineer_id = current_employee_id())
$function$;
