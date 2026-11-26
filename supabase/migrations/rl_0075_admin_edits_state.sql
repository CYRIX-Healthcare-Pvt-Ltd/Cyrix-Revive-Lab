/*
  rl_0075 — An admin changes a route card's state (the user, 25 Nov: "state also need to be edited"). The BEMMP
  follows the state when one runs there; the change is in the history. The district is then saved by the card edit.
*/
create or replace function public.revive_edit_state(p_ticket_id uuid, p_state text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  t  revive_tickets := revive_lock(p_ticket_id);
  s  text := nullif(btrim(coalesce(p_state, '')), '');
  b  revive_bemmp_projects;
begin
  if t.id is null then raise exception 'That ticket does not exist'; end if;
  if not (revive_is_admin() or is_sw_admin()) then raise exception 'Only an admin can change the state'; end if;
  if t.source = 'warehouse' then raise exception 'A warehouse spare has no state to change'; end if;
  if s is null or length(s) > 80 then raise exception 'Choose the state'; end if;
  if s is not distinct from t.state then return; end if;
  select * into b from revive_bemmp_projects where state = s and is_active order by sort_order limit 1;
  update revive_tickets set state = s, bemmp_id = coalesce(b.id, bemmp_id), updated_at = now() where id = t.id;
  insert into revive_ticket_events (ticket_id, status, from_status, trc_id, actor_id, note, kind)
  values (t.id, t.status, t.status, t.trc_id, current_employee_id(),
    format('State: %s → %s', coalesce(t.state, '—'), s) || case when b.id is not null then ' · BEMMP ' || b.code else '' end, 'edit');
end $function$;
revoke all on function public.revive_edit_state(uuid, text) from public, anon;
grant execute on function public.revive_edit_state(uuid, text) to authenticated;
