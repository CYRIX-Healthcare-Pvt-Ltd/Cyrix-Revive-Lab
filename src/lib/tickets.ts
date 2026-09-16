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

export type Tone = 'amber' | 'violet' | 'sky' | 'indigo' | 'emerald' | 'teal' | 'ink'

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
    label: 'Pending Revive Lab acceptance', short: 'Pending acceptance', tone: 'amber', order: 1,
    waitingOn: 'the Revive Lab coordinator to accept it',
  },
  transferred: {
    label: 'Transferred — on its way to another Revive Lab', short: 'Transferred', tone: 'violet', order: 1,
    waitingOn: 'the receiving Revive Lab to accept it',
  },
  accepted: {
    label: 'Accepted by the coordinator', short: 'Accepted', tone: 'sky', order: 2,
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
    label: 'Repaired — pending dispatch', short: 'Pending dispatch', tone: 'emerald', order: 5,
    waitingOn: 'the coordinator to dispatch it back',
  },
  in_transit_return: {
    label: 'Dispatched — in transit back', short: 'In transit back', tone: 'teal', order: 6,
    waitingOn: 'the field engineer to confirm it arrived',
  },
  closed: {
    label: 'Closed — received back', short: 'Closed', tone: 'ink', order: 7,
    waitingOn: 'nobody',
  },
}

export const STATUS_ORDER = (Object.keys(STATUS) as TicketStatus[])
  .sort((a, b) => STATUS[a].order - STATUS[b].order)

export const OPEN_STATUSES = STATUS_ORDER.filter(s => s !== 'closed')

/** Badge colours per tone, light and dark both — the tokens flip underneath. */
export const TONE_CLASS: Record<Tone, string> = {
  amber: 'bg-amber-100 text-amber-900',
  violet: 'bg-violet-100 text-violet-900',
  sky: 'bg-sky-100 text-sky-900',
  indigo: 'bg-indigo-100 text-indigo-900',
  emerald: 'bg-emerald-100 text-emerald-900',
  teal: 'bg-teal-100 text-teal-900',
  ink: 'bg-ink-100 text-ink-700',
}

/** Chart fills, in the same order of meaning as the badges. */
export const TONE_FILL: Record<Tone, string> = {
  amber: '#d97706',
  violet: '#7c3aed',
  sky: '#0284c7',
  indigo: '#4f46e5',
  emerald: '#059669',
  teal: '#0d9488',
  ink: '#6b7280',
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
}

/** A coordinator or manager of that lab: the desk. */
export function runsTrc(me: Me | null | undefined, trcId: string): boolean {
  return !!me && (me.is_coordinator || me.is_manager) && me.trc_ids.includes(trcId)
}

export type Action =
  | 'accept' | 'assign' | 'start' | 'return' | 'complete'
  | 'dispatch' | 'transfer' | 'received'

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
  if (mine && t.status === 'assigned') out.push('start')
  if (mine && t.status === 'in_repair') out.push('complete')
  if (desk && (t.status === 'accepted' || t.status === 'assigned')) out.push('assign')
  if (desk && t.status === 'repaired') out.push('dispatch')
  if ((desk || t.stakeholder_id === me.employee_id) && t.status === 'in_transit_return') out.push('received')
  if (mine && (t.status === 'assigned' || t.status === 'in_repair')) out.push('return')
  if (desk && (t.status === 'accepted' || t.status === 'assigned' || t.status === 'in_repair')) out.push('transfer')

  return out
}

/** Whether a ticket is waiting on this person specifically, for "My queue". */
export function waitingOnMe(t: TicketLike, me: Me | null | undefined): boolean {
  return actionsFor(t, me).some(a => a !== 'transfer' && a !== 'return')
}
