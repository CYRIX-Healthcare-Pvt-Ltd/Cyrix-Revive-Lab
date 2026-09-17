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
  | 'pending_acceptance'
  | 'transferred'
  | 'accepted'
  | 'assigned'
  | 'in_repair'
  | 'repaired'
  | 'in_transit_return'
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
 * a transfer to another Revive Lab.
 */
export type Tone = 'red' | 'amber' | 'sky' | 'indigo' | 'lime' | 'teal' | 'green' | 'violet'

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
  repaired: {
    label: 'Repaired — pending dispatch', short: 'Pending dispatch', tone: 'lime', order: 5,
    waitingOn: 'the coordinator to dispatch it back',
  },
  in_transit_return: {
    label: 'Dispatched — in transit back', short: 'In transit back', tone: 'teal', order: 6,
    waitingOn: 'the field engineer to confirm it arrived',
  },
  closed: {
    label: 'Closed — received back', short: 'Closed', tone: 'green', order: 7,
    waitingOn: 'nobody',
  },
}

export const STATUS_ORDER = (Object.keys(STATUS) as TicketStatus[])
  .sort((a, b) => STATUS[a].order - STATUS[b].order)

export const OPEN_STATUSES = STATUS_ORDER.filter(s => s !== 'closed')

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
}

export interface TicketLike {
  status: TicketStatus
  trc_id: string
  engineer_id: string | null
  stakeholder_id: string
  raised_by: string
}

/** A coordinator or manager of that lab: the desk. */
export function runsTrc(me: Me | null | undefined, trcId: string): boolean {
  return !!me && (me.is_coordinator || me.is_manager) && me.trc_ids.includes(trcId)
}

export type Action =
  | 'accept' | 'assign' | 'start' | 'return' | 'complete' | 'observe'
  | 'dispatch' | 'transfer' | 'received' | 'courier'

/**
 * What this person may do to this ticket now, in the order the buttons
 * should appear — the forward move first, the side-steps after.
 */
export function actionsFor(t: TicketLike, me: Me | null | undefined): Action[] {
  if (!me) return []
  const desk = runsTrc(me, t.trc_id)
  const mine = t.engineer_id === me.employee_id
  const out: Action[] = []

  if (desk && (t.status === 'pending_acceptance' || t.status === 'transferred')) out.push('accept')
  // Whoever sent it in, until it arrives: a card is often raised before the
  // courier has given a tracking number (rl_0011).
  if ((t.raised_by === me.employee_id || t.stakeholder_id === me.employee_id) && t.status === 'pending_acceptance') {
    out.push('courier')
  }
  if (mine && t.status === 'assigned') out.push('start')
  if (mine && t.status === 'in_repair') out.push('complete')
  // As often as there is something to write down; the status stays In repair.
  if (mine && t.status === 'in_repair') out.push('observe')
  if (desk && (t.status === 'accepted' || t.status === 'assigned')) out.push('assign')
  if (desk && t.status === 'repaired') out.push('dispatch')
  // Only the field engineer it was sent back to: the Revive Lab dispatched
  // it and cannot know it has landed (rl_0005).
  if (t.stakeholder_id === me.employee_id && t.status === 'in_transit_return') out.push('received')
  if (mine && (t.status === 'assigned' || t.status === 'in_repair')) out.push('return')
  if (desk && (t.status === 'accepted' || t.status === 'assigned' || t.status === 'in_repair')) out.push('transfer')

  return out
}

/** Whether a ticket is waiting on this person specifically, for "My queue". */
export function waitingOnMe(t: TicketLike, me: Me | null | undefined): boolean {
  return actionsFor(t, me).some(a => a !== 'transfer' && a !== 'return' && a !== 'observe' && a !== 'courier')
}

/* ------------------------------------------------------------------ */

/**
 * What was sent in: a spare, or an accessory from the same machine — the
 * power cable, the probe. A ticket carries at least one and at most ten
 * (rl_0011), in the order they were entered.
 */
export type ItemKind = 'spare' | 'accessory'

export interface TicketItem {
  kind: ItemKind
  name: string
}

export const ITEM_KIND_LABEL: Record<ItemKind, string> = {
  spare: 'Spare',
  accessory: 'Accessory',
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
