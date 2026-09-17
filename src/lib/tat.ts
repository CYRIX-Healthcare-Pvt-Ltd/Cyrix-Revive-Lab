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
 * for the spare would put it.
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
 *   dispatch  repair closed → received back, or moved to scrap (the last leg only)
 *
 * A repair closes as repaired, not repairable or denied by the customer;
 * any of the three ends the repair stage.
 *
 * The ticket's own figures add the legs up, and its total runs from the
 * moment it was raised to the moment it was received back.
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
  endedBy: 'transfer' | 'closed' | null
  reach: Span
  assign: Span
  repair: Span
  parts: Span
  dispatch: Span
  total: Span
}

export interface TatBreakdown {
  legs: Leg[]
  reach: Span
  assign: Span
  repair: Span
  parts: Span
  dispatch: Span
  total: Span
}

/** The statuses that end a repair. */
const REPAIR_END = ['repaired', 'not_repairable', 'service_denied']
/** The statuses of a repair waiting on a component. */
const WAITING_FOR_PARTS = ['parts_requested', 'parts_ordered', 'parts_ready']

const NONE: Span = { ms: null, running: false }

const t = (iso: string) => Date.parse(iso)

/** From one instant to the next, or to now while the second has not happened. */
function span(from: string | undefined, to: string | undefined, end: string | null, now: number): Span {
  if (!from) return NONE
  if (to) return { ms: Math.max(0, t(to) - t(from)), running: false }
  if (end) return { ms: Math.max(0, t(end) - t(from)), running: false }
  return { ms: Math.max(0, now - t(from)), running: true }
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
    return { legs: [], reach: NONE, assign: NONE, repair: NONE, parts: NONE, dispatch: NONE, total: NONE }
  }

  // Cut the trail into legs at every transfer.
  const chunks: { trcId: string | null; start: string; events: TatEvent[]; end: TatEvent | null }[] = []
  let current = { trcId: sorted[0].trc_id, start: sorted[0].at, events: [] as TatEvent[], end: null as TatEvent | null }
  sorted.forEach((ev, i) => {
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
    current = { trcId: next?.trc_id ?? currentTrcId, start: ev.at, events: [], end: null }
  })
  chunks.push(current)

  const legs: Leg[] = chunks.map(ch => {
    const first = (status: string) => ch.events.find(e => e.status === status)?.at
    const closedAt = first('closed')
    const end = ch.end?.at ?? closedAt ?? null
    const accepted = first('accepted')
    const assigned = first('assigned')
    const inRepair = first('in_repair')
    const repaired = ch.events.find(e => REPAIR_END.includes(e.status))?.at
    const transferEnd = ch.end ? ch.end.at : null

    // Every stretch spent waiting for a component, up to the next move.
    let partsMs = 0
    let partsRunning = false
    ch.events.forEach((e, i) => {
      if (!WAITING_FOR_PARTS.includes(e.status)) return
      const until = ch.events[i + 1]?.at ?? transferEnd
      if (until) partsMs += Math.max(0, t(until) - t(e.at))
      else { partsMs += Math.max(0, now - t(e.at)); partsRunning = true }
    })
    const whole = span(inRepair, repaired, transferEnd, now)
    const repair: Span = whole.ms === null
      ? whole
      // Paused while it waits: the repair is not what is running.
      : { ms: Math.max(0, whole.ms - partsMs), running: whole.running && !partsRunning }

    return {
      trcId: ch.trcId,
      startedAt: ch.start,
      endedAt: end,
      endedBy: ch.end ? 'transfer' : closedAt ? 'closed' : null,
      reach: span(ch.start, accepted, transferEnd, now),
      assign: span(accepted, assigned, transferEnd, now),
      repair,
      parts: partsMs > 0 || partsRunning ? { ms: partsMs, running: partsRunning } : NONE,
      dispatch: ch.end ? NONE : span(repaired, closedAt, null, now),
      total: span(ch.start, end ?? undefined, null, now),
    }
  })

  const raised = sorted[0].at
  const closed = sorted.find(e => e.status === 'closed')?.at

  return {
    legs,
    reach: sum(legs.map(l => l.reach)),
    assign: sum(legs.map(l => l.assign)),
    repair: sum(legs.map(l => l.repair)),
    parts: sum(legs.map(l => l.parts)),
    dispatch: sum(legs.map(l => l.dispatch)),
    total: span(raised, closed, null, now),
  }
}

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

/** Days, to one decimal place, for charts. */
export const asDays = (ms: number | null | undefined): number | null =>
  ms === null || ms === undefined ? null : Math.round((ms / DAY) * 10) / 10
