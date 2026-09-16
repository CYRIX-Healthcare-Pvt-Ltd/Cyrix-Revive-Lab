-- =====================================================================
-- Revive Lab  ·  rl_0002  ·  On the platform
--
-- One row in app_modules, the list the portal's tiles and SW admin's
-- Modules column are both built from. Nothing else on the platform is
-- touched: who can open the module is employee_modules, the same table
-- every other module uses, granted from SW admin or — for somebody given
-- a Revive Lab box — by revive_save_member.
--
-- Applied separately from rl_0001 and only when the app is live at
-- /revive, because this is the one change people can see: the moment it
-- exists, SW admin can hand the module out, and a tile that leads to a
-- 404 is worse than no tile.
-- =====================================================================

insert into public.app_modules (code, name, description, path, icon, sort_order, is_active)
values (
  'revive',
  'Revive Lab',
  'Send a defective spare in for repair and follow it back out.',
  '/revive',
  'Wrench',
  50,
  true
)
on conflict (code) do update
set name = excluded.name,
    description = excluded.description,
    path = excluded.path,
    icon = excluded.icon,
    sort_order = excluded.sort_order,
    is_active = excluded.is_active;
