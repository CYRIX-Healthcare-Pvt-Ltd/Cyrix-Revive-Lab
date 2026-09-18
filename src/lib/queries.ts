import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase, friendlyError } from './supabase'
import type {
  Approval, Closure, Outcome, PartRoute, PartStatus, PartSummary, Proposal, StockUseStatus, StockUseSummary,
  PartProgress, TicketItem, TicketStatus, TrcKind,
} from './tickets'
import { uploadPartFile } from './partFiles'
import { uploadStageFile } from './attachments'

// ---------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------

export interface Trc {
  id: string
  name: string
  kind: TrcKind
  /** The state it serves; null is Regional, every state's (rl_0014). */
  state: string | null
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
  /** Under a BEMMP that asks (Pvt): is the spare billed to the customer. Null where nobody was asked (rl_0012). */
  billing_spare: boolean | null
  equipment_name: string | null
  equipment_barcode: string | null
  /** The first line of `items` — what lists and headings call the ticket. */
  spare_name: string | null
  /** Every spare and accessory sent in, in order (rl_0011). */
  items: TicketItem[]
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
  /** How the engineer closed the repair (rl_0013). */
  outcome: Outcome | null
  /** returned: dispatched back. scrapped: moved to scrap. discarded: never sent anywhere (rl_0014). */
  closure: Closure | null
  scrapped_at: string | null
  scrapped_by_name: string | null
  /** When the Revive Lab engineer expects the repair done. */
  expected_by: string | null
  /** Its component requests, just enough to know whose move each one is. */
  parts: PartSummary[]
  /** Stock taken for it, and whether the coordinator has approved it (rl_0016). */
  stock: StockUseSummary[]
  /** Not repairable: what the engineer proposed (rl_0014). */
  proposal: Proposal | null
  /** The state its Revive Lab serves; null for a Regional one. */
  trc_state: string | null
  /** The latest request to go to another Revive Lab, whatever became of it. */
  approval: Approval | null
  /** The coordinator found it damaged in transit, and photographed it (rl_0015). */
  arrival_damaged: boolean
  arrival_photos: string[]
  /** The repaired spare: a photograph, and a short video of it working. */
  done_photos: string[]
  done_video: string | null
  /** How it arrived back with the field engineer. */
  return_damaged: boolean
  return_photos: string[]
  /** What they said when they closed it: it works, or it does not. */
  final_working: boolean | null
  received_at: string | null
  /** On the route card after the equipment name (rl_0019). */
  equipment_make: string | null
  equipment_model: string | null
  /** The voice note the engineer closed the repair with, a minute at most. */
  done_voice: string | null
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
  /**
   * A move; something the engineer found while repairing it (rl_0010); or
   * the courier details added after the ticket was raised (rl_0011). Only a
   * move changes the status.
   */
  kind: 'status' | 'observation' | 'courier' | 'component' | 'eta'
  /**
   * The button that made the step, where the status alone does not say:
   * used, requested, accepted, declined, purchased, confirmed, cancelled,
   * repaired, not_repairable, customer_denied, scrapped, expected (rl_0013).
   */
  action: string | null
  /** An observation spoken instead of typed (rl_0015). */
  voice_path: string | null
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
  is_purchase: boolean
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
        .select('id, name, kind, state, is_active, sort_order')
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
  /** The route card asks Billing spare under this one — Pvt (rl_0012). */
  asks_billing: boolean
  /** The state whose programme it is; null runs in every state (rl_0014). */
  state: string | null
}

/** The BEMMP programmes a ticket can belong to. Admins keep the list. */
export function useBemmpProjects() {
  return useQuery({
    // Its own key: People & Revive Labs reads the same table without the
    // flag, and a shared cache entry would lose it. Invalidating
    // ['revive', 'bemmp'] there still refreshes this.
    queryKey: ['revive', 'bemmp', 'for-tickets'],
    staleTime: 5 * 60_000,
    queryFn: async () => unwrap<BemmpProject[]>(
      await supabase.from('revive_bemmp_projects')
        .select('id, code, is_active, sort_order, asks_billing, state')
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

/** One component in a Revive Lab's stock. */
export interface Component {
  id: string
  trc_id: string
  /** The Cyrix part number, C-001. */
  part_no: string
  /** The manufacturer's part number, or the value. */
  value: string | null
  /** IC, MOSFET, RESISTOR … */
  item: string | null
  /** TH, SMD … */
  package: string | null
  qty: number
  updated_at: string
}

/**
 * A Revive Lab's whole stock.
 *
 * In pages: the API hands back a thousand rows at most, and the stock sheet
 * already has 1,328 parts — a single request would quietly lose the rest.
 */
export function useComponents(trcId: string | null | undefined) {
  return useQuery({
    enabled: !!trcId,
    queryKey: ['revive', 'components', trcId],
    queryFn: async () => {
      const PAGE = 1000
      const all: Component[] = []
      for (let from = 0; ; from += PAGE) {
        const rows = unwrap<Component[]>(
          await supabase.from('revive_components')
            .select('id, trc_id, part_no, value, item, package, qty, updated_at')
            .eq('trc_id', trcId!)
            .order('part_no')
            .range(from, from + PAGE - 1),
        )
        all.push(...rows)
        if (rows.length < PAGE) break
      }
      return all
    },
  })
}

/** Stock an engineer took for a repair, with what the coordinator said (rl_0016). */
export interface ComponentUse {
  id: string
  component_id: string
  part_no: string
  value: string | null
  item: string | null
  package: string | null
  qty: number
  status: StockUseStatus
  /** stock: taken off the shelf. bought: it came with a purchase the coordinator wrote up. */
  source: 'stock' | 'bought'
  /** How many of that part the Revive Lab has now. */
  in_stock: number
  requested_by: string
  requested_by_name: string | null
  requested_at: string
  decided_by_name: string | null
  decided_at: string | null
  decision_note: string | null
}

/** What one ticket took from stock. */
export function useComponentUses(ticketId: string | undefined) {
  return useQuery({
    enabled: !!ticketId,
    queryKey: ['revive', 'uses', ticketId],
    queryFn: async () => unwrap<ComponentUse[]>(await supabase.rpc('revive_component_uses', { p_ticket_id: ticketId })),
  })
}

export interface PartRequest {
  id: string
  ticket_id: string
  ticket_code: string
  ticket_status: TicketStatus
  facility: string
  trc_id: string
  trc_name: string
  route: PartRoute
  name: string
  qty: number
  note: string | null
  link: string | null
  photo_path: string | null
  status: PartStatus
  bill_amount: number | null
  bill_no: string | null
  vendor: string | null
  bill_paths: string[]
  requested_by: string
  requested_by_name: string | null
  requested_at: string
  accepted_by_name: string | null
  accepted_at: string | null
  declined_by_name: string | null
  declined_at: string | null
  declined_reason: string | null
  purchased_by_name: string | null
  purchased_at: string | null
  received_by_name: string | null
  received_at: string | null
  /** What the coordinator wrote it up as, once it was bought (rl_0016). */
  component_id: string | null
  part_no: string | null
  value: string | null
  item: string | null
  package: string | null
  bought_qty: number | null
  stocked_by_name: string | null
  stocked_at: string | null
  /** Where the coordinator's local purchase stands (rl_0019). */
  progress: PartProgress | null
  progress_by_name: string | null
  progress_at: string | null
  /** The order Purchase placed: it waits with the coordinator until it arrives. */
  po_number: string | null
  po_date: string | null
  edd: string | null
}

/** One component taken from stock, as the desk's own list shows it (rl_0018). */
export interface StockUseRow {
  id: string
  ticket_id: string
  ticket_code: string
  ticket_status: TicketStatus
  facility: string
  trc_id: string
  trc_name: string
  component_id: string
  part_no: string
  value: string | null
  item: string | null
  package: string | null
  /** How many of that part the Revive Lab has now. */
  in_stock: number
  qty: number
  status: StockUseStatus
  source: 'stock' | 'bought'
  requested_by: string
  requested_by_name: string | null
  requested_at: string
  decided_by_name: string | null
  decided_at: string | null
  decision_note: string | null
}

/**
 * Everything engineers have taken from stock, newest first — the same
 * approvals as on a ticket, gathered so the desk can work through them.
 */
export function useStockUses(status?: StockUseStatus) {
  return useQuery({
    queryKey: ['revive', 'stock-uses', status ?? 'all'],
    queryFn: async () => unwrap<StockUseRow[]>(
      await supabase.rpc('revive_stock_use_list', { p_status: status ?? null }),
    ),
  })
}

/** Component requests: one ticket's, or every one this person can see. */
export function usePartRequests(ticketId?: string) {
  return useQuery({
    queryKey: ['revive', 'parts', ticketId ?? 'all'],
    queryFn: async () => unwrap<PartRequest[]>(
      await supabase.rpc('revive_part_request_list', { p_ticket_id: ticketId ?? null }),
    ).map(r => ({ ...r, bill_amount: r.bill_amount === null ? null : Number(r.bill_amount) })),
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
  /** Only under a BEMMP that asks — Pvt. Null elsewhere. */
  billingSpare: boolean | null
  district: string
  sourceTicketNo: string
  equipmentName: string
  equipmentMake: string
  equipmentModel: string
  equipmentBarcode: string
  /** At least one line with a name; blank lines are dropped before sending. */
  items: TicketItem[]
  issue: string
  returnAddress: string
  contactNumber: string
  inCourier: string
  inAwb: string
  inDispatchedOn: string
  stakeholderId: string | null
  /** Why another state's Revive Lab: asked for, and approved before it is sent (rl_0014). */
  approvalReason: string | null
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
    // The first line's name as well, which is all an older database reads.
    p_spare_name: a.items[0]?.name ?? '',
    p_issue: a.issue,
    p_return_address: a.returnAddress,
    p_contact_number: a.contactNumber,
    p_in_courier: a.inCourier,
    p_in_awb: a.inAwb,
    p_in_dispatched_on: a.inDispatchedOn || null,
    p_stakeholder_id: a.stakeholderId,
    p_items: a.items,
    p_billing_spare: a.billingSpare,
    p_approval_reason: a.approvalReason,
    p_equipment_make: a.equipmentMake,
    p_equipment_model: a.equipmentModel,
  }) as Promise<{ id: string; code: string; number: number; status: TicketStatus }>)
}

/**
 * Accepting: the photographs of how it arrived go up first, and the paths
 * go with the call — the damage tick is worth nothing without them. The
 * courier details are on the same form, because the desk has the
 * consignment note in its hand and the sender often never came back.
 */
export const useAccept = () => useTicketMutation(
  async (a: { id: string; note?: string; damaged?: boolean; photos?: Blob[]; courier?: string; awb?: string; on?: string }) => {
    const paths = await uploadStage(a.id, 'arrival', a.photos)
    return rpc('revive_accept', {
      p_ticket_id: a.id, p_note: a.note || null,
      p_damaged: !!a.damaged, p_photos: paths,
      p_courier: a.courier || null, p_awb: a.awb || null, p_dispatched_on: a.on || null,
    })
  })

/** arrival-1, arrival-2, return-1 … uploaded in order, and their paths. */
async function uploadStage(ticketId: string, name: 'arrival' | 'return' | 'done', blobs?: Blob[]): Promise<string[]> {
  const paths: string[] = []
  for (const [i, blob] of (blobs ?? []).entries()) {
    paths.push(await uploadStageFile(ticketId, `${name}-${i + 1}` as 'arrival-1', blob))
  }
  return paths
}

export const useAssign = () => useTicketMutation(
  (a: { id: string; engineerId: string; note?: string }) =>
    rpc('revive_assign', { p_ticket_id: a.id, p_engineer_id: a.engineerId, p_note: a.note || null }))

/**
 * What the engineer found while it is in repair, typed or spoken. The
 * status stays In repair.
 */
export const useAddObservation = () => useTicketMutation(
  async (a: { id: string; note: string; voice?: Blob | null; spoken?: number }) => {
    const path = a.voice ? await uploadStageFile(a.id, `voice-${a.spoken ?? 1}` as 'voice-1', a.voice) : null
    return rpc('revive_add_observation', { p_ticket_id: a.id, p_note: a.note, p_voice_path: path })
  })

/** How the spare is travelling in — added or corrected until the Revive Lab accepts it. */
export const useUpdateCourier = () => useTicketMutation(
  (a: { id: string; courier: string; awb: string; on: string }) =>
    rpc('revive_update_courier', {
      p_ticket_id: a.id, p_courier: a.courier, p_awb: a.awb, p_dispatched_on: a.on || null,
    }))

/** Accepting the repair, with when it is expected done. */
export const useStartRepair = () => useTicketMutation(
  (a: { id: string; note?: string; expectedBy?: string }) =>
    rpc('revive_start_repair', { p_ticket_id: a.id, p_note: a.note || null, p_expected_by: a.expectedBy || null }))

export const useSetExpectedDate = () => useTicketMutation(
  (a: { id: string; expectedBy: string; note?: string }) =>
    rpc('revive_set_expected_date', { p_ticket_id: a.id, p_expected_by: a.expectedBy, p_note: a.note || null }))

export const useReturnToDesk = () => useTicketMutation(
  (a: { id: string; note: string }) => rpc('revive_return_to_desk', { p_ticket_id: a.id, p_note: a.note }))

/**
 * Closing the repair: repaired — with the spare photographed working, and a
 * short video and a voice note if they help — not repairable, with what
 * should become of it, or the customer denied service.
 */
export const useCompleteRepair = () => useTicketMutation(
  async (a: {
    id: string; note?: string; outcome: Outcome; proposal?: Proposal | null
    photos?: Blob[]; video?: Blob | null; voice?: Blob | null
  }) => {
    const repaired = a.outcome === 'repaired'
    const photos = repaired ? await uploadStage(a.id, 'done', a.photos) : []
    const video = repaired && a.video ? await uploadStageFile(a.id, 'done', a.video) : null
    const voice = repaired && a.voice ? await uploadStageFile(a.id, 'done-voice', a.voice) : null
    return rpc('revive_complete_repair', {
      p_ticket_id: a.id, p_note: a.note || null, p_outcome: a.outcome, p_proposal: a.proposal ?? null,
      p_photos: photos, p_video: video, p_voice: voice,
    })
  })

/** Not repairable, and not going back: scrap, which closes the ticket. */
export const useScrap = () => useTicketMutation(
  (a: { id: string; note?: string }) => rpc('revive_scrap', { p_ticket_id: a.id, p_note: a.note || null }))

/** Asked for from stock; the coordinator approves it before the count comes off (rl_0016). */
export const useUseComponent = () => useTicketMutation(
  (a: { ticketId: string; componentId: string; qty: number }) =>
    rpc('revive_use_component', { p_ticket_id: a.ticketId, p_component_id: a.componentId, p_qty: a.qty }) as Promise<string>)

export const useApproveUse = () => useTicketMutation(
  (a: { id: string; note?: string }) => rpc('revive_approve_use', { p_use_id: a.id, p_note: a.note || null }))

export const useDeclineUse = () => useTicketMutation(
  (a: { id: string; reason: string }) => rpc('revive_decline_use', { p_use_id: a.id, p_reason: a.reason }))

export const useCancelUse = () => useTicketMutation(
  (a: { id: string }) => rpc('revive_cancel_use', { p_use_id: a.id }))

/** The part number this Revive Lab uses for that value and item, or the next free one. */
export function usePartNo(trcId: string | undefined, value: string, item: string) {
  const v = value.trim()
  return useQuery({
    enabled: !!trcId && v.length > 0,
    queryKey: ['revive', 'part-no', trcId, v.toLowerCase(), item.trim().toLowerCase()],
    queryFn: async () => unwrap<string>(
      await supabase.rpc('revive_part_no_for', { p_trc_id: trcId, p_value: v, p_item: item.trim() })),
  })
}

/** A stock sheet, uploaded: parts added or brought up to date, quantities set to its count. */
export function useUploadStock() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (a: { trcId: string; rows: Array<{ part_no: string; value: string | null; item: string | null; package: string | null; qty: number }> }) =>
      rpc('revive_upload_stock', { p_trc_id: a.trcId, p_rows: a.rows }) as Promise<{ added: number; changed: number; same: number; not_in_sheet: number }>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['revive', 'components'] }),
  })
}

/**
 * The engineer asks for a component. The request exists before its photo
 * does — the storage rules only let a photo into a request's own folder —
 * so a photo that fails to upload leaves the request standing, and says so.
 */
export const useRequestPart = () => useTicketMutation(
  async (a: { ticketId: string; route: PartRoute; name: string; qty: number; note?: string; link?: string; photo?: Blob | null }) => {
    const id = await rpc('revive_request_part', {
      p_ticket_id: a.ticketId, p_route: a.route, p_name: a.name, p_qty: a.qty,
      p_note: a.note || null, p_link: a.link || null,
    }) as string
    let photoFailed = false
    if (a.photo) {
      try {
        const path = await uploadPartFile(a.ticketId, id, 'photo', a.photo)
        await rpc('revive_set_part_photo', { p_request_id: id, p_path: path })
      } catch {
        photoFailed = true
      }
    }
    return { id, photoFailed }
  })

/** Taken on by whoever buys it: the desk for a local purchase, Purchase for a purchase. */
export const useTakePart = () => useTicketMutation(
  (a: { id: string }) => rpc('revive_take_part', { p_request_id: a.id }))

/** Passed to Purchase — it is not to be had locally. */
export const useForwardPart = () => useTicketMutation(
  (a: { id: string; note?: string }) => rpc('revive_forward_part', { p_request_id: a.id, p_note: a.note || null }))

/** Where the coordinator's local purchase stands: blank, Enquiry given or Order placed (rl_0019). */
export const useSetPartProgress = () => useTicketMutation(
  (a: { id: string; progress: PartProgress | null }) =>
    rpc('revive_set_part_progress', { p_request_id: a.id, p_progress: a.progress }))

/**
 * Purchase places the order: PO number, PO date, when it should arrive and
 * from whom. It then waits with the coordinator, who adds it to stock when
 * it comes (rl_0019).
 */
export const useOrderPart = () => useTicketMutation(
  (a: { id: string; poNumber: string; poDate: string; edd: string; vendor: string }) =>
    rpc('revive_order_part', {
      p_request_id: a.id, p_po_number: a.poNumber, p_po_date: a.poDate, p_edd: a.edd, p_vendor: a.vendor,
    }))

/** Kept at the Revive Lab after all: the coordinator buys it locally. */
export const useMakeLocal = () => useTicketMutation(
  (a: { id: string; note?: string }) => rpc('revive_make_local', { p_request_id: a.id, p_note: a.note || null }))

/** What was bought, written into stock and sent to the engineer. */
export const useStockPart = () => useTicketMutation(
  (a: { id: string; value: string; item: string; package: string; partNo?: string | null; qty: number; useQty: number }) =>
    rpc('revive_stock_part', {
      p_request_id: a.id, p_value: a.value, p_item: a.item, p_package: a.package,
      p_part_no: a.partNo || null, p_qty: a.qty, p_use_qty: a.useQty,
    }))

export const useDeclinePart = () => useTicketMutation(
  (a: { id: string; reason: string }) => rpc('revive_decline_part', { p_request_id: a.id, p_reason: a.reason }))

/** Bought: the bill's pages go up first, then the request moves with their paths and the amount. */
export const usePurchasePart = () => useTicketMutation(
  async (a: { ticketId: string; id: string; amount: number; bills: Blob[]; billNo?: string; vendor?: string }) => {
    const paths: string[] = []
    for (const [i, bill] of a.bills.entries()) {
      paths.push(await uploadPartFile(a.ticketId, a.id, `bill-${i + 1}` as 'bill-1', bill))
    }
    return rpc('revive_purchase_part', {
      p_request_id: a.id, p_amount: a.amount, p_bill_paths: paths,
      p_bill_no: a.billNo || null, p_vendor: a.vendor || null,
    })
  })

export const useConfirmPart = () => useTicketMutation(
  (a: { id: string }) => rpc('revive_confirm_part', { p_request_id: a.id }))

export const useCancelPart = () => useTicketMutation(
  (a: { id: string; reason?: string }) => rpc('revive_cancel_part', { p_request_id: a.id, p_reason: a.reason || null }))

export const useDispatch = () => useTicketMutation(
  (a: { id: string; courier: string; awb: string; on: string; note?: string }) =>
    rpc('revive_dispatch', {
      p_ticket_id: a.id, p_courier: a.courier, p_awb: a.awb,
      p_dispatched_on: a.on || null, p_note: a.note || null,
    }))

/** It arrived back: the field engineer has it, and says whether the courier damaged it. */
export const useMarkReceived = () => useTicketMutation(
  async (a: { id: string; note?: string; damaged?: boolean; photos?: Blob[] }) => {
    const paths = await uploadStage(a.id, 'return', a.photos)
    return rpc('revive_mark_received', {
      p_ticket_id: a.id, p_note: a.note || null, p_damaged: !!a.damaged, p_photos: paths,
    })
  })

/** Fitted, and the ticket closed: working, or not. */
export const useCloseTicket = () => useTicketMutation(
  (a: { id: string; working: boolean; note: string }) =>
    rpc('revive_close_ticket', { p_ticket_id: a.id, p_working: a.working, p_note: a.note }))

/** A transfer is asked for; the Regional Revive Lab admins approve it before it is sent (rl_0014). */
export const useRequestTransfer = () => useTicketMutation(
  (a: { id: string; toTrcId: string; reason: string }) =>
    rpc('revive_request_transfer', { p_ticket_id: a.id, p_to_trc_id: a.toTrcId, p_reason: a.reason }))

/** Approved — for what was asked, or for another Revive Lab. */
export const useApprove = () => useTicketMutation(
  (a: { id: string; toTrcId?: string | null; note?: string }) =>
    rpc('revive_approve', { p_ticket_id: a.id, p_to_trc_id: a.toTrcId || null, p_note: a.note || null }))

export const useDeclineApproval = () => useTicketMutation(
  (a: { id: string; note: string }) => rpc('revive_decline_approval', { p_ticket_id: a.id, p_note: a.note }))

/** Approved, and sent: a raise to its Revive Lab, a transfer on its way. */
export const useSend = () => useTicketMutation(
  (a: { id: string; courier: string; awb: string; on: string; note?: string }) =>
    rpc('revive_send', {
      p_ticket_id: a.id, p_courier: a.courier || null, p_awb: a.awb || null,
      p_dispatched_on: a.on || null, p_note: a.note || null,
    }))

export const useCancelTransfer = () => useTicketMutation(
  (a: { id: string; note?: string }) => rpc('revive_cancel_transfer', { p_ticket_id: a.id, p_note: a.note || null }))

/** Not approved: to the field engineer's own state's or a Regional Revive Lab instead. */
export const useReroute = () => useTicketMutation(
  (a: { id: string; trcId: string; courier: string; awb: string; on: string }) =>
    rpc('revive_reroute', {
      p_ticket_id: a.id, p_trc_id: a.trcId, p_courier: a.courier || null,
      p_awb: a.awb || null, p_dispatched_on: a.on || null,
    }))

/** Given up before it was sent to any Revive Lab. */
export const useDiscard = () => useTicketMutation(
  (a: { id: string; note?: string }) => rpc('revive_discard', { p_ticket_id: a.id, p_note: a.note || null }))

export function useSaveMember() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (a: {
      employeeId: string; engineer: boolean; coordinator: boolean
      manager: boolean; admin: boolean; trcIds: string[]; purchase?: boolean
    }) => rpc('revive_save_member', {
      p_employee_id: a.employeeId,
      p_engineer: a.engineer, p_coordinator: a.coordinator,
      p_manager: a.manager, p_admin: a.admin,
      p_trc_ids: a.trcIds,
      p_purchase: a.purchase ?? null,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['revive', 'members'] }),
  })
}

export function useSaveTrc() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (a: { id: string | null; name: string; kind: TrcKind; active: boolean; state: string | null }) =>
      rpc('revive_save_trc', {
        p_id: a.id, p_name: a.name, p_kind: a.kind, p_active: a.active, p_state: a.state ?? 'Regional',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['revive'] }),
  })
}
