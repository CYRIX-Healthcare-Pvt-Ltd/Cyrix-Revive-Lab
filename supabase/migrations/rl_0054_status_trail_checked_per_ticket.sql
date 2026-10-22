-- Revive Lab · rl_0054 · the status trail checked once per ticket
-- The user, 22 Oct: the dashboard's Average TAT read "under a minute", then "—". revive_visible_events asked
-- revive_can_see for every one of 2,929 status rows and ran past the 8-second statement timeout, so the dashboard
-- had no trail at all. Visibility is now asked once per ticket (437), and the rows are joined to that set.
create or replace function public.revive_visible_events()
 returns table(ticket_id uuid, status text, trc_id uuid, at timestamp with time zone)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with seen as materialized (
    select t.id from revive_tickets t where revive_can_see(t.id)
  )
  select ev.ticket_id, ev.status, ev.trc_id, ev.at
  from revive_ticket_events ev
  join seen on seen.id = ev.ticket_id
  where ev.kind = 'status'
  order by ev.ticket_id, ev.at, ev.id
$function$;
