/*
  rl_0026 — no history step for the category every open ticket was given.

  rl_0024 set Category A · Non-critical on the tickets already open and
  said so in each one's history. The user, 23 Sep: "Dont need this history
  in any ticket which we added now." The values stay — the coordinator
  changes them where they are not right — and only those steps go.

  They are the only steps with no one behind them and that note; a
  coordinator's change always has an actor and says what it was before.
  None was mailed (only status steps are), so nothing waits in the outbox.
*/

delete from public.revive_ticket_events
 where kind = 'classify'
   and actor_id is null
   and note = 'Category A · Non-critical — set for every ticket already open; the coordinator changes it where it is not right';
