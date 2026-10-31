-- =====================================================================
-- Revive Lab · rl_0065 · A local purchase can still go to Purchase
--
-- The user, 31 Oct 2026 (RL-244): "sometimes coordinators will purchase
-- locally, and sometimes coordinator need to pass to purchase again. so
-- still need option to pass to purchase." Purchase could already hand a
-- request to a local purchase (revive_make_local, from forwarded); the
-- coordinator now has the way back while purchasing locally, until the bill
-- is attached. The local purchase's taker and status are cleared: Purchase
-- starts it afresh.
-- =====================================================================

create or replace function public.revive_forward_part(p_request_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare
  r revive_part_requests := revive_lock_part(p_request_id);
begin
  if not revive_runs_trc(r.trc_id) then
    raise exception 'Only the Revive Lab''s coordinator passes a request to Purchase';
  end if;
  if not (r.status = 'requested' or (r.status = 'accepted' and r.route = 'local')) then
    raise exception 'This request is not with you';
  end if;
  if not exists (
    select 1 from revive_members m join revive_member_trcs mt on mt.employee_id = m.employee_id
    where m.is_purchase and mt.trc_id = r.trc_id) then
    raise exception 'Nobody holds Purchase for this Revive Lab yet — ask an admin, or purchase it locally';
  end if;

  update revive_part_requests
     set route = 'purchase', status = 'forwarded',
         accepted_by = null, accepted_at = null,
         progress = null, progress_by = null, progress_at = null,
         updated_at = now()
   where id = r.id;
  perform revive_part_step(r, 'forwarded',
    concat_ws(' · ', revive_part_label(r) || ' — passed to Purchase', nullif(btrim(coalesce(p_note, '')), '')),
    nullif(btrim(coalesce(p_note, '')), ''));
end $function$;

revoke all on function public.revive_forward_part(uuid, text) from public, anon;
grant execute on function public.revive_forward_part(uuid, text) to authenticated;
