import { describe, it, expect } from 'vitest'
import {
  STAGES, branchOf, categoryReport, countTickets, engineerReport, headcount, inTeamOf, indexTeam, isDueSoon, isLate,
  nextMove, pathTo, percent, periodRange, stageOf, type MyTeam, type ReportTicket,
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

  it('is due soon inside its last day', () => {
    expect(isDueSoon(ticket({ accepted_at: ago(30) }), NOW)).toBe(true)
    expect(isDueSoon(ticket({ accepted_at: ago(10) }), NOW)).toBe(false)
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

  it('gives each engineer a row: with them now, late, sent back and on time', () => {
    const rows = engineerReport(list, [{ id: 'E3', name: 'Cini' }], NOW)
    const anu = rows.find(r => r.id === 'E1')!
    expect(anu).toMatchObject({ withThem: 2, late: 1, sent: 0 })
    expect(anu.byCategory).toMatchObject({ A: 1, C: 1 })
    expect(anu.lateByCategory.C).toBe(1)
    const binu = rows.find(r => r.id === 'E2')!
    // Both sent back; B's 2 days ended at 40 h in, on time; A's 3 days ended at 10 h in, on time.
    expect(binu).toMatchObject({ withThem: 0, sent: 2, onTime: 2 })
    // Each against its own category's days: one A and one B, both met.
    expect(binu.sentByCategory).toEqual({ A: 1, B: 1, C: 0 })
    expect(binu.onTimeByCategory).toEqual({ A: 1, B: 1, C: 0 })
    // Somebody with nothing yet still has a row, last.
    expect(rows[rows.length - 1]).toMatchObject({ id: 'E3', withThem: 0 })
    expect(rows[0].id).toBe('E1')
  })

  it('counts each category on the clock, due, late, and what went back in the period', () => {
    const { rows, unclassified } = categoryReport(list, NOW)
    const a = rows.find(r => r.category === 'A')!
    expect(a).toMatchObject({ days: 3, atLab: 2, late: 0, sent: 1, onTime: 1 })
    const c = rows.find(r => r.category === 'C')!
    expect(c).toMatchObject({ days: 1, atLab: 1, late: 1 })
    expect(unclassified).toBe(1)
  })

  it('counts what was sent back in the period asked for, by the calendar', () => {
    // NOW is 24 Sep: RL "c" went back on 23 Sep, "d" on 20 Sep — both this month, neither last month.
    const thisMonth = engineerReport(list, [], NOW, periodRange('month', NOW)).find(r => r.id === 'E2')!
    expect(thisMonth.sent).toBe(2)
    const lastMonth = engineerReport(list, [], NOW, periodRange('last_month', NOW)).find(r => r.id === 'E2')!
    expect(lastMonth.sent).toBe(0)
    expect(categoryReport(list, NOW, periodRange('last_month', NOW)).rows.every(r => r.sent === 0)).toBe(true)
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
