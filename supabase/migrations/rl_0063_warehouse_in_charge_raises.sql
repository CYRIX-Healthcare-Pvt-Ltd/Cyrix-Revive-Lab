/*
  rl_0063 — a warehouse in-charge raises their own warehouse's spares (the user, 30 Oct: "build warehouse in-charge
  role ... same like field engineer, first their respective revive lab + cochin, then to send to another revive lab
  we need button like in eng"), on the card their Excel already has: Document Number, Item Code, Description,
  Quantity, Barcode, Complaint.

  - People & Revive Labs has a Warehouse in-charge role with the warehouse(s) they raise for (revive_members.
    is_warehouse, warehouse_ids). Their card offers only those; one alone is filled in and fixed, with its state
    (the user: "if only 1 wh mapped for a user then it automatically fills and no edit option").
  - The state's Revive Labs and the Regional ones are a choice; another
    state's is asked for with a reason and the Regional Revive Lab admins approve it (a warehouse has no BEMMP, so
    no project head). It waits at the Revive Lab as Pending acceptance, like a field engineer's.
  - The document number sits in the ticket ID's place (source_ticket_no); the item code is new
    (revive_tickets.item_code). Quantity is not stored: the app raises one ticket a unit, each with its barcode.
  - The coordinator's warehouse card (rl_0020, rl_0061) is unchanged but for the same two fields.
  - A warehouse's return address is saved on it from the card (Save address), and fills the next card.
  - A warehouse's tickets are numbered on their own, WRL-01 on (the user, 30 Oct: "new ticketing series for wh
    rqsts"): revive_tickets.series, its own sequence, the code as series-number. Those raised before keep their RL.
*/
alter table public.revive_members
  add column if not exists is_warehouse boolean not null default false,
  add column if not exists warehouse_ids uuid[] not null default '{}';
alter table public.revive_tickets add column if not exists item_code text;

-- A warehouse sends its spares back to one address: saved from the card, it is there on the next (the user, 30 Oct:
-- "wh always has same return address so we can add save address checkbox").
alter table public.revive_warehouses add column if not exists return_address text
  constraint revive_warehouses_return_address_check check (return_address is null or length(return_address) <= 500);

create or replace function public.revive_save_warehouse_address(p_warehouse_id uuid, p_address text)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare
  me   uuid := current_employee_id();
  addr text := nullif(btrim(coalesce(p_address, '')), '');
begin
  if not (revive_is_admin() or exists (select 1 from revive_members m where m.employee_id = me
            and (m.is_coordinator or (m.is_warehouse and p_warehouse_id = any(m.warehouse_ids))))) then
    raise exception 'Only the warehouse''s in-charge or a Revive Lab coordinator saves its address';
  end if;
  if length(addr) < 5 then raise exception 'Enter the spare return address'; end if;
  if length(addr) > 500 then raise exception 'Keep the address under 500 characters'; end if;
  update revive_warehouses set return_address = addr where id = p_warehouse_id;
  if not found then raise exception 'That warehouse does not exist'; end if;
end $function$;
revoke all on function public.revive_save_warehouse_address(uuid, text) from public, anon;
grant execute on function public.revive_save_warehouse_address(uuid, text) to authenticated, service_role;

create sequence if not exists public.revive_wh_ticket_number;
alter table public.revive_tickets add column series text not null default 'RL'
  constraint revive_tickets_series_check check (series in ('RL', 'WRL'));
alter table public.revive_tickets drop constraint revive_tickets_number_key;
alter table public.revive_tickets add constraint revive_tickets_number_key unique (series, number);
alter table public.revive_tickets alter column code set expression as
  ((series || '-' || case when number < 10 then '0' else '' end) || number::text);

drop function if exists public.revive_me();
CREATE OR REPLACE FUNCTION public.revive_me()
 RETURNS TABLE(employee_id uuid, is_engineer boolean, is_coordinator boolean, is_manager boolean, is_admin boolean, is_sw_admin boolean, trc_ids uuid[], is_purchase boolean, approves boolean, is_observer boolean, may_raise boolean, is_warehouse boolean, warehouse_ids uuid[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    e.id,
    coalesce(m.is_engineer, false),
    coalesce(m.is_coordinator, false),
    coalesce(m.is_manager, false),
    coalesce(m.is_admin, false) or is_sw_admin(),
    is_sw_admin(),
    coalesce((select array_agg(mt.trc_id) from revive_member_trcs mt
              where mt.employee_id = e.id), '{}'),
    coalesce(m.is_purchase, false),
    revive_approves(),
    coalesce(m.is_observer, false),
    coalesce(m.may_raise, false),
    coalesce(m.is_warehouse, false),
    case when m.is_warehouse then m.warehouse_ids else '{}'::uuid[] end
  from employees e
  left join revive_members m on m.employee_id = e.id
  where e.id = current_employee_id()
$function$;
revoke all on function public.revive_me() from public, anon;
grant execute on function public.revive_me() to authenticated, service_role;

drop function if exists public.revive_member_list();
CREATE OR REPLACE FUNCTION public.revive_member_list()
 RETURNS TABLE(employee_id uuid, ecode text, full_name text, designation text, is_engineer boolean, is_coordinator boolean, is_manager boolean, is_admin boolean, trc_ids uuid[], updated_at timestamp with time zone, updated_by_name text, is_purchase boolean, is_observer boolean, may_raise boolean, is_warehouse boolean, warehouse_ids uuid[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select m.employee_id, e.ecode, e.full_name, e.designation,
         m.is_engineer, m.is_coordinator, m.is_manager, m.is_admin,
         coalesce((select array_agg(mt.trc_id order by mt.trc_id) from revive_member_trcs mt
                   where mt.employee_id = m.employee_id), '{}'),
         m.updated_at, u.full_name, m.is_purchase, m.is_observer, m.may_raise, m.is_warehouse, m.warehouse_ids
  from revive_members m
  join employees e on e.id = m.employee_id
  left join employees u on u.id = m.updated_by
  where revive_has_access()
  order by e.full_name
$function$;
revoke all on function public.revive_member_list() from public, anon;
grant execute on function public.revive_member_list() to authenticated, service_role;

drop function if exists public.revive_save_member(uuid,boolean,boolean,boolean,boolean,uuid[],boolean,boolean,boolean);
CREATE OR REPLACE FUNCTION public.revive_save_member(p_employee_id uuid, p_engineer boolean, p_coordinator boolean, p_manager boolean, p_admin boolean, p_trc_ids uuid[], p_purchase boolean DEFAULT NULL::boolean, p_observer boolean DEFAULT NULL::boolean, p_may_raise boolean DEFAULT NULL::boolean, p_warehouse boolean DEFAULT NULL::boolean, p_warehouse_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me       uuid := current_employee_id();
  purchase boolean := coalesce(p_purchase,
                        (select m.is_purchase from revive_members m where m.employee_id = p_employee_id),
                        false);
  -- Left out by a page from before rl_0039: what they had stays.
  observer boolean := coalesce(p_observer,
                        (select m.is_observer from revive_members m where m.employee_id = p_employee_id),
                        false);
  -- Only an observer's to have: unticked with the Observer box.
  raises   boolean := observer and coalesce(p_may_raise,
                        (select m.may_raise from revive_members m where m.employee_id = p_employee_id),
                        false);
  -- Left out by a page from before rl_0063: what they had stays.
  wh       boolean := coalesce(p_warehouse, (select m.is_warehouse from revive_members m where m.employee_id = p_employee_id), false);
  -- The warehouses they raise for: their card offers only these, and one alone is filled in (the user, 30 Oct).
  wh_ids   uuid[] := case when wh then coalesce(p_warehouse_ids, (select m.warehouse_ids from revive_members m where m.employee_id = p_employee_id), '{}') else '{}' end;
begin
  if not revive_is_admin() then
    raise exception 'Only a Revive Lab admin can change who does what';
  end if;
  if not exists (select 1 from employees where id = p_employee_id) then
    raise exception 'That employee does not exist';
  end if;
  if p_employee_id = me and not is_sw_admin() and not coalesce(p_admin, false) then
    raise exception 'You cannot remove your own admin box — ask another admin';
  end if;
  if exists (select 1 from unnest(coalesce(p_trc_ids, '{}')) x
             where x not in (select id from revive_trcs)) then
    raise exception 'One of those Revive Labs does not exist';
  end if;

  if wh and cardinality(wh_ids) = 0 then
    raise exception 'Tick the warehouse(s) this in-charge raises tickets for';
  end if;
  if exists (select 1 from unnest(wh_ids) x where x not in (select id from revive_warehouses)) then
    raise exception 'One of those warehouses does not exist';
  end if;

  if not (p_engineer or p_coordinator or p_manager or p_admin or purchase or observer or wh)
     and coalesce(array_length(p_trc_ids, 1), 0) = 0 then
    delete from revive_members where employee_id = p_employee_id;
    perform log_audit('revive_member', p_employee_id, 'removed', '{}'::jsonb);
    return;
  end if;

  insert into revive_members (employee_id, is_engineer, is_coordinator, is_manager, is_admin, is_purchase, is_observer, may_raise, is_warehouse, warehouse_ids, updated_at, updated_by)
  values (p_employee_id, p_engineer, p_coordinator, p_manager, p_admin, purchase, observer, raises, wh, wh_ids, now(), me)
  on conflict (employee_id) do update
  set is_engineer = excluded.is_engineer,
      is_coordinator = excluded.is_coordinator,
      is_manager = excluded.is_manager,
      is_admin = excluded.is_admin,
      is_purchase = excluded.is_purchase,
      is_observer = excluded.is_observer,
      may_raise = excluded.may_raise,
      is_warehouse = excluded.is_warehouse,
      warehouse_ids = excluded.warehouse_ids,
      updated_at = now(),
      updated_by = me;

  delete from revive_member_trcs
  where employee_id = p_employee_id
    and trc_id <> all (coalesce(p_trc_ids, '{}'));
  insert into revive_member_trcs (employee_id, trc_id)
  select p_employee_id, x from unnest(coalesce(p_trc_ids, '{}')) x
  on conflict do nothing;

  if exists (select 1 from app_modules where code = 'revive') then
    insert into employee_modules (employee_id, module_code, granted_by)
    values (p_employee_id, 'revive', me)
    on conflict do nothing;
  end if;

  perform log_audit('revive_member', p_employee_id, 'saved', jsonb_build_object(
    'engineer', p_engineer, 'coordinator', p_coordinator, 'manager', p_manager,
    'admin', p_admin, 'purchase', purchase, 'observer', observer, 'may_raise', raises, 'warehouse', wh, 'warehouses', to_jsonb(wh_ids), 'trcs', to_jsonb(coalesce(p_trc_ids, '{}'))));
end $function$;
revoke all on function public.revive_save_member(uuid,boolean,boolean,boolean,boolean,uuid[],boolean,boolean,boolean,boolean,uuid[]) from public, anon;
grant execute on function public.revive_save_member(uuid,boolean,boolean,boolean,boolean,uuid[],boolean,boolean,boolean,boolean,uuid[]) to authenticated, service_role;

drop function if exists public.revive_ticket_list();
CREATE OR REPLACE FUNCTION public.revive_ticket_list()
 RETURNS TABLE(id uuid, number integer, code text, status text, trc_kind text, trc_id uuid, trc_name text, source_ticket_no text, facility text, district text, state text, bemmp_id uuid, bemmp_code text, billing_spare boolean, equipment_name text, equipment_barcode text, spare_name text, items jsonb, issue text, return_address text, contact_number text, in_courier text, in_awb text, in_dispatched_on date, stakeholder_id uuid, stakeholder_name text, stakeholder_ecode text, stakeholder_function text, stakeholder_manager_name text, raised_by uuid, raised_by_name text, raised_by_function text, raised_as text, engineer_id uuid, engineer_name text, engineer_ecode text, out_courier text, out_awb text, out_dispatched_on date, created_at timestamp with time zone, updated_at timestamp with time zone, closed_at timestamp with time zone, outcome text, closure text, scrapped_at timestamp with time zone, scrapped_by_name text, expected_by date, parts jsonb, proposal text, trc_state text, approval jsonb, arrival_damaged boolean, arrival_photos text[], done_photos text[], done_video text, return_damaged boolean, return_photos text[], final_working boolean, received_at timestamp with time zone, stock jsonb, equipment_make text, equipment_model text, done_voice text, source text, warehouse_id uuid, spare_category text, criticality text, contract_type text, accepted_at timestamp with time zone, dispatched_at timestamp with time zone, billing_estimate numeric, asks_billing_estimate boolean, field_returns jsonb, handover jsonb, repaired_at timestamp with time zone, oem_address text, nr_approved_at timestamp with time zone, nr_approved_by_name text, item_code text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select t.id, t.number, t.code, t.status,
         t.trc_kind, t.trc_id, trc.name,
         t.source_ticket_no, t.facility, t.district, t.state,
         t.bemmp_id, bp.code, t.billing_spare,
         t.equipment_name, t.equipment_barcode, t.spare_name, t.items,
         t.issue, t.return_address, t.contact_number,
         t.in_courier, t.in_awb, t.in_dispatched_on,
         t.stakeholder_id, sh.full_name, sh.ecode,
         sh.function_name,
         shm.full_name,
         t.raised_by, rb.full_name, rb.function_name, t.raised_as,
         t.engineer_id, en.full_name, en.ecode,
         t.out_courier, t.out_awb, t.out_dispatched_on,
         t.created_at, t.updated_at, t.closed_at,
         t.outcome, t.closure, t.scrapped_at, sc.full_name,
         t.expected_by,
         coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'route', r.route, 'status', r.status)
                                    order by r.requested_at)
                   from revive_part_requests r where r.ticket_id = t.id), '[]'::jsonb),
         t.proposal,
         trc.state,
         -- The latest approval asked for on this ticket, whatever became of it.
         (select jsonb_build_object(
                   'id', a.id, 'kind', a.kind, 'status', a.status,
                   'from_trc_id', a.from_trc_id, 'from_trc_name', f.name,
                   'asked_trc_id', a.asked_trc_id, 'asked_trc_name', ak.name,
                   'to_trc_id', a.to_trc_id, 'to_trc_name', d.name, 'to_trc_state', d.state,
                   'reason', a.reason, 'back_to', a.back_to,
                   'requested_by_name', rq.full_name, 'requested_at', a.requested_at,
                   'decided_by_name', dc.full_name, 'decided_at', a.decided_at,
                   'decision_note', a.decision_note,
                   -- The project head, first, for another state's Revive Lab (rl_0047).
                   'head_id', a.head_id, 'head_name', hd.full_name,
                   'head_decided_at', a.head_decided_at, 'head_note', a.head_note)
            from revive_approvals a
            left join revive_trcs f on f.id = a.from_trc_id
            join revive_trcs ak on ak.id = a.asked_trc_id
            join revive_trcs d on d.id = a.to_trc_id
            join employees rq on rq.id = a.requested_by
            left join employees dc on dc.id = a.decided_by
            left join employees hd on hd.id = a.head_id
           where a.ticket_id = t.id
           order by a.requested_at desc
           limit 1),
         t.arrival_damaged, t.arrival_photos, t.done_photos, t.done_video,
         t.return_damaged, t.return_photos, t.final_working, t.received_at,
         -- What the engineer has taken from stock, and where each stands (rl_0016).
         coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'status', u.status) order by u.requested_at)
                   from revive_stock_uses u where u.ticket_id = t.id), '[]'::jsonb),
         t.equipment_make, t.equipment_model, t.done_voice,
         t.source, t.warehouse_id,
         t.spare_category, t.criticality, t.contract_type, t.accepted_at,
         -- The first dispatch back since it was accepted — this round's, once
         -- the field has sent it back (rl_0027).
         (select min(ev.at) from revive_ticket_events ev
           where ev.ticket_id = t.id and ev.kind = 'status' and ev.status = 'in_transit_return'
             and (t.accepted_at is null or ev.at >= t.accepted_at)),
         t.billing_estimate,
         coalesce(bp.asks_billing, false),
         t.field_returns,
         -- Its latest transfer to another field engineer, whatever became of it (rl_0028).
         (select jsonb_build_object(
                   'id', h.id, 'status', h.status,
                   'from_id', h.from_id, 'from_name', fe.full_name, 'from_ecode', fe.ecode,
                   'to_id', h.to_id, 'to_name', te.full_name, 'to_ecode', te.ecode,
                   'phone', h.phone, 'requested_at', h.requested_at, 'decided_at', h.decided_at)
            from revive_handovers h
            join employees fe on fe.id = h.from_id
            join employees te on te.id = h.to_id
           where h.ticket_id = t.id
           order by h.requested_at desc, (h.status = 'pending') desc, (h.status = 'accepted') desc
           limit 1),
         -- The end of the category TAT (rl_0030): this round's close of the
         -- repair, once it has left repair — a spare sent on to another
         -- Revive Lab after "not repairable" is being repaired again.
         case when t.status in ('repaired', 'not_repairable', 'service_denied', 'in_transit_return', 'received_back', 'closed')
              then (select max(ev.at) from revive_ticket_events ev
                     where ev.ticket_id = t.id and ev.kind = 'status'
                       and ev.status in ('repaired', 'not_repairable', 'service_denied')
                       and (t.accepted_at is null or ev.at >= t.accepted_at))
         end,
         -- Where it went, when it went to the OEM (rl_0033).
         t.oem_address,
         -- Not repairable, approved by a Revive Lab manager (rl_0034).
         t.nr_approved_at, nra.full_name, t.item_code
  from revive_tickets t
  join revive_trcs trc on trc.id = t.trc_id
  left join revive_bemmp_projects bp on bp.id = t.bemmp_id
  join employees sh on sh.id = t.stakeholder_id
  left join employees shm on shm.id = sh.reporting_manager_id
  join employees rb on rb.id = t.raised_by
  left join employees en on en.id = t.engineer_id
  left join employees sc on sc.id = t.scrapped_by
  left join employees nra on nra.id = t.nr_approved_by
  where revive_can_see(t.id)
  order by t.created_at desc
$function$;
revoke all on function public.revive_ticket_list() from public, anon;
grant execute on function public.revive_ticket_list() to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.revive_delete_ticket(p_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t         revive_tickets;
  n_events  integer;
  n_hops    integer;
  remaining integer;
begin
  if not is_sw_admin() then
    raise exception 'Only the software administrator can delete a ticket';
  end if;

  select * into t from revive_tickets where id = p_ticket_id for update;
  if not found then
    raise exception 'That ticket does not exist';
  end if;

  select count(*) into n_events from revive_ticket_events where ticket_id = t.id;
  select count(*) into n_hops from revive_transfers where ticket_id = t.id;

  perform log_audit('revive_ticket', t.id, 'deleted', jsonb_build_object(
    'code', t.code,
    'status', t.status,
    'hospital', t.facility,
    'source_ticket_no', t.source_ticket_no,
    'equipment_name', t.equipment_name,
    'spare_name', t.spare_name,
    'trc_id', t.trc_id,
    'stakeholder_id', t.stakeholder_id,
    'raised_by', t.raised_by,
    'created_at', t.created_at,
    'events', n_events,
    'transfers', n_hops));

  delete from revive_tickets where id = t.id;

  select count(*) into remaining from revive_tickets;
  if remaining = 0 then
    perform setval('public.revive_ticket_number', 1, false);
  end if;
  if not exists (select 1 from revive_tickets where series = 'WRL') then
    perform setval('public.revive_wh_ticket_number', 1, false);
  end if;

  return jsonb_build_object('code', t.code, 'numbering_restarted', remaining = 0);
end $function$;

drop function if exists public.revive_raise_ticket(uuid,text,text,uuid,text,text,text,text,text,text,text,text,text,text,date,uuid,jsonb,boolean,text,text,text,text,uuid,text,text,text);
CREATE OR REPLACE FUNCTION public.revive_raise_ticket(p_trc_id uuid, p_hospital text, p_state text, p_bemmp_id uuid, p_district text, p_source_ticket_no text, p_equipment_name text, p_equipment_barcode text, p_spare_name text, p_issue text, p_return_address text, p_contact_number text, p_in_courier text, p_in_awb text, p_in_dispatched_on date, p_stakeholder_id uuid DEFAULT NULL::uuid, p_items jsonb DEFAULT NULL::jsonb, p_billing_spare boolean DEFAULT NULL::boolean, p_approval_reason text DEFAULT NULL::text, p_equipment_make text DEFAULT NULL::text, p_equipment_model text DEFAULT NULL::text, p_source text DEFAULT 'hospital'::text, p_warehouse_id uuid DEFAULT NULL::uuid, p_contract_type text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_criticality text DEFAULT NULL::text, p_item_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me        uuid := current_employee_id();
  trc       revive_trcs;
  bemmp     revive_bemmp_projects;
  wh        revive_warehouses;
  src       text := coalesce(nullif(btrim(coalesce(p_source, '')), ''), 'hospital');
  st        text := btrim(coalesce(p_state, ''));
  why       text := btrim(coalesce(p_approval_reason, ''));
  make      text := nullif(btrim(coalesce(p_equipment_make, '')), '');
  model     text := nullif(btrim(coalesce(p_equipment_model, '')), '');
  contract  text := upper(nullif(btrim(coalesce(p_contract_type, '')), ''));
  cat       text := upper(nullif(btrim(coalesce(p_category, '')), ''));
  crit      text := nullif(btrim(coalesce(p_criticality, '')), '');
  as_co     boolean;
  -- A coordinator asking for another state's Revive Lab, one that is not theirs (rl_0058).
  desk      boolean;
  -- Another state's Revive Lab, for a hospital spare whose BEMMP has a project head: asked for, whoever raises it (rl_0060).
  asks      boolean;
  far       boolean;
  holder    uuid;
  t         revive_tickets;
  clean     text;
  entries   jsonb := '[]'::jsonb;
  entry     jsonb;
  item_kind text;
  item_name text;
  late_n    integer;
  late_list text;
  -- An observer ticked "May raise tickets" names the field engineer it belongs to, as the desk does (rl_0057).
  obs_raise boolean := exists (select 1 from revive_members m where m.employee_id = current_employee_id() and m.is_observer and m.may_raise);
  ots       boolean;
  -- A warehouse in-charge raises their own warehouse's spares, as a field engineer does (rl_0063).
  wh_ids    uuid[] := (select m.warehouse_ids from revive_members m where m.employee_id = current_employee_id() and m.is_warehouse);
  wh_in     boolean := coalesce(cardinality(wh_ids), 0) > 0;
begin
  if me is null then raise exception 'Only a signed-in employee can raise a ticket'; end if;
  if not revive_has_access() then
    raise exception 'Revive Lab has not been given to you yet — ask the software administrator';
  end if;
  -- Whoever sends spares in raises them: the field, or a Revive Lab's desk.
  -- Its engineers repair what arrives, its manager approves, Purchase buys for it, and an observer only watches (rl_0019, rl_0036, rl_0039).
  if not is_sw_admin() and exists (
       select 1 from revive_members m
        where m.employee_id = me and (m.is_engineer or m.is_purchase or m.is_manager or (m.is_observer and not m.may_raise))
          and not (m.is_coordinator or m.is_admin)) then
    raise exception 'Tickets are raised by the field engineer or a Revive Lab coordinator — not by a Revive Lab engineer, manager, observer or Purchase';
  end if;
  if src not in ('hospital', 'warehouse') then
    raise exception 'A spare comes from a hospital or a warehouse';
  end if;

  select * into trc from revive_trcs where id = p_trc_id and is_active;
  if not found then raise exception 'Choose the Revive Lab the spare is going to'; end if;
  as_co := revive_runs_trc(p_trc_id);
  desk := not as_co and exists (select 1 from revive_trcs x where x.is_active and revive_runs_trc(x.id));
  -- Also the Regional Revive Lab, when the state has a Revive Lab of its own and the spare is sent there, not already there (rl_0062).
  asks := (src = 'hospital'
          and exists (select 1 from revive_bemmp_projects b where b.id = p_bemmp_id and b.head_id is not null)
          and ((trc.state is not null and trc.state <> st)
            or (trc.state is null and not as_co and exists (select 1 from revive_trcs o where o.is_active and o.state = st))))
          -- A warehouse in-charge: their state's Revive Labs and the Regional ones; another state's is asked for (rl_0063).
          or (src = 'warehouse' and not as_co and not desk and wh_in and trc.state is not null and trc.state <> st);

  /*
    A field engineer closes what has come back to them before raising
    another (rl_0041): a spare in transit back that they have not confirmed
    arriving, or one back with them that they have not closed as working or
    not, past the days the software administrator set for its state. Whose
    it is is the person it was sent back to, whoever raised it — a ticket
    the desk raised in their name is theirs to close too.

    Nor does the desk raise in the name of a field engineer who is held
    (rl_0042; the user, 3 Oct: "coordinator cannot raise bcz from eng it is
    pending"). Only they can confirm or close those spares. A warehouse's
    card names its in-charge, not a field engineer, and is not held.
  */
  -- A warehouse's in-charge is not held (rl_0020); raising their own warehouse's spare, neither (rl_0063).
  if not as_co and not desk and src <> 'warehouse' then
    select count(*)::int, string_agg(o.code, ', ' order by o.days desc, o.number)
      into late_n, late_list
      from revive_overdue_returns(case when obs_raise and p_stakeholder_id is not null then p_stakeholder_id else me end) o;
    if late_n > 0 and obs_raise and p_stakeholder_id is not null then
      raise exception '% has % to close first, past the days allowed for a spare that came back to them.',
        coalesce((select full_name from employees where id = p_stakeholder_id), 'This field engineer'), late_list;
    end if;
    if late_n > 0 then
      raise exception 'Close % first — % past the days allowed for a spare that came back to you. Then you can raise a new ticket.',
        late_list, case when late_n = 1 then 'it is' else 'they are' end;
    end if;
  elsif src = 'hospital' and p_stakeholder_id is not null then
    select count(*)::int, string_agg(o.code, ', ' order by o.days desc, o.number)
      into late_n, late_list
      from revive_overdue_returns(p_stakeholder_id) o;
    if late_n > 0 then
      raise exception '% has % to close first, past the days allowed for a spare that came back to them. A ticket can be raised in their name once they have confirmed or closed %.',
        coalesce((select full_name from employees where id = p_stakeholder_id), 'This field engineer'), late_list,
        case when late_n = 1 then 'it' else 'them' end;
    end if;
  end if;

  if length(st) < 2 then
    raise exception 'Choose the state';
  end if;
  -- The desk raises at a Revive Lab of its own for that state: the state's own, or a Regional one.
  if as_co and not asks and trc.state is not null and trc.state <> st then
    raise exception '% serves %, not % — choose a Revive Lab for %, or a Regional one', trc.name, trc.state, st, st;
  end if;

  if src = 'warehouse' then
    -- A warehouse's defective spare arrives at the Revive Lab; its desk writes the card.
    if not (as_co or desk or wh_in) then
      raise exception 'Only a Revive Lab coordinator or a warehouse in-charge raises a ticket for a spare from a warehouse';
    end if;
    if not (as_co or desk) and not (p_warehouse_id = any(wh_ids)) then
      raise exception 'Raise it from a warehouse of yours';
    end if;
    select * into wh from revive_warehouses where id = p_warehouse_id and is_active;
    if not found then raise exception 'Choose the warehouse'; end if;
    if wh.state is not null and wh.state <> st then
      raise exception '% is in %, not %', wh.name, wh.state, st;
    end if;
    contract := null;
  else
    select * into bemmp from revive_bemmp_projects where id = p_bemmp_id and is_active;
    if not found then
      raise exception 'Choose the BEMMP';
    end if;
    if bemmp.state is not null and bemmp.state <> st then
      raise exception 'BEMMP % is for % — choose a BEMMP for %', bemmp.code, bemmp.state, st;
    end if;
    if length(btrim(coalesce(p_district, ''))) < 2 then
      raise exception 'Choose the district';
    end if;
    -- A private contract says which: AMC, CAMC, or OTS / Stock (rl_0024, rl_0057).
    if bemmp.asks_contract then
      if contract is null or contract not in ('AMC', 'CAMC', 'OTS') then
        raise exception 'Choose the contract type — AMC, CAMC or OTS / Stock';
      end if;
    else
      contract := null;
    end if;
    -- OTS / Stock asks no hospital (rl_0057).
    ots := contract = 'OTS';
    if not ots and length(btrim(coalesce(p_hospital, ''))) < 2 then
      raise exception 'Enter the hospital the spare came from';
    end if;
  end if;
  if length(coalesce(make, '')) > 80 or length(coalesce(model, '')) > 80 then
    raise exception 'Keep the make and the model under 80 characters';
  end if;

  -- A CAMC spare is critical, whoever raises it.
  if contract = 'CAMC' then
    if crit = 'non_critical' then
      raise exception 'A CAMC spare is always critical';
    end if;
    crit := 'critical';
  end if;
  -- The desk's raise is its acceptance (rl_0023), so it says what the spare is now. Asked for elsewhere, it is not accepted yet.
  if as_co and not asks then
    if cat is null or cat not in ('A', 'B', 'C') then
      raise exception 'Choose the spare category — A, B or C';
    end if;
    if crit is null or crit not in ('critical', 'non_critical') then
      raise exception 'Choose whether the spare is critical or non-critical';
    end if;
  else
    -- The field does not classify it: the Revive Lab does, on arrival.
    cat := null;
    if contract is distinct from 'CAMC' then crit := null; end if;
  end if;

  /*
    The list. Without one — an app from before rl_0011 — the spare name is
    the whole list. A line left blank is skipped rather than refused: it is
    an empty row, not a mistake.
  */
  if p_items is null then
    if length(btrim(coalesce(p_spare_name, ''))) < 2 then
      raise exception 'Enter the spare''s name';
    end if;
    entries := jsonb_build_array(jsonb_build_object('kind', 'spare', 'name', btrim(p_spare_name)));
  else
    if jsonb_typeof(p_items) <> 'array' then
      raise exception 'List the spares and accessories';
    end if;
    for entry in select value from jsonb_array_elements(p_items) loop
      item_kind := entry->>'kind';
      item_name := btrim(coalesce(entry->>'name', ''));
      continue when item_name = '';
      if item_kind is null or item_kind not in ('spare', 'accessory', 'full_machine') then
        raise exception 'Each line is a spare, an accessory or a full machine';
      end if;
      if length(item_name) < 2 then
        raise exception 'Enter the name of each spare and accessory';
      end if;
      if length(item_name) > 120 then
        raise exception 'Keep each name under 120 characters';
      end if;
      entries := entries || jsonb_build_array(jsonb_build_object('kind', item_kind, 'name', item_name));
    end loop;
    if jsonb_array_length(entries) = 0 then
      raise exception 'Enter the spare''s name';
    end if;
    if jsonb_array_length(entries) > 10 then
      raise exception 'A ticket carries at most 10 spares and accessories';
    end if;
  end if;

  if length(btrim(coalesce(p_issue, ''))) < 3 then
    raise exception 'Describe the issue identified';
  end if;
  if length(btrim(coalesce(p_return_address, ''))) < 5 then
    raise exception 'Enter the address the spare should be returned to';
  end if;
  clean := nullif(regexp_replace(coalesce(p_contact_number, ''), '[^0-9+]', '', 'g'), '');
  if clean is not null and length(clean) not between 7 and 15 then
    raise exception 'That contact number does not look right';
  end if;

  holder := coalesce(p_stakeholder_id, me);

  if (as_co or desk) and p_stakeholder_id is null then
    raise exception '%', case when src = 'warehouse'
      then 'Name the warehouse in-charge this spare belongs to, so they and their manager can follow it'
      else 'Name the field engineer this spare belongs to, so they and their manager can follow it' end;
  end if;
  if not as_co and obs_raise and p_stakeholder_id is null then
    raise exception 'Name the field engineer this spare belongs to, so they and their manager can follow it';
  end if;
  if not as_co and not desk and not obs_raise and holder <> me then
    raise exception 'Only the Revive Lab''s coordinator can raise a ticket on somebody else''s behalf';
  end if;
  if not exists (select 1 from employees where id = holder and is_active) then
    raise exception '%', case when src = 'warehouse'
      then 'That warehouse in-charge is not an active employee'
      else 'That field engineer is not an active employee' end;
  end if;

  /*
    Another state's Revive Lab. A field engineer is offered their own
    state's and the Regional ones; any other is asked for, with a reason,
    and waits for the Regional Revive Lab admins.
  */
  -- Only where the BEMMP has a project head, who approves it (rl_0049); otherwise it simply goes.
  -- Whoever raises it, a Revive Lab the desk runs too (rl_0060).
  far := asks;
  -- The desk goes to a Revive Lab not its own only by asking: another state's, approved by the BEMMP's project head (rl_0058).
  if desk and not far and src <> 'warehouse' then
    raise exception '% is not your Revive Lab — raise it at your own, or ask for another state''s Revive Lab', trc.name;
  end if;
  if far and length(why) < 5 then
    raise exception '% is not a Revive Lab for % — say why it should go there, and % approves it first', trc.name, st,
      case when src = 'warehouse' then 'the Regional Revive Lab admin' else 'the project head' end;
  end if;
  if far and length(why) > 500 then
    raise exception 'Keep the reason under 500 characters';
  end if;

  insert into revive_tickets (
    series, number, status, trc_kind, trc_id, source, warehouse_id, facility, state, bemmp_id, billing_spare, district,
    source_ticket_no, item_code, equipment_name, equipment_make, equipment_model, equipment_barcode, spare_name, items,
    issue, return_address, contact_number, in_courier, in_awb, in_dispatched_on,
    stakeholder_id, raised_by, raised_as, contract_type, spare_category, criticality, accepted_at)
  values (
    case when src = 'warehouse' then 'WRL' else 'RL' end,
    case when src = 'warehouse' then nextval('public.revive_wh_ticket_number') else nextval('public.revive_ticket_number') end,
    case when far then 'awaiting_approval' when as_co then 'accepted' else 'pending_acceptance' end,
    trc.kind, trc.id,
    src,
    case when src = 'warehouse' then wh.id end,
    case when src = 'warehouse' then wh.name else coalesce(nullif(btrim(coalesce(p_hospital, '')), ''), 'OTS / Stock') end,
    st,
    case when src = 'hospital' then p_bemmp_id end,
    case when src = 'hospital' and bemmp.asks_billing then coalesce(p_billing_spare, false) end,
    case when src = 'hospital' then btrim(p_district) end,
    -- A warehouse's card carries its document number in the same place (rl_0063).
    left(nullif(btrim(coalesce(p_source_ticket_no, '')), ''), 60),
    case when src = 'warehouse' then left(nullif(btrim(coalesce(p_item_code, '')), ''), 60) end,
    nullif(btrim(coalesce(p_equipment_name, '')), ''),
    make,
    model,
    nullif(btrim(coalesce(p_equipment_barcode, '')), ''),
    entries->0->>'name',
    entries,
    btrim(p_issue),
    btrim(p_return_address),
    clean,
    nullif(btrim(coalesce(p_in_courier, '')), ''),
    nullif(btrim(coalesce(p_in_awb, '')), ''),
    p_in_dispatched_on,
    holder, me, case when as_co or desk then 'coordinator' else 'engineer' end,
    contract, cat, crit,
    case when as_co and not far then now() end)
  returning * into t;

  if far then
    insert into revive_approvals (ticket_id, kind, asked_trc_id, to_trc_id, reason, requested_by)
    values (t.id, 'raise', trc.id, trc.id, why, me);
    perform revive_step(t.id, 'awaiting_approval', null, t.trc_id, 'status', 'lab_requested',
      'For ' || trc.name || ': ' || why);
  else
    perform revive_log(t.id, 'pending_acceptance', null, t.trc_id,
      case when src = 'warehouse' and as_co then 'Raised at the Revive Lab — from ' || wh.name
           when src = 'warehouse' and desk then 'Raised from ' || wh.name || ' — sent on by another Revive Lab''s desk'
           when src = 'warehouse' then 'Raised from ' || wh.name
           when as_co then 'Raised at the Revive Lab'
           else 'Raised from the field' end);
    -- Raised at the desk, the spare is already there: accepted as it is raised (rl_0023).
    if as_co and not far then
      perform revive_log(t.id, 'accepted', 'pending_acceptance', t.trc_id,
        concat_ws(' · ', 'Accepted on arrival — raised at the Revive Lab', 'Category ' || cat, revive_crit_label(crit)));
    end if;
  end if;

  return jsonb_build_object('id', t.id, 'code', t.code, 'number', t.number, 'status', t.status);
end $function$;
revoke all on function public.revive_raise_ticket(uuid,text,text,uuid,text,text,text,text,text,text,text,text,text,text,date,uuid,jsonb,boolean,text,text,text,text,uuid,text,text,text,text) from public, anon;
grant execute on function public.revive_raise_ticket(uuid,text,text,uuid,text,text,text,text,text,text,text,text,text,text,date,uuid,jsonb,boolean,text,text,text,text,uuid,text,text,text,text) to authenticated, service_role;
