-- =====================================================================
-- rl_0010 — observations during a repair
-- =====================================================================
--
-- What the engineer finds while the spare is in repair — a burnt track, a
-- part that tested fine, a capacitor ordered — written down as they go, as
-- many times as there is something to say. Each one is a step in the
-- history, in order, with who wrote it and when.
--
-- The status stays In repair. An observation records the work; it does not
-- move the ticket, so it starts no clock, mails nobody, and the dashboard's
-- turnaround figures never see it.

alter table public.revive_ticket_events
  add column if not exists kind text not null default 'status';

alter table public.revive_ticket_events
  drop constraint if exists revive_ticket_events_kind_check;
alter table public.revive_ticket_events
  add constraint revive_ticket_events_kind_check check (kind in ('status', 'observation'));

comment on column public.revive_ticket_events.kind is
  'status: the ticket moved (or was given to another engineer). observation: the engineer wrote down what they found; the status did not change.';

/** Something the engineer found, while the spare is in repair. */
create or replace function public.revive_add_observation(p_ticket_id uuid, p_note text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
  n text := btrim(coalesce(p_note, ''));
begin
  if t.engineer_id is distinct from current_employee_id() then
    raise exception 'Only the engineer repairing it can add an observation';
  end if;
  if t.status <> 'in_repair' then
    raise exception 'Observations are added while it is in repair';
  end if;
  if length(n) < 3 then
    raise exception 'Write what was found';
  end if;
  if length(n) > 1000 then
    raise exception 'Keep an observation under 1000 characters';
  end if;
  insert into revive_ticket_events (ticket_id, status, from_status, trc_id, actor_id, note, kind)
  values (t.id, t.status, t.status, t.trc_id, current_employee_id(), n, 'observation');
  update revive_tickets set updated_at = now() where id = t.id;
end $fn$;

grant execute on function public.revive_add_observation(uuid, text) to authenticated;

/* The mail is for moves. An observation is not one. */
create or replace function public.revive_queue_mail()
returns trigger
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  hook text;
begin
  if new.kind = 'observation' then
    return new;
  end if;

  insert into revive_mail_outbox (event_id, ticket_id)
  values (new.id, new.ticket_id)
  on conflict (event_id) do nothing;

  /*
    Nudge the sender now, if the database can make a web request.

    pg_net is optional on purpose. Without it the note still waits in the
    outbox, and the app drains the outbox after every action and on every
    load — so nothing is lost, it is only later. With it, the note goes
    within seconds, whatever changed the status.
  */
  select value into hook from revive_settings where key = 'notify_url';
  if hook is not null and to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is not null then
    begin
      execute 'select net.http_post(url := $1, body := $2, headers := $3)'
      using hook, '{"drain": true}'::jsonb, '{"Content-Type": "application/json"}'::jsonb;
    exception when others then
      -- A web request that cannot be queued must never undo a status
      -- change. The outbox row above is the promise; this was a courtesy.
      null;
    end;
  end if;
  return new;
end $fn$;

/** One ticket's trail, oldest first: the moves and the observations between them. */
drop function if exists public.revive_ticket_trail(uuid);
create function public.revive_ticket_trail(p_ticket_id uuid)
returns table (
  id bigint, status text, from_status text, trc_id uuid, trc_name text,
  actor_name text, actor_ecode text, note text, at timestamptz,
  engineer_name text, engineer_ecode text, kind text
)
language sql stable security definer set search_path to 'public'
as $fn$
  select ev.id, ev.status, ev.from_status, ev.trc_id, trc.name,
         e.full_name, e.ecode, ev.note, ev.at,
         en.full_name, en.ecode, ev.kind
  from revive_ticket_events ev
  left join revive_trcs trc on trc.id = ev.trc_id
  left join employees e on e.id = ev.actor_id
  left join employees en on en.id = ev.engineer_id
  where ev.ticket_id = p_ticket_id
    and revive_can_see(p_ticket_id)
  order by ev.at, ev.id
$fn$;

grant execute on function public.revive_ticket_trail(uuid) to anon, authenticated, service_role;

/** Every move on the tickets this person can see — for the dashboard's turnaround. Observations are not moves. */
create or replace function public.revive_visible_events()
returns table (ticket_id uuid, status text, trc_id uuid, at timestamptz)
language sql stable security definer set search_path to 'public'
as $fn$
  select ev.ticket_id, ev.status, ev.trc_id, ev.at
  from revive_ticket_events ev
  where revive_can_see(ev.ticket_id)
    and ev.kind = 'status'
  order by ev.ticket_id, ev.at, ev.id
$fn$;
