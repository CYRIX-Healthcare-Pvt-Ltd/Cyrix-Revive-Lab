import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase, friendlyError } from './supabase'
import type { TicketStatus, TrcKind } from './tickets'

// ---------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------

export interface Trc {
  id: string
  name: string
  kind: TrcKind
  is_active: boolean
  sort_order: number
}

export interface Ticket {
  id: string
  number: number
  code: string
  status: TicketStatus
  trc_kind: TrcKind
  trc_id: string
  trc_name: string
  source_ticket_no: string | null
  /** The hospital. The route card calls it Hospital name. */
  facility: string
  district: string | null
  state: string | null
  /** The BEMMP programme the equipment belongs to — AP, KL, RJ, UP, Pvt … */
  bemmp_id: string | null
  bemmp_code: string | null
  equipment_name: string | null
  equipment_barcode: string | null
  spare_name: string | null
  issue: string | null
  return_address: string | null
  contact_number: string | null
  in_courier: string | null
  in_awb: string | null
  in_dispatched_on: string | null
  stakeholder_id: string
  stakeholder_name: string
  stakeholder_ecode: string
  /** The field engineer's function — KLBEMP, RJBEMP … — from their employee record. */
  stakeholder_function: string | null
  stakeholder_manager_name: string | null
  raised_by: string
  raised_by_name: string
  raised_by_function: string | null
  raised_as: 'engineer' | 'coordinator'
  engineer_id: string | null
  engineer_name: string | null
  engineer_ecode: string | null
  out_courier: string | null
  out_awb: string | null
  out_dispatched_on: string | null
  created_at: string
  updated_at: string
  closed_at: string | null
}

export interface TrailEvent {
  id: number
  status: TicketStatus
  from_status: TicketStatus | null
  trc_id: string | null
  trc_name: string | null
  actor_name: string | null
  actor_ecode: string | null
  note: string | null
  at: string
  /** On an assignment: who it was given to (rl_0009). */
  engineer_name: string | null
  engineer_ecode: string | null
  /** A move, or something the engineer found while repairing it (rl_0010). */
  kind: 'status' | 'observation'
}

export interface Hop {
  hop: number
  from_trc_name: string
  to_trc_name: string
  from_trc_id: string
  to_trc_id: string
  courier: string | null
  awb: string | null
  dispatched_on: string | null
  reason: string | null
  transferred_by_name: string | null
  transferred_at: string
}

export interface Member {
  employee_id: string
  ecode: string
  full_name: string
  designation: string | null
  is_engineer: boolean
  is_coordinator: boolean
  is_manager: boolean
  is_admin: boolean
  trc_ids: string[]
  updated_at: string
  updated_by_name: string | null
}

export interface Person {
  id: string
  ecode: string
  full_name: string
  designation: string | null
  department: string | null
}

const unwrap = <T,>(res: { data: unknown; error: unknown }): T => {
  if (res.error) throw new Error(friendlyError(res.error))
  return res.data as T
}

// ---------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------

/**
 * Asks the sender to go through the outbox.
 *
 * Every status change already queued its own email, server-side, in the
 * same transaction that changed the status — this only says "now, please".
 * Fire and forget: the person who pressed the button has done their part,
 * and a mail provider having a slow morning must never turn that into a
 * failure on their screen.
 */
export function drainMail(): void {
  if (!MAIL_SENDER_DEPLOYED) return
  void supabase.functions.invoke('revive-notify', { body: { drain: true } }).catch(() => {})
}

/**
 * Off until the revive-notify function is deployed.
 *
 * Calling a function that does not exist fails its CORS preflight in the
 * browser, and did so on every page load and every action — a console full
 * of red that hid any error worth reading. The notes are still queued in
 * revive_mail_outbox on every status change; nothing is lost by not asking
 * yet. Turn this on in the same change that ships the sender.
 */
const MAIL_SENDER_DEPLOYED = false

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

export function useTrcs() {
  return useQuery({
    queryKey: ['revive', 'trcs'],
    staleTime: 5 * 60_000,
    queryFn: async () => unwrap<Trc[]>(
      await supabase.from('revive_trcs')
        .select('id, name, kind, is_active, sort_order')
        .order('sort_order').order('name'),
    ),
  })
}

export function useTickets() {
  return useQuery({
    queryKey: ['revive', 'tickets'],
    queryFn: async () => unwrap<Ticket[]>(await supabase.rpc('revive_ticket_list')),
  })
}

export function useTrail(ticketId: string | undefined) {
  return useQuery({
    enabled: !!ticketId,
    queryKey: ['revive', 'trail', ticketId],
    queryFn: async () => unwrap<TrailEvent[]>(
      await supabase.rpc('revive_ticket_trail', { p_ticket_id: ticketId }),
    ),
  })
}

export function useHops(ticketId: string | undefined) {
  return useQuery({
    enabled: !!ticketId,
    queryKey: ['revive', 'hops', ticketId],
    queryFn: async () => unwrap<Hop[]>(
      await supabase.rpc('revive_ticket_transfers', { p_ticket_id: ticketId }),
    ),
  })
}

export function useVisibleEvents() {
  return useQuery({
    queryKey: ['revive', 'events'],
    queryFn: async () => unwrap<Array<{ ticket_id: string; status: string; trc_id: string | null; at: string }>>(
      await supabase.rpc('revive_visible_events'),
    ),
  })
}

export function useMembers(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['revive', 'members'],
    queryFn: async () => unwrap<Member[]>(await supabase.rpc('revive_member_list')),
  })
}

export interface BemmpProject {
  id: string
  code: string
  is_active: boolean
  sort_order: number
}

/** The BEMMP programmes a ticket can belong to. Admins keep the list. */
export function useBemmpProjects() {
  return useQuery({
    queryKey: ['revive', 'bemmp'],
    staleTime: 5 * 60_000,
    queryFn: async () => unwrap<BemmpProject[]>(
      await supabase.from('revive_bemmp_projects')
        .select('id, code, is_active, sort_order')
        .order('sort_order').order('code'),
    ),
  })
}

export function useFindPeople(q: string) {
  const term = q.trim()
  return useQuery({
    enabled: term.length >= 2,
    queryKey: ['revive', 'people', term.toLowerCase()],
    staleTime: 60_000,
    queryFn: async () => unwrap<Person[]>(await supabase.rpc('revive_find_people', { p_q: term })),
  })
}

// ---------------------------------------------------------------------
// Writes — every one a checked function on the server
// ---------------------------------------------------------------------

/** After any change to a ticket: refresh what shows it, and send the mail. */
function useTicketMutation<A, R = unknown>(fn: (args: A) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['revive'] })
      drainMail()
    },
  })
}

const rpc = async (name: string, args: Record<string, unknown>) =>
  unwrap<unknown>(await supabase.rpc(name, args))

/** The route card (form CHPL/CRL/SRC), field for field. */
export interface RaiseInput {
  trcId: string
  hospital: string
  state: string
  bemmpId: string
  district: string
  sourceTicketNo: string
  equipmentName: string
  equipmentBarcode: string
  spareName: string
  issue: string
  returnAddress: string
  contactNumber: string
  inCourier: string
  inAwb: string
  inDispatchedOn: string
  stakeholderId: string | null
}

export function useRaiseTicket() {
  return useTicketMutation(async (a: RaiseInput) => rpc('revive_raise_ticket', {
    p_trc_id: a.trcId,
    p_hospital: a.hospital,
    p_state: a.state,
    p_bemmp_id: a.bemmpId,
    p_district: a.district,
    p_source_ticket_no: a.sourceTicketNo,
    p_equipment_name: a.equipmentName,
    p_equipment_barcode: a.equipmentBarcode,
    p_spare_name: a.spareName,
    p_issue: a.issue,
    p_return_address: a.returnAddress,
    p_contact_number: a.contactNumber,
    p_in_courier: a.inCourier,
    p_in_awb: a.inAwb,
    p_in_dispatched_on: a.inDispatchedOn || null,
    p_stakeholder_id: a.stakeholderId,
  }) as Promise<{ id: string; code: string; number: number }>)
}

export const useAccept = () => useTicketMutation(
  (a: { id: string; note?: string }) => rpc('revive_accept', { p_ticket_id: a.id, p_note: a.note || null }))

export const useAssign = () => useTicketMutation(
  (a: { id: string; engineerId: string; note?: string }) =>
    rpc('revive_assign', { p_ticket_id: a.id, p_engineer_id: a.engineerId, p_note: a.note || null }))

/** What the engineer found while it is in repair. The status stays In repair. */
export const useAddObservation = () => useTicketMutation(
  (a: { id: string; note: string }) => rpc('revive_add_observation', { p_ticket_id: a.id, p_note: a.note }))

export const useStartRepair = () => useTicketMutation(
  (a: { id: string; note?: string }) => rpc('revive_start_repair', { p_ticket_id: a.id, p_note: a.note || null }))

export const useReturnToDesk = () => useTicketMutation(
  (a: { id: string; note: string }) => rpc('revive_return_to_desk', { p_ticket_id: a.id, p_note: a.note }))

export const useCompleteRepair = () => useTicketMutation(
  (a: { id: string; note?: string }) => rpc('revive_complete_repair', { p_ticket_id: a.id, p_note: a.note || null }))

export const useDispatch = () => useTicketMutation(
  (a: { id: string; courier: string; awb: string; on: string; note?: string }) =>
    rpc('revive_dispatch', {
      p_ticket_id: a.id, p_courier: a.courier, p_awb: a.awb,
      p_dispatched_on: a.on || null, p_note: a.note || null,
    }))

export const useMarkReceived = () => useTicketMutation(
  (a: { id: string; note?: string }) => rpc('revive_mark_received', { p_ticket_id: a.id, p_note: a.note || null }))

export const useTransfer = () => useTicketMutation(
  (a: { id: string; toTrcId: string; reason: string; courier: string; awb: string; on: string }) =>
    rpc('revive_transfer', {
      p_ticket_id: a.id, p_to_trc_id: a.toTrcId, p_reason: a.reason,
      p_courier: a.courier, p_awb: a.awb, p_dispatched_on: a.on || null,
    }))

export function useSaveMember() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (a: {
      employeeId: string; engineer: boolean; coordinator: boolean
      manager: boolean; admin: boolean; trcIds: string[]
    }) => rpc('revive_save_member', {
      p_employee_id: a.employeeId,
      p_engineer: a.engineer, p_coordinator: a.coordinator,
      p_manager: a.manager, p_admin: a.admin,
      p_trc_ids: a.trcIds,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['revive', 'members'] }),
  })
}

export function useSaveTrc() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (a: { id: string | null; name: string; kind: TrcKind; active: boolean }) =>
      rpc('revive_save_trc', { p_id: a.id, p_name: a.name, p_kind: a.kind, p_active: a.active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['revive'] }),
  })
}
