/*
  rl_0074 — The Revive Lab accepts an approved ticket that reached it without the field engineer's Send (the user,
  25 Nov, RL-935: Cochin's coordinator has it, "coord need accept option also that will skip engineer"). The
  approval is marked sent, the history says it arrived without being sent, and no courier is asked.
*/
do $$
declare f text;
begin
  f := pg_get_functiondef('public.revive_accept(uuid,text,boolean,text[],text,text,date,text,text)'::regprocedure);
  if position($q$  if t.status not in ('pending_acceptance', 'transferred') then
    raise exception 'This ticket is not waiting to be accepted';
  end if;$q$ in f) = 0 or position($q$  if t.status = 'pending_acceptance' then
    if c is null$q$ in f) = 0 then raise exception 'revive_accept changed'; end if;
  f := replace(f, $q$  if t.status not in ('pending_acceptance', 'transferred') then
    raise exception 'This ticket is not waiting to be accepted';
  end if;$q$, $q$  -- Approved for this lab and already here, not sent (rl_0074).
  if t.status = 'approved' then
    if not exists (select 1 from revive_approvals a where a.ticket_id = t.id and a.status = 'approved' and a.kind = 'raise') then
      raise exception 'This ticket is not waiting to be accepted';
    end if;
    update revive_approvals set status = 'sent', updated_at = now() where ticket_id = t.id and status = 'approved';
    perform revive_step(t.id, 'pending_acceptance', 'approved', t.trc_id, 'status', 'sent',
      'Reached the Revive Lab without being sent');
    t.status := 'arrived';
  elsif t.status not in ('pending_acceptance', 'transferred') then
    raise exception 'This ticket is not waiting to be accepted';
  end if;$q$);
  execute f;
end $$;
