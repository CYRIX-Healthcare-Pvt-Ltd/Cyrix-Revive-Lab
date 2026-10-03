/*
  rl_0043 — each courier named one way.

  The courier was typed by hand, so one courier was several: "Trackon",
  "Track on" and "Trac on"; "Speed and Safe" and "Speed safe"; "dtdc" and
  "DTDC" (the user, 3 Oct: "standardise trackon in db also"). The app now
  offers a list (DTDC, Trackon, Speed and Safe, Professional Couriers,
  Porter, By hand, or Other typed), and the tickets already raised are
  put in its spelling, so the list shows them and the Track link knows
  them. Anything not on the list is left as it was. A silent fix: no
  history step, updated_at untouched.
*/
create or replace function pg_temp.courier_name(raw text) returns text language sql immutable as $$
  select case
    when raw is null then null
    when lower(regexp_replace(raw, '[^a-zA-Z]', '', 'g')) = 'dtdc' then 'DTDC'
    when lower(regexp_replace(raw, '[^a-zA-Z]', '', 'g')) ~ '^tra(c|ck)on$' then 'Trackon'
    when lower(regexp_replace(raw, '[^a-zA-Z]', '', 'g')) ~ '^speed(and)?safe$' then 'Speed and Safe'
    when lower(regexp_replace(raw, '[^a-zA-Z]', '', 'g')) like 'professional%' then 'Professional Couriers'
    when lower(regexp_replace(raw, '[^a-zA-Z]', '', 'g')) = 'porter' then 'Porter'
    when lower(regexp_replace(raw, '[^a-zA-Z]', '', 'g')) = 'byhand' then 'By hand'
    else raw end
$$;

update public.revive_tickets
   set in_courier = pg_temp.courier_name(in_courier)
 where in_courier is distinct from pg_temp.courier_name(in_courier);
update public.revive_tickets
   set out_courier = pg_temp.courier_name(out_courier)
 where out_courier is distinct from pg_temp.courier_name(out_courier);
