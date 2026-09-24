/*
  A manager's view of their team's spares (rl_0029), and the reports a Revive
  Lab's desk reads on its dashboard — the numbers both pages show, worked out
  here, where they can be tested, rather than inside the pages.

  The user, 23 Sep: "a beautiful dashboard with everything explained and
  brief data"; and for a Revive Lab manager "engineer-wise report, TAT, A/B/C
  category report with engineers — all should be easily understandable".
*/
import { categoryTat } from './tat'
import { CATEGORY_TAT_DAYS, type SpareCategory, type TicketStatus, type Tone } from './tickets'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/* ------------------------------------------------------------------ */
/* The team                                                             */
/* ------------------------------------------------------------------ */

export interface TeamPerson {
  id: string
  name: string
  ecode: string
  designation: string | null
  manager_id: string | null
  /** Left the company: still in the tree, so their open ticket still has a team, but not counted as a person. */
  active: boolean
}

/** What revive_my_team() returns: everyone under the viewer, and whose each ticket is. */
export interface MyTeam {
  people: TeamPerson[]
  tickets: Array<{ ticket_id: string; person_id: string }>
}

export interface TeamIndex {
  byId: Map<string, TeamPerson>
  /** Who reports to whom, among the viewer's people; the viewer's own reports are under their id. */
  reports: Map<string, TeamPerson[]>
  /** The person under the viewer each ticket belongs to. */
  ownerOf: Map<string, string>
}

export function indexTeam(team: MyTeam | null | undefined): TeamIndex {
  const byId = new Map<string, TeamPerson>()
  const reports = new Map<string, TeamPerson[]>()
  for (const p of team?.people ?? []) {
    byId.set(p.id, p)
    if (!p.manager_id) continue
    const list = reports.get(p.manager_id) ?? []
    list.push(p)
    reports.set(p.manager_id, list)
  }
  const ownerOf = new Map((team?.tickets ?? []).map(x => [x.ticket_id, x.person_id]))
  return { byId, reports, ownerOf }
}

/**
 * Which of `focus`'s own reports `personId` sits under — the team a row on
 * the page stands for. The focus's own report is their own team. Null when
 * the person is not under the focus at all, or is the focus.
 */
export function branchOf(ix: TeamIndex, personId: string, focusId: string): string | null {
  let cur: string | null = personId
  // Bounded like the database's walk: a reporting line pointing back at
  // itself must end rather than spin.
  for (let i = 0; cur && i < 20; i++) {
    const p = ix.byId.get(cur)
    if (!p) return null
    if (p.manager_id === focusId) return p.id
    cur = p.manager_id
  }
  return null
}

/**
 * Whose team a ticket counts for: the person the database named (after a
 * transfer out of the team, the last one in it who held it), or else its
 * field engineer when they are one of the viewer's people — so a ticket
 * raised a minute ago counts before the team is fetched again.
 */
export function ownerOfTicket(ix: TeamIndex, t: { id: string; stakeholder_id: string }): string | null {
  return ix.ownerOf.get(t.id) ?? (ix.byId.has(t.stakeholder_id) ? t.stakeholder_id : null)
}

/** Whether a person is the focus, or anywhere under them. The viewer is above everyone in the index. */
export function inTeamOf(ix: TeamIndex, personId: string, focusId: string, viewerId: string): boolean {
  if (focusId === viewerId) return ix.byId.has(personId)
  return personId === focusId || branchOf(ix, personId, focusId) !== null
}

/** The line from the viewer down to a person — their report first, the person last — for the way back up. */
export function pathTo(ix: TeamIndex, personId: string): TeamPerson[] {
  const out: TeamPerson[] = []
  let cur: string | null = personId
  for (let i = 0; cur && i < 20; i++) {
    const p = ix.byId.get(cur)
    if (!p) break
    out.unshift(p)
    cur = p.manager_id
  }
  return out
}

/** How many people, still with the company, are under someone — not counting them. */
export function headcount(ix: TeamIndex, id: string): number {
  let n = 0
  const seen = new Set<string>()
  const walk = (m: string) => {
    for (const p of ix.reports.get(m) ?? []) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      if (p.active) n++
      walk(p.id)
    }
  }
  walk(id)
  return n
}

/* ------------------------------------------------------------------ */
/* Where a spare is, in words anybody reads                             */
/* ------------------------------------------------------------------ */

export interface Stage {
  key: 'sent' | 'waiting' | 'repair' | 'dispatch' | 'transit' | 'back'
  label: string
  /** What it counts, in a line. */
  hint: string
  tone: Tone
  statuses: readonly TicketStatus[]
}

/**
 * Seventeen statuses as the six places a spare can be, in the order it goes
 * through them. Each in the colour of its main status, so the bar and the
 * ticket badges agree.
 */
export const STAGES: readonly Stage[] = [
  {
    key: 'sent', label: 'Not yet accepted', tone: 'red',
    hint: 'sent in, or waiting for approval to go to another Revive Lab',
    statuses: ['awaiting_approval', 'approved', 'not_approved', 'pending_acceptance', 'transferred'],
  },
  {
    key: 'waiting', label: 'Waiting for an engineer', tone: 'amber',
    hint: 'accepted, no Revive Lab engineer yet',
    statuses: ['accepted'],
  },
  {
    key: 'repair', label: 'Being repaired', tone: 'indigo',
    hint: 'with a Revive Lab engineer, or waiting for a component',
    statuses: ['assigned', 'in_repair', 'parts_requested', 'parts_ordered', 'parts_ready'],
  },
  {
    key: 'dispatch', label: 'To be sent back', tone: 'lime',
    hint: 'the repair is finished, not dispatched yet',
    statuses: ['repaired', 'not_repairable', 'service_denied'],
  },
  {
    key: 'transit', label: 'On the way back', tone: 'teal',
    hint: 'dispatched, with the courier',
    statuses: ['in_transit_return'],
  },
  {
    key: 'back', label: 'Back with the field engineer', tone: 'blue',
    hint: 'received, to be fitted and closed',
    statuses: ['received_back'],
  },
]

export const stageOf = (s: TicketStatus): Stage | null => STAGES.find(x => x.statuses.includes(s)) ?? null

/** Enough of a ticket for these numbers. */
export interface ReportTicket {
  id: string
  code: string
  status: TicketStatus
  created_at: string
  closed_at: string | null
  closure: string | null
  trc_id: string
  trc_name: string
  stakeholder_id: string
  stakeholder_name: string
  engineer_id: string | null
  engineer_name: string | null
  spare_category: SpareCategory | null
  accepted_at: string | null
  dispatched_at: string | null
  scrapped_at: string | null
}

/** Past its category's repair time and still at the Revive Lab (rl_0024: A 3 days, B 2, C 1, from acceptance). */
export function isLate(t: ReportTicket, now = Date.now()): boolean {
  if (t.status === 'closed') return false
  const tat = categoryTat(t, now)
  return !!tat && tat.exceeded && tat.endedAt === null
}

/**
 * Who has the next move, in a few words — for a manager reading down a list
 * of their team's spares, the one question the status alone does not answer.
 */
export function nextMove(t: ReportTicket): string {
  const lab = t.trc_name
  const eng = t.engineer_name ?? 'the Revive Lab engineer'
  switch (t.status) {
    case 'awaiting_approval': return 'A Revive Lab admin, to approve'
    case 'not_approved': return `${t.stakeholder_name}, to send it elsewhere or discard it`
    case 'approved': return 'To be sent on, now approved'
    case 'pending_acceptance':
    case 'transferred': return `${lab}, to accept it`
    case 'accepted': return `${lab}, to assign an engineer`
    case 'assigned': return `${eng}, to start the repair`
    case 'in_repair': return `${eng}, to finish the repair`
    case 'parts_requested': return `${lab} coordinator, for a component`
    case 'parts_ordered': return 'Purchase, buying a component'
    case 'parts_ready': return `${eng}, the component is ready`
    case 'repaired':
    case 'not_repairable':
    case 'service_denied': return `${lab}, to dispatch it`
    case 'in_transit_return': return `${t.stakeholder_name}, to receive it`
    case 'received_back': return `${t.stakeholder_name}, to fit it and close`
    case 'closed': return 'Nobody — closed'
  }
}

/** How long an open ticket has been open: "3d 4h", "5h" — the first unit is the one read. */
export function openFor(t: Pick<ReportTicket, 'created_at'>, now = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(t.created_at))
  const d = Math.floor(ms / DAY)
  const h = Math.floor((ms % DAY) / HOUR)
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  return h > 0 ? `${h}h` : 'under an hour'
}

/* ------------------------------------------------------------------ */
/* A set of tickets, counted                                            */
/* ------------------------------------------------------------------ */

export interface TeamCounts {
  open: number
  late: number
  /** Open tickets in each stage, in STAGES order. */
  byStage: Record<Stage['key'], number>
  closedThisMonth: number
  /** The oldest open one, for "oldest open". */
  oldest: ReportTicket | null
}

export function countTickets(list: readonly ReportTicket[], now = Date.now()): TeamCounts {
  const byStage = Object.fromEntries(STAGES.map(s => [s.key, 0])) as Record<Stage['key'], number>
  const d = new Date(now)
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  let open = 0, late = 0, closedThisMonth = 0
  let oldest: ReportTicket | null = null
  for (const t of list) {
    if (t.status === 'closed') {
      // A discarded ticket never went anywhere, so it is not a spare closed.
      if (t.closure !== 'discarded' && t.closed_at && Date.parse(t.closed_at) >= monthStart) closedThisMonth++
      continue
    }
    open++
    if (isLate(t, now)) late++
    const st = stageOf(t.status)
    if (st) byStage[st.key]++
    if (!oldest || Date.parse(t.created_at) < Date.parse(oldest.created_at)) oldest = t
  }
  return { open, late, byStage, closedThisMonth, oldest }
}

/* ------------------------------------------------------------------ */
/* Periods                                                              */
/* ------------------------------------------------------------------ */

/**
 * The period a figure about what happened covers: a calendar month, or
 * everything. Never a rolling "last 30 days" — nobody reads a report that
 * way (the user, 23 Sep: "what is this 30 and 90? why you always come with
 * it?"). What is true now — open, late, with them — needs no period.
 */
export type Period = 'month' | 'last_month' | 'all'

export const PERIODS: ReadonlyArray<{ id: Period; label: string; words: string }> = [
  { id: 'month', label: 'This month', words: 'this month' },
  { id: 'last_month', label: 'Last month', words: 'last month' },
  { id: 'all', label: 'All time', words: 'so far' },
]

export interface Range { from: number; to: number }

/** From the 1st of this month, the month before it, or all of time. */
export function periodRange(p: Period, now = Date.now()): Range {
  if (p === 'all') return { from: -Infinity, to: Infinity }
  const d = new Date(now)
  const thisMonth = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  if (p === 'month') return { from: thisMonth, to: Infinity }
  return { from: new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(), to: thisMonth }
}

export const inRange = (ms: number, r: Range) => ms >= r.from && ms < r.to

/* ------------------------------------------------------------------ */
/* The Revive Lab's own reports                                         */
/* ------------------------------------------------------------------ */

const REPAIRING_NOW: readonly TicketStatus[] = ['assigned', 'in_repair', 'parts_requested', 'parts_ordered', 'parts_ready']
/** The statuses a Revive Lab engineer closes a repair with. */
const REPAIR_CLOSED = ['repaired', 'not_repairable', 'service_denied']

/**
 * When this round of the repair was assigned, and when the engineer closed
 * it — from the ticket's status history (only status steps). Assigned is the
 * start of the latest run of "assigned", so an estimate or a reassignment
 * inside it does not restart the clock; a spare sent back and assigned again
 * starts a new round.
 */
export function repairWindow(events: ReadonlyArray<{ status: string; at: string }>): { assignedAt: number | null; closedAt: number | null } {
  let assignedAt: number | null = null
  let closedAt: number | null = null
  let prev: string | null = null
  for (const e of [...events].sort((x, y) => Date.parse(x.at) - Date.parse(y.at))) {
    if (e.status === 'assigned' && prev !== 'assigned') {
      // A new round once the last one was closed; the first assignment otherwise.
      if (assignedAt === null || closedAt !== null) { assignedAt = Date.parse(e.at); closedAt = null }
    } else if (REPAIR_CLOSED.includes(e.status) && assignedAt !== null && closedAt === null) {
      closedAt = Date.parse(e.at)
    }
    prev = e.status
  }
  return { assignedAt, closedAt }
}

export interface EngineerWork {
  id: string
  name: string
  /** Closed in the period, and open now. */
  total: number
  /** Repairs they closed in the period: repaired, not repairable, or the customer denied it. */
  closed: number
  /** With them now: assigned, in repair, or waiting for a component. */
  open: number
  /** Closed less assigned, averaged over the closed. */
  avgClosureMs: number | null
  /** Today less assigned, averaged over the open. */
  avgOpenMs: number | null
  /** The same, by category. */
  byCategory: Record<SpareCategory, { total: number; open: number }>
}

/**
 * One row per Revive Lab engineer (the user, 24 Sep): total tickets, closed,
 * closed %, the average closure TAT, open, and the average open TAT. Closed
 * counts the period chosen; open is now, whenever it was assigned. Engineers
 * named in `roster` appear with nothing too — an idle engineer is the one to
 * give the next repair to.
 */
export function engineerWork(
  list: readonly ReportTicket[],
  eventsOf: (ticketId: string) => ReadonlyArray<{ status: string; at: string }>,
  roster: ReadonlyArray<{ id: string; name: string }> = [],
  now = Date.now(),
  period: Range = { from: -Infinity, to: Infinity },
): EngineerWork[] {
  const rows = new Map<string, EngineerWork & { closure: number[]; age: number[] }>()
  const row = (id: string, name: string) => {
    let r = rows.get(id)
    if (!r) {
      r = {
        id, name, total: 0, closed: 0, open: 0, avgClosureMs: null, avgOpenMs: null,
        byCategory: { A: { total: 0, open: 0 }, B: { total: 0, open: 0 }, C: { total: 0, open: 0 } },
        closure: [], age: [],
      }
      rows.set(id, r)
    }
    return r
  }
  for (const p of roster) row(p.id, p.name)
  for (const t of list) {
    if (!t.engineer_id) continue
    const r = row(t.engineer_id, t.engineer_name ?? 'Engineer')
    const { assignedAt, closedAt } = repairWindow(eventsOf(t.id))
    const cat = t.spare_category
    if (REPAIRING_NOW.includes(t.status)) {
      r.open++
      r.total++
      if (assignedAt !== null) r.age.push(now - assignedAt)
      if (cat) { r.byCategory[cat].open++; r.byCategory[cat].total++ }
    } else if (closedAt !== null && inRange(closedAt, period)) {
      r.closed++
      r.total++
      if (assignedAt !== null) r.closure.push(closedAt - assignedAt)
      if (cat) r.byCategory[cat].total++
    }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null)
  return [...rows.values()]
    .map(({ closure, age, ...r }) => ({ ...r, avgClosureMs: mean(closure), avgOpenMs: mean(age) }))
    // The busiest first, then by name.
    .sort((a, b) => b.open - a.open || b.total - a.total || a.name.localeCompare(b.name))
}

export interface CategoryRow {
  category: SpareCategory
  days: number
  /** Accepted, not dispatched: on the Revive Lab's clock now — inside its time, or above it. */
  atLab: number
  inTat: number
  aboveTat: number
}

/** A, B and C: how many are on the Revive Lab's clock now, in TAT and above it. */
export function categoryReport(list: readonly ReportTicket[], now = Date.now()): CategoryRow[] {
  const rows = (['A', 'B', 'C'] as const).map(category => ({
    category, days: CATEGORY_TAT_DAYS[category], atLab: 0, inTat: 0, aboveTat: 0,
  }))
  for (const t of list) {
    if (t.status === 'closed' && !t.dispatched_at && !t.scrapped_at) continue
    const tat = categoryTat(t, now)
    // Not accepted yet: no category, and no clock running.
    if (!t.spare_category || !tat) continue
    const r = rows.find(x => x.category === t.spare_category)!
    if (tat.endedAt !== null || t.status === 'closed') continue
    r.atLab++
    if (tat.exceeded) r.aboveTat++
    else r.inTat++
  }
  return rows
}

/** "92%" of a whole, or a dash when there is none. */
export const percent = (part: number, whole: number): string => (whole ? `${Math.round((part / whole) * 100)}%` : '—')
