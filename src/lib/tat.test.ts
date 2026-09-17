import { describe, it, expect } from 'vitest'
import { ticketTat, formatSpan, asDays, type TatEvent } from './tat'

const H = 3_600_000
const D = 24 * H
const T0 = Date.parse('2026-09-01T09:00:00Z')
const at = (ms: number) => new Date(T0 + ms).toISOString()
const ev = (status: string, ms: number, trc = 'A'): TatEvent => ({ status, trc_id: trc, at: at(ms) })

describe('ticketTat — one Revive Lab, start to finish', () => {
  const trail = [
    ev('pending_acceptance', 0),
    ev('accepted', 2 * D),          // 2 days to reach the Revive Lab
    ev('assigned', 2 * D + 4 * H),  // 4 hours to assignment
    ev('in_repair', 3 * D),
    ev('repaired', 5 * D),          // 2 days of repair
    ev('in_transit_return', 5 * D + 2 * H),
    ev('closed', 8 * D),            // 3 days from repaired to received
  ]
  const tat = ticketTat(trail, 'A', T0 + 20 * D)

  it('measures each stage', () => {
    expect(tat.reach).toEqual({ ms: 2 * D, running: false })
    expect(tat.assign).toEqual({ ms: 4 * H, running: false })
    expect(tat.repair).toEqual({ ms: 2 * D, running: false })
    expect(tat.dispatch).toEqual({ ms: 3 * D, running: false })
  })

  it('runs the total from raised to received back', () => {
    expect(tat.total).toEqual({ ms: 8 * D, running: false })
  })

  it('has one leg that ends closed', () => {
    expect(tat.legs).toHaveLength(1)
    expect(tat.legs[0]).toMatchObject({ trcId: 'A', endedBy: 'closed' })
  })
})

describe('ticketTat — a stage still going is measured to now', () => {
  it('says the repair is running', () => {
    const now = T0 + 6 * D
    const tat = ticketTat([
      ev('pending_acceptance', 0), ev('accepted', D), ev('assigned', D), ev('in_repair', 2 * D),
    ], 'A', now)
    expect(tat.repair).toEqual({ ms: 4 * D, running: true })
    expect(tat.dispatch).toEqual({ ms: null, running: false })
    expect(tat.total).toEqual({ ms: 6 * D, running: true })
  })

  it('has nothing to say about a ticket with no trail', () => {
    expect(ticketTat([], null).total).toEqual({ ms: null, running: false })
  })
})

describe('ticketTat — transferred between Revive Labs', () => {
  const trail = [
    ev('pending_acceptance', 0, 'A'),
    ev('accepted', D, 'A'),
    ev('assigned', D + 2 * H, 'A'),
    ev('in_repair', 2 * D, 'A'),
    ev('transferred', 3 * D, 'A'),   // gave up after a day of repair
    ev('accepted', 5 * D, 'B'),      // 2 days in the courier + acceptance at B
    ev('assigned', 5 * D + H, 'B'),
    ev('in_repair', 6 * D, 'B'),
    ev('repaired', 7 * D, 'B'),
    ev('in_transit_return', 7 * D + H, 'B'),
    ev('closed', 9 * D, 'B'),
  ]
  const tat = ticketTat(trail, 'B', T0 + 30 * D)

  it('splits into one leg per Revive Lab', () => {
    expect(tat.legs.map(l => [l.trcId, l.endedBy])).toEqual([['A', 'transfer'], ['B', 'closed']])
  })

  it('counts the time a Revive Lab spent before giving up as repair', () => {
    expect(tat.legs[0].repair).toEqual({ ms: D, running: false })
    expect(tat.legs[0].total).toEqual({ ms: 3 * D, running: false })
  })

  it('starts the second leg when the spare was sent, so transit counts towards reaching it', () => {
    expect(tat.legs[1].startedAt).toBe(at(3 * D))
    expect(tat.legs[1].reach).toEqual({ ms: 2 * D, running: false })
  })

  it('gives dispatch only to the last leg', () => {
    expect(tat.legs[0].dispatch.ms).toBeNull()
    expect(tat.legs[1].dispatch).toEqual({ ms: 2 * D, running: false })
  })

  it('adds the legs for the ticket, and keeps one end-to-end total', () => {
    expect(tat.reach.ms).toBe(D + 2 * D)
    expect(tat.repair.ms).toBe(D + D)
    expect(tat.total).toEqual({ ms: 9 * D, running: false })
  })

  it('knows where a spare in the courier is headed before anybody there has touched it', () => {
    const moving = ticketTat(trail.slice(0, 5), 'B', T0 + 4 * D)
    expect(moving.legs[1]).toMatchObject({ trcId: 'B', endedBy: null })
    expect(moving.legs[1].reach).toEqual({ ms: D, running: true })
  })
})

describe('formatSpan', () => {
  it('says two units at most', () => {
    expect(formatSpan(3 * D + 4 * H + 25 * 60_000)).toBe('3d 4h')
    expect(formatSpan(5 * H + 20 * 60_000)).toBe('5h 20m')
    expect(formatSpan(2 * D)).toBe('2d')
    expect(formatSpan(12 * 60_000)).toBe('12m')
    expect(formatSpan(20_000)).toBe('under a minute')
    expect(formatSpan(null)).toBe('—')
  })

  it('gives charts days to one decimal', () => {
    expect(asDays(36 * H)).toBe(1.5)
    expect(asDays(null)).toBeNull()
  })
})

describe('ticketTat — waiting for components', () => {
  const trail = [
    ev('pending_acceptance', 0),
    ev('accepted', D),
    ev('assigned', D),
    ev('in_repair', 2 * D),
    ev('parts_requested', 3 * D),      // a day of repair, then a component asked for
    ev('parts_ordered', 3 * D + 4 * H),
    ev('parts_ready', 5 * D),
    ev('in_repair', 5 * D + 2 * H),    // 2 days 2 hours waiting
    ev('not_repairable', 6 * D),       // another day of repair
    ev('closed', 6 * D + 3 * H),       // moved to scrap
  ]
  const tat = ticketTat(trail, 'A', T0 + 20 * D)

  it('keeps the wait out of the repair', () => {
    expect(tat.parts).toEqual({ ms: 2 * D + 2 * H, running: false })
    // A day before the wait and 22 hours after it.
    expect(tat.repair).toEqual({ ms: D + 22 * H, running: false })
  })

  it('ends the repair at not repairable, and measures scrap as the last stage', () => {
    expect(tat.dispatch).toEqual({ ms: 3 * H, running: false })
    expect(tat.total).toEqual({ ms: 6 * D + 3 * H, running: false })
  })

  it('says the wait is what is running while it waits, not the repair', () => {
    const now = T0 + 4 * D
    const waiting = ticketTat(trail.slice(0, 6), 'A', now)
    expect(waiting.parts).toEqual({ ms: D, running: true })
    expect(waiting.repair.running).toBe(false)
    expect(waiting.repair.ms).toBe(D)
  })

  it('has no parts stage for a repair that never waited', () => {
    const plain = ticketTat([ev('pending_acceptance', 0), ev('accepted', D), ev('assigned', D), ev('in_repair', 2 * D), ev('repaired', 3 * D)], 'A', T0 + 4 * D)
    expect(plain.parts).toEqual({ ms: null, running: false })
  })
})
