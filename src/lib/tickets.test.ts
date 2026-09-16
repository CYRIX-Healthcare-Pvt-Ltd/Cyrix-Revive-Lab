import { describe, it, expect } from 'vitest'
import { ticketCode, parseTicketCode, actionsFor, runsTrc, waitingOnMe, type Me, type TicketLike } from './tickets'

const REG = 'trc-regional'
const PRJ = 'trc-project'

const me = (over: Partial<Me> = {}): Me => ({
  employee_id: 'me', is_engineer: false, is_coordinator: false, is_manager: false,
  is_admin: false, is_sw_admin: false, trc_ids: [], ...over,
})
const ticket = (over: Partial<TicketLike> = {}): TicketLike => ({
  status: 'pending_acceptance', trc_id: REG, engineer_id: null, stakeholder_id: 'field', ...over,
})

describe('ticket numbers', () => {
  it('pads to two and never truncates', () => {
    expect(ticketCode(1)).toBe('RL-01')
    expect(ticketCode(9)).toBe('RL-09')
    expect(ticketCode(10)).toBe('RL-10')
    expect(ticketCode(100)).toBe('RL-100')
  })

  it('reads a number however it was typed', () => {
    expect(parseTicketCode('RL-07')).toBe(7)
    expect(parseTicketCode('rl-7')).toBe(7)
    expect(parseTicketCode('RL07')).toBe(7)
    expect(parseTicketCode('7')).toBe(7)
    expect(parseTicketCode('RL-100')).toBe(100)
  })

  it('refuses what is not a ticket number', () => {
    expect(parseTicketCode('SR-1042')).toBeNull()
    expect(parseTicketCode('')).toBeNull()
    expect(parseTicketCode('RL-0')).toBeNull()
    expect(parseTicketCode(null)).toBeNull()
  })
})

describe('the desk is a coordinator or manager of that Revive Lab', () => {
  it('needs the box and the Revive Lab together', () => {
    expect(runsTrc(me({ is_coordinator: true, trc_ids: [REG] }), REG)).toBe(true)
    expect(runsTrc(me({ is_manager: true, trc_ids: [REG] }), REG)).toBe(true)
    expect(runsTrc(me({ is_coordinator: true, trc_ids: [PRJ] }), REG)).toBe(false)
    expect(runsTrc(me({ is_engineer: true, trc_ids: [REG] }), REG)).toBe(false)
  })
})

describe('actionsFor — who may do what, now', () => {
  const desk = me({ is_coordinator: true, trc_ids: [REG] })
  const engineer = me({ employee_id: 'eng', is_engineer: true, trc_ids: [REG] })

  it('lets the desk accept an arrival, and nobody else', () => {
    expect(actionsFor(ticket(), desk)).toEqual(['accept'])
    expect(actionsFor(ticket({ status: 'transferred' }), desk)).toEqual(['accept'])
    expect(actionsFor(ticket(), engineer)).toEqual([])
    expect(actionsFor(ticket(), me({ employee_id: 'field' }))).toEqual([])
  })

  it('offers assign and transfer once accepted', () => {
    expect(actionsFor(ticket({ status: 'accepted' }), desk)).toEqual(['assign', 'transfer'])
  })

  it('gives the assigned engineer the repair, and only them', () => {
    const t = ticket({ status: 'assigned', engineer_id: 'eng' })
    expect(actionsFor(t, engineer)).toEqual(['start', 'return'])
    expect(actionsFor(t, me({ employee_id: 'other', is_engineer: true, trc_ids: [REG] }))).toEqual([])
    expect(actionsFor(ticket({ status: 'in_repair', engineer_id: 'eng' }), engineer)).toEqual(['complete', 'return'])
  })

  it('sends a repaired spare to the desk for dispatch', () => {
    expect(actionsFor(ticket({ status: 'repaired', engineer_id: 'eng' }), desk)).toEqual(['dispatch'])
    expect(actionsFor(ticket({ status: 'repaired', engineer_id: 'eng' }), engineer)).toEqual([])
  })

  it('lets only the field engineer confirm it came back — the desk sent it', () => {
    const t = ticket({ status: 'in_transit_return' })
    expect(actionsFor(t, me({ employee_id: 'field' }))).toEqual(['received'])
    expect(actionsFor(t, desk)).toEqual([])
    expect(waitingOnMe(t, desk)).toBe(false)
  })

  it('still lets a coordinator confirm a spare they sent in themselves', () => {
    const t = ticket({ status: 'in_transit_return', stakeholder_id: 'me' })
    expect(actionsFor(t, desk)).toEqual(['received'])
  })

  it('offers nothing on a closed ticket', () => {
    expect(actionsFor(ticket({ status: 'closed' }), desk)).toEqual([])
  })

  it('handles a person who is both manager and engineer as both', () => {
    const both = me({ employee_id: 'eng', is_manager: true, is_engineer: true, trc_ids: [REG] })
    expect(actionsFor(ticket({ status: 'assigned', engineer_id: 'eng' }), both))
      .toEqual(['start', 'assign', 'return', 'transfer'])
  })

  it('counts a ticket as waiting on me only for a forward move', () => {
    expect(waitingOnMe(ticket({ status: 'accepted' }), desk)).toBe(true)
    expect(waitingOnMe(ticket({ status: 'in_repair', engineer_id: 'x' }), desk)).toBe(false)
  })
})
