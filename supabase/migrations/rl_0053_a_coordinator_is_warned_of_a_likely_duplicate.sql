-- =====================================================================
-- Revive Lab  ·  rl_0053  ·  A coordinator is told when the ticket looks already raised
--
-- The user, 19 Oct: "an eng raises a ticket from hospital A and equipment B,
-- so the coordinator also by mistake creates same combination, so
-- duplication is happening, so an alert pop up needed (only for
-- coordinator) that in revive lab already have this facility and this
-- spare / equipment ticket, then ticket id and raised by, then cancel or
-- continue."
--
-- Before a coordinator's raise, the open tickets — anything not yet closed —
-- at the same hospital with the same equipment (its barcode, or its name)
-- or one of the same spares. Names are compared without case or extra
-- spaces, a barcode without spaces. Only for a coordinator or an admin:
-- everybody else gets nothing, and the screen asks only for them anyway.
-- It warns and never refuses: the coordinator may go on.
-- =====================================================================

create or replace function public.revive_similar_tickets(
  p_hospital text, p_equipment_name text, p_equipment_barcode text, p_spares text[]
)
returns table (
  id uuid, code text, status text, raised_by_name text, holder_name text, lab_name text,
  raised_at timestamptz, facility text, equipment_name text, spare_name text, matched text
)
language sql stable security definer set search_path to 'public'
as $fn$
  with me as (
    select revive_is_admin() or exists (
      select 1 from revive_members m where m.employee_id = current_employee_id() and m.is_coordinator) as ok
  ),
  n as (
    select lower(regexp_replace(trim(coalesce(p_hospital, '')), '\s+', ' ', 'g')) as h,
           lower(regexp_replace(trim(coalesce(p_equipment_name, '')), '\s+', ' ', 'g')) as e,
           upper(regexp_replace(coalesce(p_equipment_barcode, ''), '\s+', '', 'g')) as b,
           array(select lower(regexp_replace(trim(x), '\s+', ' ', 'g')) from unnest(coalesce(p_spares, '{}'::text[])) x where trim(x) <> '') as s
  ),
  t as (
    select t.*,
      lower(regexp_replace(trim(coalesce(t.equipment_name, '')), '\s+', ' ', 'g')) as te,
      upper(regexp_replace(coalesce(t.equipment_barcode, ''), '\s+', '', 'g')) as tb,
      array(select lower(regexp_replace(trim(coalesce(i->>'name', '')), '\s+', ' ', 'g')) from jsonb_array_elements(coalesce(t.items, '[]'::jsonb)) i)
        || lower(regexp_replace(trim(coalesce(t.spare_name, '')), '\s+', ' ', 'g')) as ts
    from revive_tickets t, n
    where t.status::text <> 'closed'
      and lower(regexp_replace(trim(coalesce(t.facility, '')), '\s+', ' ', 'g')) = n.h
  )
  select t.id, t.code, t.status::text, r.full_name, h.full_name, l.name, t.created_at, t.facility, t.equipment_name, t.spare_name,
    case when n.b <> '' and t.tb = n.b then 'barcode' when n.e <> '' and t.te = n.e then 'equipment' else 'spare' end
  from t cross join n cross join me
  left join employees r on r.id = t.raised_by
  left join employees h on h.id = t.stakeholder_id
  left join revive_trcs l on l.id = t.trc_id
  where me.ok and n.h <> ''
    and ((n.b <> '' and t.tb = n.b) or (n.e <> '' and t.te = n.e) or t.ts && n.s)
  order by t.created_at desc
  limit 5
$fn$;

revoke execute on function public.revive_similar_tickets(text, text, text, text[]) from public, anon;
grant execute on function public.revive_similar_tickets(text, text, text, text[]) to authenticated;
