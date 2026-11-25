/*
  rl_0073 — An admin edits every route card (the user, 25 Nov: "admin can edit every route card details"): Revive Lab
  admins and the SW admin, at any stage, including the field engineer it belongs to. Every change stays in the history.
*/
create or replace function public.revive_can_edit_card(t revive_tickets)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select revive_is_admin() or is_sw_admin()
      or (t.raised_by = current_employee_id()
     and case when t.raised_as = 'coordinator'
              then t.status not in ('in_transit_return', 'received_back', 'closed')
              else t.status in ('awaiting_approval', 'approved', 'not_approved', 'pending_acceptance') end)
$function$;

do $$
declare f text;
begin
  f := pg_get_functiondef('public.revive_edit_ticket(uuid,text,text,text,text,text,text,text,jsonb,text,text,text,uuid)'::regprocedure);
  if position($q$    if t.raised_as <> 'coordinator' and not exists ($q$ in f) = 0 then raise exception 'revive_edit_ticket changed'; end if;
  execute replace(f, $q$    if t.raised_as <> 'coordinator' and not exists ($q$,
    $q$    if t.raised_as <> 'coordinator' and not revive_is_admin() and not is_sw_admin() and not exists ($q$);
end $$;
