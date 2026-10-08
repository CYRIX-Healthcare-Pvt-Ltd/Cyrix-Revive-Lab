-- =====================================================================
-- Revive Lab · rl_0050 · Who sees the Live floor
--
-- The user, 9 Oct: "add option in sw_admin, ie animation enable disable for
-- roles ie trc eng, manager admin etc, check box". One setting, the roles
-- that get the dashboard's Overview / Live floor switch; the software
-- administrator always has it. Not set means every Revive Lab role, as on
-- the day it went live.
-- =====================================================================

create or replace function public.revive_set_live_floor_roles(p_roles text[])
returns void
language plpgsql security definer set search_path to 'public' as $f$
declare
  allowed constant text[] := array['engineer', 'coordinator', 'manager', 'admin', 'purchase', 'observer'];
  r text;
begin
  if not is_sw_admin() then
    raise exception 'Only the software administrator decides who sees the Live floor';
  end if;
  foreach r in array coalesce(p_roles, '{}') loop
    if not r = any (allowed) then raise exception 'Unknown role "%"', r; end if;
  end loop;
  insert into app_settings (key, value, description, updated_at)
  values ('revive_live_floor_roles', to_jsonb(coalesce(p_roles, '{}')),
          'Revive Lab roles that see the dashboard''s Live floor (rl_0050); the software administrator always does', now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $f$;

revoke all on function public.revive_set_live_floor_roles(text[]) from public, anon;
grant execute on function public.revive_set_live_floor_roles(text[]) to authenticated;

notify pgrst, 'reload schema';
