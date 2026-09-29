/*
  rl_0035 — a manager may approve a not-repairable call they made themselves.

  rl_0034 kept the engineer who closed the repair from approving it, when
  that engineer is a manager too. The user, 29 Sep: "No joseph can self
  approve, bcz in future if only 1 manager in trc then what happens, so
  joseph can approve his rqst also". Any manager of the Revive Lab
  approves or sends it back, whoever closed the repair.
*/

create or replace function public.revive_approve_not_repairable(p_ticket_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t revive_tickets := revive_lock(p_ticket_id);
begin
  if not revive_manages_trc(t.trc_id) then
    raise exception 'Only a manager of this Revive Lab can approve it as not repairable';
  end if;
  if t.status <> 'not_repairable' or t.nr_approved_at is not null then
    raise exception 'It is not waiting for approval as not repairable';
  end if;
  update revive_tickets
     set nr_approved_at = now(), nr_approved_by = current_employee_id(), updated_at = now()
   where id = t.id;
  perform revive_step(t.id, t.status, t.status, t.trc_id, 'review', 'nr_approved', p_note);
end $fn$;

create or replace function public.revive_decline_not_repairable(p_ticket_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  t   revive_tickets := revive_lock(p_ticket_id);
  why text := btrim(coalesce(p_reason, ''));
begin
  if not revive_manages_trc(t.trc_id) then
    raise exception 'Only a manager of this Revive Lab can send it back to be repaired';
  end if;
  if t.status <> 'not_repairable' or t.nr_approved_at is not null then
    raise exception 'It is not waiting for approval as not repairable';
  end if;
  if length(why) < 5 then
    raise exception 'Say why it should be repaired — what to try';
  end if;
  update revive_tickets
     set status = 'in_repair', outcome = null, proposal = null,
         nr_approved_at = null, nr_approved_by = null, updated_at = now()
   where id = t.id;
  perform revive_step(t.id, 'in_repair', t.status, t.trc_id, 'status', 'nr_declined', left(why, 1000));
end $fn$;
