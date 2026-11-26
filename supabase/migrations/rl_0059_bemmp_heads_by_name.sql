/*
  rl_0059 — a BEMMP's project head by name, for everyone in Revive Lab (the user, 28 Oct, as E1337 on People &
  Revive Labs → BEMMP: "why project manager list not there").

  The app read the head's name by joining employees, and the employee list shows a person only their own people.
  Saranya K S (E1337), a Revive Lab admin, sees 22 people and none of the four heads, so no "Head: …" showed on any
  BEMMP, and the route card said "The project head approves it" without a name. The heads were set all along.

  revive_bemmp_heads() gives each BEMMP's head (name and E-code) to anyone Revive Lab has been given to.
*/

create or replace function revive_bemmp_heads()
returns table (bemmp_id uuid, head_id uuid, full_name text, ecode text)
language sql stable security definer set search_path = public as $$
  select b.id, e.id, e.full_name, e.ecode
  from revive_bemmp_projects b
  join employees e on e.id = b.head_id
  where revive_has_access()
$$;

revoke all on function revive_bemmp_heads() from public, anon;
grant execute on function revive_bemmp_heads() to authenticated, service_role;
