import { describe, it, expect } from 'vitest'
import {
  STAGES, branchOf, categoryReport, countTickets, engineerWork, headcount, inTeamOf, indexTeam, isLate,
  nextMove, pathTo, percent, periodRange, repairWindow, stageOf, type MyTeam, type ReportTicket,
} from './team'
import { STATUS_ORDER } from './tickets'

const NOW = Date.parse('2026-09-24T12:00:00Z')
const H = 3_600_000
const ago = (hours: number) => new Date(NOW - hours * H).toISOString()

/*
  The viewer V has two managers under them, M1 and M2; M1 has two field
  engineers, F1 and F2; M2 has F3, who has left the company.
*/
const TEAM: MyTeam = {
  people: [
    { id: 'M1', name: 'Abijith', ecode: 'E1', designation: 'Divisional Manager', manager_id: 'V', active: true },
    { id: 'M2', name: 'Manish', ecode: 'E2', designation: 'Divisional Manager', manager_id: 'V', active: true },
    { id: 'F1', name: 'Lislal', ecode: 'E3', designation: 'Engineer', manager_id: 'M1', active: true },
    { id: 'F2', name: 'Jishnu', ecode: 'E4', designation: 'Engineer', manager_id: 'M1', active: true },
    { id: 'F3', name: 'Rishin', ecode: 'E5', designation: 'Engineer', manager_id: 'M2', active: false },
  ],
  tickets: [
    { ticket_id: 't1', person_id: 'F1' },
    { ticket_id: 't2', person_id: 'F3' },
  ],
}

const ticket = (over: Partial<ReportTicket> = {}): ReportTicket => ({
  id: 't', code: 'RL-01', status: 'assigned', created_at: ago(10), closed_at: null, closure: null,
  trc_id: 'lab', trc_name: 'Cochin Revive Lab', stakeholder_id: 'F1', stakeholder_name: 'Lislal',
  engineer_id: 'E', engineer_name: 'Anu', spare_category: 'B', accepted_at: ago(10), dispatched_at: null, scrapped_at: null,
  ...over,
})

describe('the team', () => {
  const ix = indexTeam(TEAM)

  it('knows which of a manager’s own reports each person sits under', () => {
    expect(branchOf(ix, 'F1', 'V')).toBe('M1')
    expect(branchOf(ix, 'F3', 'V')).toBe('M2')
    expect(branchOf(ix, 'F2', 'M1')).toBe('F2')
    expect(branchOf(ix, 'F3', 'M1')).toBeNull()
    expect(branchOf(ix, 'M1', 'M1')).toBeNull()
  })

  it('knows who is in whose team, the focus included', () => {
    expect(inTeamOf(ix, 'F3', 'V', 'V')).toBe(true)
    expect(inTeamOf(ix, 'M1', 'M1', 'V')).toBe(true)
    expect(inTeamOf(ix, 'F1', 'M1', 'V')).toBe(true)
    expect(inTeamOf(ix, 'F3', 'M1', 'V')).toBe(false)
  })

  it('walks back up for the way home', () => {
    expect(pathTo(ix, 'F2').map(p => p.id)).toEqual(['M1', 'F2'])
  })

  it('counts people still with the company, not the ones who left', () => {
    expect(headcount(ix, 'V')).toBe(4)
    expect(headcount(ix, 'M2')).toBe(0)
    expect(headcount(ix, 'M1')).toBe(2)
  })

  it('knows whose each ticket is', () => {
    expect(ix.ownerOf.get('t2')).toBe('F3')
    expect(ix.ownerOf.has('t9')).toBe(false)
  })

  it('stands a reporting line that points back at itself', () => {
    const loop = indexTeam({ people: [
      { id: 'A', name: 'A', ecode: 'A', designation: null, manager_id: 'B', active: true },
      { id: 'B', name: 'B', ecode: 'B', designation: null, manager_id: 'A', active: true },
    ], tickets: [] })
    expect(branchOf(loop, 'A', 'V')).toBeNull()
    expect(pathTo(loop, 'A').length).toBeLessThanOrEqual(20)
    expect(headcount(loop, 'A')).toBe(2)
  })
})

describe('where a spare is', () => {
  it('puts every open status in exactly one stage, and closed in none', () => {
    for (const s of STATUS_ORDER) {
      const n = STAGES.filter(x => x.statuses.includes(s)).length
      expect(n, s).toBe(s === 'closed' ? 0 : 1)
    }
    expect(stageOf('closed')).toBeNull()
    expect(stageOf('parts_ordered')?.key).toBe('repair')
  })

  it('is late only past its category’s days from acceptance, while the Revive Lab still has it', () => {
    // B is 2 days.
    expect(isLate(ticket({ accepted_at: ago(47) }), NOW)).toBe(false)
    expect(isLate(ticket({ accepted_at: ago(49) }), NOW)).toBe(true)
    // Dispatched on time is not late now, whatever the clock says.
    expect(isLate(ticket({ accepted_at: ago(100), dispatched_at: ago(90), status: 'in_transit_return' }), NOW)).toBe(false)
    expect(isLate(ticket({ spare_category: null }), NOW)).toBe(false)
    expect(isLate(ticket({ status: 'closed', accepted_at: ago(100) }), NOW)).toBe(false)
  })

  it('says whose move it is', () => {
    expect(nextMove(ticket({ status: 'pending_acceptance' }))).toBe('Cochin Revive Lab, to accept it')
    expect(nextMove(ticket({ status: 'assigned' }))).toBe('Anu, to start the repair')
    expect(nextMove(ticket({ status: 'received_back' }))).toBe('Lislal, to fit it and close')
  })
})

describe('a set of tickets, counted', () => {
  it('counts open, late, each stage and what closed this month', () => {
    const c = countTickets([
      ticket({ id: 'a', status: 'pending_acceptance', accepted_at: null, spare_category: null }),
      ticket({ id: 'b', status: 'assigned', accepted_at: ago(60) }),
      ticket({ id: 'c', status: 'in_repair', created_at: ago(80) }),
      ticket({ id: 'd', status: 'closed', closed_at: ago(5) }),
      ticket({ id: 'e', status: 'closed', closed_at: ago(5), closure: 'discarded' }),
    ], NOW)
    expect(c.open).toBe(3)
    expect(c.late).toBe(1)
    expect(c.byStage).toMatchObject({ sent: 1, repair: 2, dispatch: 0 })
    expect(c.closedThisMonth).toBe(1)
    expect(c.oldest?.id).toBe('c')
  })
})

describe('the Revive Lab’s reports', () => {
  const list = [
    ticket({ id: 'a', engineer_id: 'E1', engineer_name: 'Anu', spare_category: 'A', accepted_at: ago(10) }),
    ticket({ id: 'b', engineer_id: 'E1', engineer_name: 'Anu', spare_category: 'C', accepted_at: ago(30) }),
    ticket({ id: 'c', engineer_id: 'E2', engineer_name: 'Binu', status: 'in_transit_return', spare_category: 'B', accepted_at: ago(60), dispatched_at: ago(20) }),
    ticket({ id: 'd', engineer_id: 'E2', engineer_name: 'Binu', status: 'closed', closed_at: ago(2), spare_category: 'A', accepted_at: ago(100), dispatched_at: ago(90) }),
    ticket({ id: 'e', engineer_id: null, engineer_name: null, status: 'accepted', spare_category: 'A', accepted_at: ago(1) }),
    ticket({ id: 'f', status: 'pending_acceptance', engineer_id: null, engineer_name: null, spare_category: null, accepted_at: null }),
  ]

  // Status histories: assigned, then the repair closed or not.
  const EVENTS: Record<string, Array<{ status: string; at: string }>> = {
    a: [{ status: 'accepted', at: ago(12) }, { status: 'assigned', at: ago(10) }, { status: 'in_repair', at: ago(8) }],
    b: [{ status: 'accepted', at: ago(31) }, { status: 'assigned', at: ago(30) }],
    c: [{ status: 'assigned', at: ago(58) }, { status: 'in_repair', at: ago(50) }, { status: 'repaired', at: ago(28) }, { status: 'in_transit_return', at: ago(20) }],
    d: [{ status: 'assigned', at: ago(98) }, { status: 'repaired', at: ago(92) }, { status: 'in_transit_return', at: ago(90) }, { status: 'closed', at: ago(2) }],
  }
  const eventsOf = (id: string) => EVENTS[id] ?? []

  it('knows when a repair was assigned and when the engineer closed it', () => {
    expect(repairWindow(EVENTS.c)).toEqual({ assignedAt: Date.parse(ago(58)), closedAt: Date.parse(ago(28)) })
    expect(repairWindow(EVENTS.a)).toEqual({ assignedAt: Date.parse(ago(10)), closedAt: null })
    // A reassignment inside the same run keeps the clock; a new round after a close starts it again.
    expect(repairWindow([
      { status: 'assigned', at: ago(40) }, { status: 'assigned', at: ago(35) }, { status: 'repaired', at: ago(30) },
      { status: 'pending_acceptance', at: ago(20) }, { status: 'accepted', at: ago(19) }, { status: 'assigned', at: ago(18) },
    ])).toEqual({ assignedAt: Date.parse(ago(18)), closedAt: null })
  })

  it('gives each engineer total, closed, open and the two averages', () => {
    const rows = engineerWork(list, eventsOf, [{ id: 'E3', name: 'Cini' }], NOW)
    const anu = rows.find(r => r.id === 'E1')!
    // Two open: assigned 10 h and 30 h ago — 20 h on average.
    expect(anu).toMatchObject({ total: 2, closed: 0, open: 2, avgClosureMs: null, avgOpenMs: 20 * H })
    expect(anu.byCategory).toMatchObject({ A: { total: 1, open: 1 }, C: { total: 1, open: 1 } })
    const binu = rows.find(r => r.id === 'E2')!
    // Two closed: 30 h and 6 h after assignment — 18 h on average.
    expect(binu).toMatchObject({ total: 2, closed: 2, open: 0, avgClosureMs: 18 * H, avgOpenMs: null })
    expect(binu.byCategory).toMatchObject({ A: { total: 1, open: 0 }, B: { total: 1, open: 0 } })
    // Somebody with nothing yet still has a row, last.
    expect(rows[rows.length - 1]).toMatchObject({ id: 'E3', total: 0 })
    expect(rows[0].id).toBe('E1')
  })

  it('counts each category on the Revive Lab\u2019s clock now, in TAT and above it', () => {
    const rows = categoryReport(list, NOW)
    const a = rows.find(r => r.category === 'A')!
    expect(a).toEqual({ category: 'A', days: 3, atLab: 2, inTat: 2, aboveTat: 0 })
    const c = rows.find(r => r.category === 'C')!
    expect(c).toMatchObject({ days: 1, atLab: 1, inTat: 0, aboveTat: 1 })
  })

  it('counts what was closed in the period asked for, by the calendar; open is always now', () => {
    // NOW is 24 Sep: "c" and "d" were closed by the engineer this month, neither last month.
    const thisMonth = engineerWork(list, eventsOf, [], NOW, periodRange('month', NOW)).find(r => r.id === 'E2')!
    expect(thisMonth.closed).toBe(2)
    const lastMonth = engineerWork(list, eventsOf, [], NOW, periodRange('last_month', NOW))
    expect(lastMonth.find(r => r.id === 'E2')!.closed).toBe(0)
    expect(lastMonth.find(r => r.id === 'E1')!.open).toBe(2)
  })

  it('knows a month from its 1st to the next 1st', () => {
    const sep1 = new Date(2026, 8, 1).getTime()
    expect(periodRange('month', NOW)).toEqual({ from: sep1, to: Infinity })
    expect(periodRange('last_month', NOW)).toEqual({ from: new Date(2026, 7, 1).getTime(), to: sep1 })
    expect(periodRange('all', NOW)).toEqual({ from: -Infinity, to: Infinity })
  })

  it('says a share, or a dash when there is nothing to share', () => {
    expect(percent(9, 10)).toBe('90%')
    expect(percent(0, 0)).toBe('—')
  })
})
