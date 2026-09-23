/**
 * How long a spare spent at each stage, per Revive Lab and in total.
 *
 * Built from the event trail and nothing else. Every status a ticket has
 * ever entered is a row with its own timestamp, written by the same
 * function that changed the status — so these figures cannot drift from
 * what happened, and a stage that has not finished yet is measured up to
 * now and says so.
 *
 * A LEG is one Revive Lab's hold on the ticket. The first starts when it is
 * raised; a transfer ends one leg and starts the next at the Revive Lab it went
 * to, from the moment it was sent — so the courier time between Revive Labs
 * counts towards reaching the second one, which is where anybody waiting
 * for the spare would put it. A spare the field engineer fitted and sent
 * back not working starts a leg the same way, at the same Revive Lab (rl_0027).
 *
 * Per leg:
 *   reach     leg start → the coordinator accepts it
 *   assign    accepted → given to an engineer
 *   repair    the engineer accepts it → repair closed (or → transferred,
 *             when the Revive Lab gave up part way — that was still repair time),
 *             less the time spent waiting for components
 *   parts     waiting for components: requested, being bought, ready and
 *             not yet confirmed. Kept apart from repair, because the engineer
 *             cannot hurry a purchase (rl_0013)
 *   dispatch  repair closed → the field engineer has it back, or it was
 *             moved to scrap (the last leg only). What they then take to fit
 *             it and close the ticket is theirs, not the Revive Lab's
 *   approval  waiting to go to another Revive Lab: for the Regional Revive
 *             Lab admins to decide, then for whoever asked to send it (rl_0014).
 *             Kept out of every stage above — none of them could move — and
 *             reported on its own
 *
 * A repair closes as repaired, not repairable or denied by the customer;
 * any of the three ends the repair stage.
 *
 * The ticket's own figures add the legs up, and its total runs from the
 * moment it was raised to the moment the field engineer had it back.
 */

export interface TatEvent {
  status: string
  trc_id: string | null
  at: string
}

export interface Span {
  /** Milliseconds, or null when the stage has not begun. */
  ms: number | null
  /** Still going: measured up to now. */
  running: boolean
}

export interface Leg {
  trcId: string | null
  startedAt: string
  endedAt: string | null
  /** returned: back with the field engineer, who sent it back not working — the next leg is the same Revive Lab again (rl_0027). */
  endedBy: 'transfer' | 'closed' | 'returned' | null
  reach: Span
  assign: Span
  repair: Span
  parts: Span
  dispatch: Span
  approval: Span
  total: Span
}

export interface TatBreakdown {
  legs: Leg[]
  reach: Span
  assign: Span
  repair: Span
  parts: Span
  dispatch: Span
  approval: Span
  total: Span
}

/** The statuses that end a repair. */
const REPAIR_END = ['repaired', 'not_repairable', 'service_denied']
/** The statuses of a repair waiting on a component. */
const WAITING_FOR_PARTS = ['parts_requested', 'parts_ordered', 'parts_ready']
/** Waiting on approval to go to another Revive Lab, and on it being sent once decided. */
const WAITING_FOR_APPROVAL = ['awaiting_approval', 'approved', 'not_approved']

const NONE: Span = { ms: null, running: false }

const t = (iso: string) => Date.parse(iso)

/** From one instant to the next, or to now while the second has not happened. */
function span(from: string | undefined, to: string | undefined, end: string | null, now: number): Span {
  if (!from) return NONE
  if (to) return { ms: Math.max(0, t(to) - t(from)), running: false }
  if (end) return { ms: Math.max(0, t(end) - t(from)), running: false }
  return { ms: Math.max(0, now - t(from)), running: true }
}

/**
 * A stage less the stretches inside it that belong to something else. The
 * stage ran from `from` for `s.ms`; whatever of that fell inside a hold was
 * not that stage's time, and while a hold is still on, the stage is not
 * what is running.
 */
function less(s: Span, from: string | undefined, holds: ReadonlyArray<[number, number]>, heldNow: boolean): Span {
  if (s.ms === null || !from || holds.length === 0) return s
  const a = t(from)
  const b = a + s.ms
  const inside = holds.reduce((sum, [x, y]) => sum + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0)
  return { ms: Math.max(0, s.ms - inside), running: s.running && !heldNow }
}

/** Adds spans that have begun; running if any of them still is. */
function sum(spans: Span[]): Span {
  const begun = spans.filter(s => s.ms !== null)
  if (begun.length === 0) return NONE
  return {
    ms: begun.reduce((a, s) => a + (s.ms ?? 0), 0),
    running: begun.some(s => s.running),
  }
}

export function ticketTat(
  events: TatEvent[],
  currentTrcId: string | null,
  now: number = Date.now(),
): TatBreakdown {
  const sorted = [...events].sort((a, b) => t(a.at) - t(b.at))
  if (sorted.length === 0) {
    return { legs: [], reach: NONE, assign: NONE, repair: NONE, parts: NONE, dispatch: NONE, approval: NONE, total: NONE }
  }

  // Cut the trail into legs at every transfer, and wherever the field
  // engineer sent it back not working (rl_0027): that leg ended when they
  // had it back, and the next starts when it went — at the same Revive Lab,
  // the courier time again counting towards reaching it.
  type Chunk = { trcId: string | null; start: string; events: TatEvent[]; end: TatEvent | null; returned: boolean }
  const chunks: Chunk[] = []
  let current: Chunk = { trcId: sorted[0].trc_id, start: sorted[0].at, events: [], end: null, returned: false }
  sorted.forEach((ev, i) => {
    if (ev.status === 'pending_acceptance' && current.events.some(e => e.status === 'received_back')) {
      chunks.push({ ...current, returned: true })
      current = { trcId: ev.trc_id ?? current.trcId, start: ev.at, events: [ev], end: null, returned: false }
      return
    }
    if (ev.status !== 'transferred') {
      current.events.push(ev)
      return
    }
    current.end = ev
    chunks.push(current)
    // The next Revive Lab's id is on the first event recorded there. Until one
    // exists the spare is still in the courier's hands, headed for the
    // ticket's own current Revive Lab.
    const next = sorted.slice(i + 1).find(x => x.status !== 'transferred')
    current = { trcId: next?.trc_id ?? currentTrcId, start: ev.at, events: [], end: null, returned: false }
  })
  chunks.push(current)

  const legs: Leg[] = chunks.map(ch => {
    const first = (status: string) => ch.events.find(e => e.status === status)?.at
    // Back in the field engineer's hands ends the journey; closing the
    // ticket after fitting it is a note, not a stage.
    const closedAt = first('received_back') ?? first('closed')
    const end = ch.end?.at ?? closedAt ?? null
    const accepted = first('accepted')
    const assigned = first('assigned')
    const inRepair = first('in_repair')
    const repaired = ch.events.find(e => REPAIR_END.includes(e.status))?.at
    const transferEnd = ch.end ? ch.end.at : null

    // Every stretch waiting on approval, up to the next move.
    const holds: Array<[number, number]> = []
    let heldNow = false
    ch.events.forEach((e, i) => {
      if (!WAITING_FOR_APPROVAL.includes(e.status)) return
      const until = ch.events[i + 1]?.at ?? transferEnd ?? closedAt
      if (until) holds.push([t(e.at), t(until)])
      else { holds.push([t(e.at), now]); heldNow = true }
    })
    const approvalMs = holds.reduce((sum, [x, y]) => sum + Math.max(0, y - x), 0)
    // A raise that waited for approval starts reaching its Revive Lab when it
    // is sent — and one discarded, or not sent yet, has not started at all.
    const sent = ch.events.find(e => !WAITING_FOR_APPROVAL.includes(e.status))
    const reachFrom = ch.events.length > 0 && WAITING_FOR_APPROVAL.includes(ch.events[0].status)
      ? (sent && sent.status !== 'closed' ? sent.at : undefined)
      : ch.start

    // Every stretch spent waiting for a component, up to the next move.
    let partsMs = 0
    let partsRunning = false
    ch.events.forEach((e, i) => {
      if (!WAITING_FOR_PARTS.includes(e.status)) return
      const until = ch.events[i + 1]?.at ?? transferEnd
      if (until) partsMs += Math.max(0, t(until) - t(e.at))
      else { partsMs += Math.max(0, now - t(e.at)); partsRunning = true }
    })
    const whole = less(span(inRepair, repaired, transferEnd, now), inRepair, holds, heldNow)
    const repair: Span = whole.ms === null
      ? whole
      // Paused while it waits: the repair is not what is running.
      : { ms: Math.max(0, whole.ms - partsMs), running: whole.running && !partsRunning }

    return {
      trcId: ch.trcId,
      startedAt: ch.start,
      endedAt: end,
      endedBy: ch.end ? 'transfer' : ch.returned ? 'returned' : closedAt ? 'closed' : null,
      // To the end of the leg when the next move never came: a ticket
      // discarded before any Revive Lab had it did not keep reaching one.
      reach: less(span(reachFrom, accepted, end, now), reachFrom, holds, heldNow),
      assign: less(span(accepted, assigned, end, now), accepted, holds, heldNow),
      repair,
      parts: partsMs > 0 || partsRunning ? { ms: partsMs, running: partsRunning } : NONE,
      dispatch: ch.end ? NONE : span(repaired, closedAt, null, now),
      approval: holds.length ? { ms: approvalMs, running: heldNow } : NONE,
      total: span(ch.start, end ?? undefined, null, now),
    }
  })

  const raised = sorted[0].at
  // Until the field engineer last had it back: one sent back is not done until it comes back again.
  const last = legs[legs.length - 1]
  const closed = last.endedBy === 'closed' ? last.endedAt ?? undefined : undefined

  return {
    legs,
    reach: sum(legs.map(l => l.reach)),
    assign: sum(legs.map(l => l.assign)),
    repair: sum(legs.map(l => l.repair)),
    parts: sum(legs.map(l => l.parts)),
    dispatch: sum(legs.map(l => l.dispatch)),
    approval: sum(legs.map(l => l.approval)),
    total: span(raised, closed, null, now),
  }
}

import { CATEGORY_TAT_DAYS, type SpareCategory } from './tickets'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/**
 * "3d 4h", "5h 20m", "12m", "under a minute".
 *
 * Two units at most. A repair that took four days is not made clearer by
 * its minutes, and a column of these is read by its first number.
 */
export function formatSpan(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < MIN) return 'under a minute'
  const d = Math.floor(ms / DAY)
  const h = Math.floor((ms % DAY) / HOUR)
  const m = Math.floor((ms % HOUR) / MIN)
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

/**
 * The Revive Lab's TAT for the spare's category (rl_0024): A 3 days, B 2,
 * C 1, from when it was accepted until it was dispatched back — or moved
 * to scrap. Null until there is a category and an acceptance to count from.
 */
export interface CategoryTat {
  days: number
  dueAt: number
  /** When the Revive Lab let go of it; null while it still has it. */
  endedAt: number | null
  exceeded: boolean
  /** Past the due time when positive, still left when negative — at the end, or now. */
  overMs: number
}

export function categoryTat(
  t: {
    spare_category?: SpareCategory | null
    accepted_at?: string | null
    dispatched_at?: string | null
    scrapped_at?: string | null
  },
  now = Date.now(),
): CategoryTat | null {
  if (!t.spare_category || !t.accepted_at) return null
  const days = CATEGORY_TAT_DAYS[t.spare_category]
  const dueAt = Date.parse(t.accepted_at) + days * DAY
  const endedAt = t.dispatched_at ? Date.parse(t.dispatched_at) : t.scrapped_at ? Date.parse(t.scrapped_at) : null
  const at = endedAt ?? now
  return { days, dueAt, endedAt, exceeded: at > dueAt, overMs: at - dueAt }
}

/** Days, to one decimal place, for charts. */
export const asDays = (ms: number | null | undefined): number | null =>
  ms === null || ms === undefined ? null : Math.round((ms / DAY) * 10) / 10
