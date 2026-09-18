/**
 * A Revive Lab ticket: its states, its number, and what can be done to it.
 *
 * The database decides every one of these things — each action is a
 * function that checks the caller and the state before it moves anything.
 * This file only mirrors those rules closely enough to show the right
 * buttons. When the two disagree the server wins and says why, which is
 * the right way round: a button that should not have been offered costs a
 * sentence, a change that should not have been allowed costs the history.
 */

export type TicketStatus =
  | 'awaiting_approval'
  | 'approved'
  | 'not_approved'
  | 'pending_acceptance'
  | 'transferred'
  | 'accepted'
  | 'assigned'
  | 'in_repair'
  | 'parts_requested'
  | 'parts_ordered'
  | 'parts_ready'
  | 'repaired'
  | 'not_repairable'
  | 'service_denied'
  | 'in_transit_return'
  | 'received_back'
  | 'closed'

export type TrcKind = 'regional' | 'project'

export const TRC_KIND_LABEL: Record<TrcKind, string> = {
  regional: 'Regional Revive Lab',
  project: 'Project Revive Lab',
}

/**
 * One colour per status, running the way a spare does: red when it has just
 * been raised and nobody has it, green when it is back and closed, the blues
 * in the middle while the Revive Lab works on it. Violet is the side road —
 * a transfer to another Revive Lab. The warm colours between in repair and
 * repaired are a repair waiting on something bought: orange asked for,
 * yellow being bought, cyan ready for the engineer. Rose is a spare that
 * cannot be repaired, slate one the customer would not have repaired.
 * Going to another Revive Lab waits on approval: fuchsia while it waits,
 * emerald approved, pink not approved.
 */
export type Tone =
  | 'red' | 'amber' | 'sky' | 'indigo' | 'lime' | 'teal' | 'green' | 'violet'
  | 'orange' | 'yellow' | 'cyan' | 'rose' | 'slate' | 'fuchsia' | 'emerald' | 'pink' | 'blue'

interface StatusMeta {
  /** The full sentence, for the ticket page and the email. */
  label: string
  /** For a badge, a chart axis and a filter. */
  short: string
  tone: Tone
  /** Where it sits in the journey, for ordering a board left to right. */
  order: number
  /** Whose move it is, said plainly. */
  waitingOn: string
}

export const STATUS: Record<TicketStatus, StatusMeta> = {
  awaiting_approval: {
    label: 'Waiting for approval', short: 'Waiting for approval', tone: 'fuchsia', order: 0.2,
    waitingOn: 'the Regional Revive Lab admins to approve it',
  },
  not_approved: {
    label: 'Not approved — to send elsewhere or discard', short: 'Not approved', tone: 'pink', order: 0.4,
    waitingOn: 'the field engineer to send it elsewhere or discard it',
  },
  approved: {
    label: 'Approved — ready to send', short: 'Approved', tone: 'emerald', order: 0.6,
    waitingOn: 'it to be sent',
  },
  pending_acceptance: {
    label: 'Pending Revive Lab acceptance', short: 'Pending acceptance', tone: 'red', order: 1,
    waitingOn: 'the Revive Lab coordinator to accept it',
  },
  transferred: {
    label: 'Transferred — on its way to another Revive Lab', short: 'Transferred', tone: 'violet', order: 1,
    waitingOn: 'the receiving Revive Lab to accept it',
  },
  accepted: {
    label: 'Accepted by the coordinator', short: 'Accepted', tone: 'amber', order: 2,
    waitingOn: 'the coordinator to assign an engineer',
  },
  assigned: {
    label: 'Assigned to an engineer', short: 'Assigned', tone: 'sky', order: 3,
    waitingOn: 'the engineer to accept the repair',
  },
  in_repair: {
    label: 'In repair', short: 'In repair', tone: 'indigo', order: 4,
    waitingOn: 'the engineer to finish the repair',
  },
  parts_requested: {
    label: 'Component requested — waiting to be taken on', short: 'Component requested', tone: 'orange', order: 4.2,
    waitingOn: 'the coordinator or Purchase to accept the component request',
  },
  parts_ordered: {
    label: 'Purchasing a component', short: 'Purchasing', tone: 'yellow', order: 4.4,
    waitingOn: 'the component to be purchased and sent to the engineer',
  },
  parts_ready: {
    label: 'Component ready — the engineer to confirm', short: 'Component ready', tone: 'cyan', order: 4.6,
    waitingOn: 'the engineer to confirm the purchase and carry on',
  },
  repaired: {
    label: 'Repaired — pending dispatch', short: 'Pending dispatch', tone: 'lime', order: 5,
    waitingOn: 'the coordinator to dispatch it back',
  },
  not_repairable: {
    label: 'Not repairable — scrap or dispatch back', short: 'Not repairable', tone: 'rose', order: 5.2,
    waitingOn: 'the coordinator to move it to scrap or dispatch it back',
  },
  service_denied: {
    label: 'Customer denied service — pending dispatch', short: 'Customer denied', tone: 'slate', order: 5.4,
    waitingOn: 'the coordinator to dispatch it back',
  },
  in_transit_return: {
    label: 'Dispatched — in transit back', short: 'In transit back', tone: 'teal', order: 6,
    waitingOn: 'the field engineer to confirm it arrived',
  },
  received_back: {
    label: 'Back with the field engineer', short: 'Received back', tone: 'blue', order: 6.5,
    waitingOn: 'the field engineer to fit it and close the ticket',
  },
  closed: {
    label: 'Closed', short: 'Closed', tone: 'green', order: 7,
    waitingOn: 'nobody',
  },
}

export const STATUS_ORDER = (Object.keys(STATUS) as TicketStatus[])
  .sort((a, b) => STATUS[a].order - STATUS[b].order)

export const OPEN_STATUSES = STATUS_ORDER.filter(s => s !== 'closed')

/** Waiting on a component: requested, being bought, or ready for the engineer. */
export const PARTS_STATUSES: readonly TicketStatus[] = ['parts_requested', 'parts_ordered', 'parts_ready']

/** The engineer has it: repairing, or waiting on a component for the repair. */
export const REPAIRING: readonly TicketStatus[] = ['in_repair', ...PARTS_STATUSES]

/**
 * Where the spare came from (rl_0020): a hospital, sent in by its field
 * engineer, or a warehouse, whose defective stock the Revive Lab's desk
 * raises on arrival and whose in-charge follows it.
 */
export type TicketSource = 'hospital' | 'warehouse'

/** How a ticket ended: sent back, moved to scrap, or discarded before it went anywhere (rl_0014). */
export type Closure = 'returned' | 'scrapped' | 'discarded'

/**
 * What a badge says. A closed ticket says how it closed when that was not
 * the spare coming back — scrapped, or discarded — so a list shows it
 * without opening the ticket. A spare that cannot be repaired says what the
 * engineer proposed.
 */
export function statusLook(
  status: TicketStatus, closure?: Closure | null, proposal?: Proposal | null,
): { label: string; short: string; tone: Tone } {
  if (status === 'closed' && closure === 'scrapped') return { label: 'Scrapped — closed', short: 'Scrapped', tone: 'slate' }
  if (status === 'closed' && closure === 'discarded') return { label: 'Discarded — never sent', short: 'Discarded', tone: 'slate' }
  if (status === 'not_repairable' && proposal) {
    return { ...STATUS.not_repairable, label: proposal === 'scrap' ? 'Not repairable — to scrap' : 'Not repairable — to send back' }
  }
  return STATUS[status] ?? { label: status, short: status, tone: 'slate' }
}

/** Badge colours per tone, light and dark both — the tokens flip underneath. */
export const TONE_CLASS: Record<Tone, string> = {
  red: 'bg-cyrixRed-100 text-cyrixRed-900',
  amber: 'bg-amber-100 text-amber-900',
  sky: 'bg-sky-100 text-sky-900',
  indigo: 'bg-indigo-100 text-indigo-900',
  lime: 'bg-lime-100 text-lime-900',
  teal: 'bg-teal-100 text-teal-900',
  green: 'bg-green-100 text-green-900',
  violet: 'bg-violet-100 text-violet-900',
  orange: 'bg-orange-100 text-orange-900',
  yellow: 'bg-yellow-100 text-yellow-900',
  cyan: 'bg-cyan-100 text-cyan-900',
  rose: 'bg-rose-100 text-rose-900',
  slate: 'bg-slate-100 text-slate-900',
  fuchsia: 'bg-fuchsia-100 text-fuchsia-900',
  emerald: 'bg-emerald-100 text-emerald-900',
  pink: 'bg-pink-100 text-pink-900',
  blue: 'bg-blue-100 text-blue-900',
}

/** An icon on a soft patch of its colour: section headings and the history. */
export const TONE_SOFT: Record<Tone, string> = {
  red: 'bg-cyrixRed-100 text-cyrixRed-700',
  amber: 'bg-amber-100 text-amber-700',
  sky: 'bg-sky-100 text-sky-700',
  indigo: 'bg-indigo-100 text-indigo-700',
  lime: 'bg-lime-100 text-lime-700',
  teal: 'bg-teal-100 text-teal-700',
  green: 'bg-green-100 text-green-700',
  violet: 'bg-violet-100 text-violet-700',
  orange: 'bg-orange-100 text-orange-700',
  yellow: 'bg-yellow-100 text-yellow-700',
  cyan: 'bg-cyan-100 text-cyan-700',
  rose: 'bg-rose-100 text-rose-700',
  slate: 'bg-slate-100 text-slate-700',
  fuchsia: 'bg-fuchsia-100 text-fuchsia-700',
  emerald: 'bg-emerald-100 text-emerald-700',
  pink: 'bg-pink-100 text-pink-700',
  blue: 'bg-blue-100 text-blue-700',
}

/**
 * An icon in its colour on a plain ground — a tab, a button. Literal shades
 * that read on white and on the dark page alike.
 */
export const TONE_TEXT: Record<Tone, string> = {
  red: 'text-cyrixRed-600',
  amber: 'text-amber-600',
  sky: 'text-sky-600',
  indigo: 'text-indigo-500',
  lime: 'text-lime-600',
  teal: 'text-teal-600',
  green: 'text-green-600',
  violet: 'text-violet-500',
  orange: 'text-orange-600',
  yellow: 'text-yellow-600',
  cyan: 'text-cyan-600',
  rose: 'text-rose-600',
  slate: 'text-slate-500',
  fuchsia: 'text-fuchsia-600',
  emerald: 'text-emerald-600',
  pink: 'text-pink-600',
  blue: 'text-blue-600',
}

/** Chart fills, in the same order of meaning as the badges. */
export const TONE_FILL: Record<Tone, string> = {
  red: '#e30613',
  amber: '#d97706',
  sky: '#0284c7',
  indigo: '#4f46e5',
  lime: '#65a30d',
  teal: '#0d9488',
  green: '#16a34a',
  violet: '#7c3aed',
  orange: '#ea580c',
  yellow: '#ca8a04',
  cyan: '#0891b2',
  rose: '#e11d48',
  slate: '#64748b',
  fuchsia: '#c026d3',
  emerald: '#059669',
  pink: '#db2777',
  blue: '#2563eb',
}

/** A filled dot in the tone's colour — a tab, a marker beside a label. */
export const TONE_DOT: Record<Tone, string> = {
  red: 'bg-cyrixRed-600',
  amber: 'bg-amber-500',
  sky: 'bg-sky-500',
  indigo: 'bg-indigo-500',
  lime: 'bg-lime-500',
  teal: 'bg-teal-500',
  green: 'bg-green-500',
  violet: 'bg-violet-500',
  orange: 'bg-orange-500',
  yellow: 'bg-yellow-500',
  cyan: 'bg-cyan-500',
  rose: 'bg-rose-500',
  slate: 'bg-slate-400',
  fuchsia: 'bg-fuchsia-500',
  emerald: 'bg-emerald-500',
  pink: 'bg-pink-500',
  blue: 'bg-blue-500',
}

/**
 * RL-01 … RL-09, RL-10 … RL-99, then RL-100.
 *
 * Padded to two and never cut: the database's own generated column does
 * the same, and a helper that truncated 100 to "10" would show a second
 * ticket's number on the first.
 */
export function ticketCode(n: number): string {
  return `RL-${n < 10 ? '0' : ''}${n}`
}

/** "RL-07", "rl-7", "7" → 7. Anything else → null. */
export function parseTicketCode(raw: string | null | undefined): number | null {
  const m = String(raw ?? '').trim().match(/^(?:rl-?)?0*(\d{1,7})$/i)
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 ? n : null
}

export interface Me {
  employee_id: string
  is_engineer: boolean
  is_coordinator: boolean
  is_manager: boolean
  is_admin: boolean
  is_sw_admin: boolean
  trc_ids: string[]
  /** Buys what engineers request as a purchase, for the Revive Labs ticked (rl_0013). */
  is_purchase?: boolean
  /** Approves where a spare goes: an admin of a Regional Revive Lab (rl_0014). */
  approves?: boolean
}

/* ------------------------------------------------------------------ */

/**
 * Which state a Revive Lab or a BEMMP is for. No state is Regional: every
 * state's. A field engineer's route card offers the state's own and the
 * Regional ones; any other Revive Lab is asked for, and approved first.
 */
export const serves = (x: { state: string | null }, state: string | null | undefined): boolean =>
  !x.state || x.state === state

export const stateLabel = (state: string | null | undefined): string => state || 'Regional'

/**
 * Who approves where a spare goes, by name: the admins of a Regional Revive
 * Lab — or every admin, while no Regional Revive Lab has one. The same rule
 * as revive_approves(), so the name shown is the person who can.
 */
export function approversOf(
  members: ReadonlyArray<{ full_name: string; is_admin: boolean; trc_ids: string[] }>,
  labs: ReadonlyArray<{ id: string; state: string | null }>,
): string[] {
  const regional = new Set(labs.filter(l => !l.state).map(l => l.id))
  const admins = members.filter(m => m.is_admin)
  const there = admins.filter(m => m.trc_ids.some(id => regional.has(id)))
  return (there.length ? there : admins).map(m => m.full_name)
}

/** "Henry", "Henry or Saranya", "Henry, Anu or Saranya". */
export function orList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}

export type ApprovalKind = 'raise' | 'transfer'
export type ApprovalStatus = 'pending' | 'approved' | 'declined' | 'cancelled' | 'sent'

/** A request to go to another Revive Lab, and what became of it (rl_0014). */
export interface Approval {
  id: string
  /** raise: another state's Revive Lab, asked for on the route card. transfer: the desk moving a ticket on. */
  kind: ApprovalKind
  status: ApprovalStatus
  from_trc_id: string | null
  from_trc_name: string | null
  asked_trc_id: string
  asked_trc_name: string
  /** What was approved — which may not be what was asked for. */
  to_trc_id: string
  to_trc_name: string
  to_trc_state: string | null
  reason: string
  /** Where a transfer carries on from if it is not approved. */
  back_to: TicketStatus | null
  requested_by_name: string
  requested_at: string
  decided_by_name: string | null
  decided_at: string | null
  decision_note: string | null
}

/** Not repairable: what the engineer proposes becomes of it. */
export type Proposal = 'scrap' | 'return'

export const PROPOSAL_LABEL: Record<Proposal, string> = {
  scrap: 'Move to scrap',
  return: 'Send back to the field engineer',
}

/* ------------------------------------------------------------------ */

/** A component request, as the ticket list carries it: enough to know whose move it is. */
export type PartRoute = 'local' | 'purchase'

/**
 * A component request's journey (rl_0016). Everything asked for reaches the
 * coordinator first: they buy it locally, or pass it to Purchase. Whoever
 * buys it attaches the bill; the coordinator then writes it into the Revive
 * Lab's stock and sends it to the engineer, who confirms it.
 */
export type PartStatus =
  | 'requested' | 'forwarded' | 'accepted' | 'bought' | 'sent' | 'received' | 'declined' | 'cancelled'

export interface PartSummary {
  id: string
  route: PartRoute
  status: PartStatus
}

/** Stock an engineer has taken, and whether the coordinator has approved it (rl_0016). */
export type StockUseStatus = 'requested' | 'approved' | 'declined' | 'cancelled'

export interface StockUseSummary {
  id: string
  status: StockUseStatus
}

export const STOCK_USE_STATUS: Record<StockUseStatus, { label: string; tone: Tone }> = {
  requested: { label: 'Waiting for the coordinator', tone: 'orange' },
  approved: { label: 'Off the stock', tone: 'green' },
  declined: { label: 'Not approved', tone: 'rose' },
  cancelled: { label: 'Taken back', tone: 'slate' },
}

export const PART_ROUTE_LABEL: Record<PartRoute, string> = {
  local: 'Local purchase',
  purchase: 'Purchase',
}

export const PART_STATUS: Record<PartStatus, { label: string; tone: Tone }> = {
  requested: { label: 'With the coordinator', tone: 'orange' },
  forwarded: { label: 'With Purchase', tone: 'amber' },
  accepted: { label: 'Being purchased', tone: 'yellow' },
  bought: { label: 'Purchased — to go into stock', tone: 'violet' },
  sent: { label: 'Sent — engineer to confirm', tone: 'cyan' },
  received: { label: 'Confirmed', tone: 'green' },
  declined: { label: 'Declined', tone: 'rose' },
  cancelled: { label: 'Cancelled', tone: 'slate' },
}

/** Where the coordinator's local purchase stands, while it is being bought (rl_0019). */
export type PartProgress = 'enquiry_given' | 'order_placed'

export const PART_PROGRESS: Record<PartProgress, string> = {
  enquiry_given: 'Enquiry given',
  order_placed: 'Order placed',
}

/**
 * A request's status as it reads: Purchase's order says when it is due,
 * since it waits with the coordinator until it arrives (rl_0019).
 */
export function partStatusLook(r: { route: PartRoute; status: PartStatus; po_number?: string | null; edd?: string | null }): { label: string; tone: Tone } {
  if (r.status === 'bought' && r.route === 'purchase' && r.po_number) {
    const due = r.edd ? new Date(r.edd.slice(0, 10) + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null
    return { label: due ? `Ordered — due ${due}` : 'Ordered', tone: 'violet' }
  }
  return PART_STATUS[r.status]
}

/** "PO 1042", but "PO/2026/42" as it is — a number that says PO already is not told twice. */
export const poLabel = (po: string) => (/^p.?s?o(?![a-z])/i.test(po.trim()) ? po.trim() : `PO ${po.trim()}`)

/** Still going: it has not reached the engineer, and nobody has given up on it. */
export const partOpen = (s: PartStatus) =>
  s === 'requested' || s === 'forwarded' || s === 'accepted' || s === 'bought'

export interface TicketLike {
  status: TicketStatus
  trc_id: string
  engineer_id: string | null
  stakeholder_id: string
  raised_by: string
  parts?: readonly PartSummary[] | null
  stock?: readonly StockUseSummary[] | null
  closure?: Closure | null
  proposal?: Proposal | null
  approval?: Pick<Approval, 'kind' | 'status'> | null
}

/** A coordinator or manager of that lab: the desk. */
export function runsTrc(me: Me | null | undefined, trcId: string): boolean {
  return !!me && (me.is_coordinator || me.is_manager) && me.trc_ids.includes(trcId)
}

/** Holds the Purchase role for that Revive Lab. */
export function buysFor(me: Me | null | undefined, trcId: string): boolean {
  return !!me && !!me.is_purchase && me.trc_ids.includes(trcId)
}

/** Who buys a request: the desk for a local purchase, Purchase for a purchase. */
export function handlesPart(me: Me | null | undefined, route: PartRoute, trcId: string): boolean {
  return route === 'local' ? runsTrc(me, trcId) : buysFor(me, trcId)
}

/**
 * Whose move a component request is now (rl_0016). It starts and ends with
 * the Revive Lab: the coordinator decides how it is bought and writes what
 * came back into stock; Purchase buys what is passed to them; the engineer
 * confirms it and carries on.
 */
export function partActor(
  part: { route: PartRoute; status: PartStatus },
  me: Me | null | undefined,
  trcId: string,
  engineerId?: string | null,
): boolean {
  switch (part.status) {
    case 'requested': return runsTrc(me, trcId)
    case 'forwarded': return buysFor(me, trcId)
    case 'accepted': return handlesPart(me, part.route, trcId)
    case 'bought': return runsTrc(me, trcId)
    case 'sent': return !!me && !!engineerId && engineerId === me.employee_id
    default: return false
  }
}

export type Action =
  | 'accept' | 'assign' | 'start' | 'return' | 'complete' | 'observe'
  | 'dispatch' | 'transfer' | 'received' | 'close_ticket' | 'courier'
  | 'use_part' | 'request_part' | 'expect' | 'scrap'
  | 'approve' | 'decline_approval' | 'send' | 'cancel_transfer' | 'reroute' | 'discard'

/**
 * What this person may do to this ticket now, in the order the buttons
 * should appear — the forward move first, the side-steps after.
 *
 * What is done to one component request — accept it, buy it, confirm it —
 * sits on the request itself, not here.
 */
export function actionsFor(t: TicketLike, me: Me | null | undefined): Action[] {
  if (!me) return []
  const desk = runsTrc(me, t.trc_id)
  const mine = t.engineer_id === me.employee_id
  const sender = t.raised_by === me.employee_id || t.stakeholder_id === me.employee_id
  const open = t.approval && (t.approval.status === 'pending' || t.approval.status === 'approved') ? t.approval : null
  const out: Action[] = []

  // Going to another Revive Lab (rl_0014): the Regional Revive Lab admins
  // decide; approved, whoever asked sends it — the field engineer for their
  // own ticket, the desk for a transfer.
  if (me.approves && t.status === 'awaiting_approval') out.push('approve', 'decline_approval')
  if (t.status === 'approved' && open && (open.kind === 'raise' ? sender : desk)) out.push('send')
  // Not approved: their own state's or a Regional Revive Lab instead.
  if (sender && t.status === 'not_approved') out.push('reroute')

  if (desk && (t.status === 'pending_acceptance' || t.status === 'transferred')) out.push('accept')
  // Whoever sent it in, until it arrives: a card is often raised before the
  // courier has given a tracking number (rl_0011).
  if (sender && t.status === 'pending_acceptance') out.push('courier')
  if (mine && t.status === 'assigned') out.push('start')
  if (mine && t.status === 'in_repair') out.push('complete')
  // While it is being repaired — and while a component for it is on its way.
  if (mine && REPAIRING.includes(t.status)) out.push('use_part', 'request_part', 'observe', 'expect')
  if (desk && (t.status === 'accepted' || t.status === 'assigned')) out.push('assign')
  if (desk && (t.status === 'repaired' || t.status === 'service_denied')) out.push('dispatch')
  // Not repairable: the one move the engineer proposed. A repair closed by
  // an app from before the proposal leaves the desk both (rl_0014).
  if (desk && t.status === 'not_repairable') {
    if (t.proposal !== 'scrap') out.push('dispatch')
    if (t.proposal !== 'return') out.push('scrap')
  }
  // Only the field engineer it was sent back to: the Revive Lab dispatched
  // it and cannot know it has landed (rl_0005).
  if (t.stakeholder_id === me.employee_id && t.status === 'in_transit_return') out.push('received')
  // Back in their hands: they fit it, then close the ticket saying whether it works.
  if (t.stakeholder_id === me.employee_id && t.status === 'received_back') out.push('close_ticket')
  if (mine && (t.status === 'assigned' || t.status === 'in_repair')) out.push('return')
  if (desk && (t.status === 'accepted' || t.status === 'assigned' || t.status === 'in_repair')) out.push('transfer')
  if (desk && open?.kind === 'transfer' && (t.status === 'awaiting_approval' || t.status === 'approved')) out.push('cancel_transfer')
  // A ticket raised for another state's Revive Lab that never went anywhere.
  if (sender && (t.status === 'not_approved' || (open?.kind === 'raise' && (t.status === 'awaiting_approval' || t.status === 'approved')))) {
    out.push('discard')
  }

  return out
}

/**
 * Components waiting on this person: a request whose move is theirs, and
 * stock an engineer has taken that the desk has not approved yet.
 */
export function partsWaitingOn(t: TicketLike, me: Me | null | undefined): number {
  if (!me) return 0
  const requests = (t.parts ?? []).filter(p => partActor(p, me, t.trc_id, t.engineer_id)).length
  const stock = runsTrc(me, t.trc_id)
    ? (t.stock ?? []).filter(u => u.status === 'requested').length
    : 0
  return requests + stock
}

const SIDE_STEPS: readonly Action[] = [
  'transfer', 'return', 'observe', 'courier', 'use_part', 'request_part', 'expect',
  'decline_approval', 'cancel_transfer', 'discard',
]

/** Whether a ticket is waiting on this person specifically, for "My queue". */
export function waitingOnMe(t: TicketLike, me: Me | null | undefined): boolean {
  return actionsFor(t, me).some(a => !SIDE_STEPS.includes(a)) || partsWaitingOn(t, me) > 0
}

/* ------------------------------------------------------------------ */

export type TabId = 'all' | 'repair' | 'assigned' | 'unassigned' | 'parts' | 'open' | 'closed'

export interface TicketTab {
  id: TabId
  label: string
  /** The colour of what the tab holds, so the row of them reads at a glance. */
  tone: Tone
  match: (t: TicketLike) => boolean
}

/**
 * The tabs on the ticket list, by what the person does.
 *
 * The desk sorts what has no engineer yet and what is waiting on a
 * component. An engineer follows repairs and assignments. Purchase sees
 * what came to them as a purchase request (the database shows them nothing
 * else), with what is still to be bought apart. Anybody else, a field
 * engineer, sees theirs open and closed.
 */
export function ticketTabs(me: Me | null | undefined): TicketTab[] {
  const closed = (t: TicketLike) => t.status === 'closed'
  const partsPending = (t: TicketLike) => PARTS_STATUSES.includes(t.status)

  if (me && (me.is_coordinator || me.is_manager || me.is_admin)) {
    return [
      { id: 'all', label: 'All', tone: 'slate', match: () => true },
      { id: 'unassigned', label: 'Not assigned', tone: 'red', match: t => ['pending_acceptance', 'transferred', 'accepted'].includes(t.status) },
      { id: 'parts', label: 'Component pending', tone: 'orange', match: partsPending },
      { id: 'closed', label: 'Closed', tone: 'green', match: closed },
    ]
  }
  if (me?.is_engineer) {
    return [
      { id: 'all', label: 'All', tone: 'slate', match: () => true },
      { id: 'repair', label: 'In repair', tone: 'indigo', match: t => REPAIRING.includes(t.status) },
      { id: 'assigned', label: 'Assigned', tone: 'sky', match: t => t.status === 'assigned' },
      { id: 'closed', label: 'Closed', tone: 'green', match: closed },
    ]
  }
  if (me?.is_purchase) {
    // All is everything they can see: the purchase requests that came to
    // them, and anything else of theirs — a ticket once raised under the
    // same code was hidden here while the badge counted it.
    return [
      { id: 'all', label: 'All', tone: 'slate', match: () => true },
      { id: 'parts', label: 'Component pending', tone: 'orange', match: t => (t.parts ?? []).some(p => p.route === 'purchase' && partOpen(p.status)) },
      { id: 'closed', label: 'Closed', tone: 'green', match: closed },
    ]
  }
  return [
    { id: 'all', label: 'All', tone: 'slate', match: () => true },
    { id: 'open', label: 'Open', tone: 'amber', match: t => !closed(t) },
    { id: 'closed', label: 'Closed', tone: 'green', match: closed },
  ]
}

/**
 * Who raises tickets: whoever sends spares in. A Revive Lab's own engineer
 * repairs what arrives and Purchase buys for it; neither sends one, so
 * neither is offered it — unless they also run a desk, where spares arrive
 * and cards are written for them (rl_0015, rl_0019; the database refuses
 * them too).
 */
export function canRaise(me: Me | null | undefined): boolean {
  if (!me) return true
  return !(me.is_engineer || me.is_purchase) || me.is_coordinator || me.is_manager || me.is_admin
}

/* ------------------------------------------------------------------ */

/** How the engineer closed the repair (rl_0013). */
export type Outcome = 'repaired' | 'not_repairable' | 'customer_denied'

export const OUTCOME_LABEL: Record<Outcome, string> = {
  repaired: 'Repaired',
  not_repairable: 'Not repairable',
  customer_denied: 'Customer denied service',
}

/* ------------------------------------------------------------------ */

/**
 * What was sent in: a spare, an accessory from the same machine — the
 * power cable, the probe — or the whole machine (rl_0019). A ticket carries
 * at least one and at most ten (rl_0011), in the order they were entered.
 */
export type ItemKind = 'spare' | 'accessory' | 'full_machine'

export interface TicketItem {
  kind: ItemKind
  name: string
}

export const ITEM_KIND_LABEL: Record<ItemKind, string> = {
  spare: 'Spare',
  accessory: 'Accessory',
  full_machine: 'Full Machine',
}

export const MAX_ITEMS = 10

/** The lines worth sending: names trimmed, blank lines dropped. */
export function cleanItems(items: readonly TicketItem[]): TicketItem[] {
  return items
    .map(i => ({ kind: i.kind, name: i.name.trim() }))
    .filter(i => i.name.length > 0)
}

/**
 * What a list or a heading calls it: the first name, and how many more.
 * A ticket from before the list existed has only its spare name.
 */
export function itemsSummary(t: { spare_name: string | null; items?: readonly TicketItem[] | null }): string | null {
  const items = t.items ?? []
  if (items.length === 0) return t.spare_name
  return items.length === 1 ? items[0].name : `${items[0].name} +${items.length - 1} more`
}
