import { describe, it, expect } from 'vitest'
import {
  ticketCode, parseTicketCode, actionsFor, awaitingManager, runsTrc, managesTrc, observesOnly, waitingOnMe, cleanItems, itemsSummary,
  partsWaitingOn, ticketTabs, serves, approversOf, orList, statusLook, canRaise, partActor, partStatusLook,
  ITEM_KIND_LABEL, PART_PROGRESS, PART_STATUS, poLabel, canClassify, statusGroups, roundOf, ordinal, mergeDeskRaise,
  type Me, type TicketLike,
} from './tickets'

const REG = 'trc-regional'
const PRJ = 'trc-project'

const me = (over: Partial<Me> = {}): Me => ({
  employee_id: 'me', is_engineer: false, is_coordinator: false, is_manager: false,
  is_admin: false, is_sw_admin: false, trc_ids: [], ...over,
})
const ticket = (over: Partial<TicketLike> = {}): TicketLike => ({
  status: 'pending_acceptance', trc_id: REG, engineer_id: null, stakeholder_id: 'field', raised_by: 'field', ...over,
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

describe('the desk is a coordinator of that Revive Lab, or a Revive Lab admin (rl_0036)', () => {
  it('needs the coordinator box and the Revive Lab together', () => {
    expect(runsTrc(me({ is_coordinator: true, trc_ids: [REG] }), REG)).toBe(true)
    expect(runsTrc(me({ is_coordinator: true, trc_ids: [PRJ] }), REG)).toBe(false)
    expect(runsTrc(me({ is_engineer: true, trc_ids: [REG] }), REG)).toBe(false)
    expect(runsTrc(null, REG)).toBe(false)
  })

  it('counts an admin as the desk of every Revive Lab', () => {
    expect(runsTrc(me({ is_admin: true }), REG)).toBe(true)
    expect(runsTrc(me({ is_admin: true, trc_ids: [PRJ] }), REG)).toBe(true)
  })

  it('does not count a manager: they approve, and that is all', () => {
    const manager = me({ is_manager: true, trc_ids: [REG] })
    expect(runsTrc(manager, REG)).toBe(false)
    expect(managesTrc(manager, REG)).toBe(true)
    expect(managesTrc(manager, PRJ)).toBe(false)
    // One who is a coordinator as well is the desk.
    expect(runsTrc(me({ is_manager: true, is_coordinator: true, trc_ids: [REG] }), REG)).toBe(true)
  })
})

describe('actionsFor — who may do what, now', () => {
  const desk = me({ is_coordinator: true, trc_ids: [REG] })
  const engineer = me({ employee_id: 'eng', is_engineer: true, trc_ids: [REG] })

  it('lets the desk accept an arrival, and nobody else', () => {
    expect(actionsFor(ticket(), desk)).toEqual(['accept'])
    expect(actionsFor(ticket({ status: 'transferred' }), desk)).toEqual(['accept'])
    expect(actionsFor(ticket(), engineer)).toEqual([])
    expect(actionsFor(ticket(), me({ employee_id: 'field' }))).not.toContain('accept')
  })

  it('lets whoever sent it in add the courier details until it arrives', () => {
    // The field engineer who raised it.
    expect(actionsFor(ticket(), me({ employee_id: 'field' }))).toEqual(['courier'])
    // A desk that raised it for a field engineer, and that field engineer.
    const raisedAtLab = ticket({ raised_by: 'me', stakeholder_id: 'field' })
    expect(actionsFor(raisedAtLab, desk)).toEqual(['accept', 'courier'])
    expect(actionsFor(raisedAtLab, me({ employee_id: 'field' }))).toEqual(['courier'])
    // Nobody else, and not once the Revive Lab has it.
    expect(actionsFor(ticket(), engineer)).not.toContain('courier')
    expect(actionsFor(ticket({ status: 'accepted' }), me({ employee_id: 'field' }))).toEqual([])
    // Optional, so it never puts a ticket in somebody's queue.
    expect(waitingOnMe(ticket(), me({ employee_id: 'field' }))).toBe(false)
  })

  it('offers assign and transfer once accepted', () => {
    expect(actionsFor(ticket({ status: 'accepted' }), desk)).toEqual(['assign', 'transfer'])
  })

  it('gives the assigned engineer the repair, and only them', () => {
    const t = ticket({ status: 'assigned', engineer_id: 'eng' })
    expect(actionsFor(t, engineer)).toEqual(['start', 'return'])
    expect(actionsFor(t, me({ employee_id: 'other', is_engineer: true, trc_ids: [REG] }))).toEqual([])
    expect(actionsFor(ticket({ status: 'in_repair', engineer_id: 'eng' }), engineer))
      .toEqual(['complete', 'use_part', 'request_part', 'observe', 'expect', 'return'])
  })

  it('sends a repaired spare to the desk for dispatch', () => {
    expect(actionsFor(ticket({ status: 'repaired', engineer_id: 'eng' }), desk)).toEqual(['dispatch'])
    expect(actionsFor(ticket({ status: 'repaired', engineer_id: 'eng' }), engineer)).toEqual([])
  })

  it('lets only the field engineer confirm it came back — the desk sent it', () => {
    const t = ticket({ status: 'in_transit_return' })
    expect(actionsFor(t, me({ employee_id: 'field' }))).toEqual(['received', 'hand_over'])
    expect(actionsFor(t, desk)).toEqual([])
    expect(waitingOnMe(t, desk)).toBe(false)
  })

  it('still lets a coordinator confirm a spare they sent in themselves', () => {
    const t = ticket({ status: 'in_transit_return', stakeholder_id: 'me' })
    expect(actionsFor(t, desk)).toEqual(['received', 'hand_over'])
  })

  it('offers nothing on a closed ticket', () => {
    expect(actionsFor(ticket({ status: 'closed' }), desk)).toEqual([])
  })

  it('handles a person who is both coordinator and engineer as both', () => {
    const both = me({ employee_id: 'eng', is_coordinator: true, is_engineer: true, trc_ids: [REG] })
    expect(actionsFor(ticket({ status: 'assigned', engineer_id: 'eng' }), both))
      .toEqual(['start', 'assign', 'return', 'transfer'])
  })

  it('gives a manager who is also an engineer the engineer’s moves, and none of the desk’s', () => {
    const both = me({ employee_id: 'eng', is_manager: true, is_engineer: true, trc_ids: [REG] })
    expect(actionsFor(ticket({ status: 'assigned', engineer_id: 'eng' }), both)).toEqual(['start', 'return'])
    expect(actionsFor(ticket({ status: 'in_repair', engineer_id: 'eng' }), both))
      .toEqual(['complete', 'use_part', 'request_part', 'observe', 'expect', 'return'])
  })

  it('counts a ticket as waiting on me only for a forward move', () => {
    expect(waitingOnMe(ticket({ status: 'accepted' }), desk)).toBe(true)
    expect(waitingOnMe(ticket({ status: 'in_repair', engineer_id: 'x' }), desk)).toBe(false)
  })
})

describe('spares and accessories', () => {
  it('sends only the lines with a name, trimmed', () => {
    expect(cleanItems([
      { kind: 'spare', name: ' SMPS board ' },
      { kind: 'accessory', name: '   ' },
      { kind: 'accessory', name: 'Power cable' },
    ])).toEqual([
      { kind: 'spare', name: 'SMPS board' },
      { kind: 'accessory', name: 'Power cable' },
    ])
  })

  it('calls a ticket by its first line, and says how many more came with it', () => {
    expect(itemsSummary({ spare_name: 'SMPS board', items: [{ kind: 'spare', name: 'SMPS board' }] })).toBe('SMPS board')
    expect(itemsSummary({
      spare_name: 'SMPS board',
      items: [{ kind: 'spare', name: 'SMPS board' }, { kind: 'accessory', name: 'Power cable' }, { kind: 'accessory', name: 'Probe' }],
    })).toBe('SMPS board +2 more')
    // From before the list, or an app that did not send one.
    expect(itemsSummary({ spare_name: 'Pump motor', items: [] })).toBe('Pump motor')
    expect(itemsSummary({ spare_name: null })).toBeNull()
  })
})

describe('components and how a repair ends (rl_0013)', () => {
  const desk = me({ is_coordinator: true, trc_ids: [REG] })
  const engineer = me({ employee_id: 'eng', is_engineer: true, trc_ids: [REG] })
  const buyer = me({ employee_id: 'buyer', is_purchase: true, trc_ids: [REG] })

  it('lets the engineer use stock, ask for components and note things while waiting, but not close the repair', () => {
    for (const status of ['parts_requested', 'parts_ordered', 'parts_ready'] as const) {
      expect(actionsFor(ticket({ status, engineer_id: 'eng' }), engineer)).toEqual(['use_part', 'request_part', 'observe', 'expect'])
    }
  })

  it('sends every closed repair to the desk for dispatch, and offers scrap only for not repairable', () => {
    expect(actionsFor(ticket({ status: 'repaired' }), desk)).toEqual(['dispatch'])
    expect(actionsFor(ticket({ status: 'service_denied' }), desk)).toEqual(['dispatch'])
    // Once a manager has approved it as not repairable (rl_0034).
    expect(actionsFor(ticket({ status: 'not_repairable', nr_approved_at: '2026-09-29T10:00:00Z' }), desk)).toEqual(['dispatch', 'scrap'])
    expect(actionsFor(ticket({ status: 'not_repairable', nr_approved_at: '2026-09-29T10:00:00Z' }), engineer)).toEqual([])
  })

  it('puts a component request in the queue of whoever has to move it', () => {
    const t = ticket({
      status: 'parts_ordered', engineer_id: 'eng',
      parts: [
        { id: 'a', route: 'local', status: 'requested' },
        { id: 'b', route: 'purchase', status: 'accepted' },
        { id: 'c', route: 'local', status: 'sent' },
        { id: 'd', route: 'purchase', status: 'declined' },
      ],
    })
    expect(partsWaitingOn(t, desk)).toBe(1)       // the one asked for, to buy or pass on
    expect(partsWaitingOn(t, buyer)).toBe(1)      // the purchase being bought
    expect(partsWaitingOn(t, engineer)).toBe(1)   // the one to confirm
    expect(partsWaitingOn(t, me({ employee_id: 'field' }))).toBe(0)
    expect(waitingOnMe(t, buyer)).toBe(true)
    // Purchase at another Revive Lab has nothing to do with it.
    expect(partsWaitingOn(t, me({ employee_id: 'b2', is_purchase: true, trc_ids: [PRJ] }))).toBe(0)
  })

  it('gives each role its own tabs', () => {
    const labels = (m: Me) => ticketTabs(m).map(x => x.label)
    // What waits on each of them comes second, whoever they are (the user, 23 Sep).
    expect(labels(desk)).toEqual(['All', 'Waiting on you', 'Not assigned', 'Component pending', 'Closed'])
    expect(labels(engineer)).toEqual(['All', 'Waiting on you', 'In repair', 'Assigned', 'Closed'])
    expect(labels(buyer)).toEqual(['All', 'Waiting on you', 'Component pending', 'Closed'])
    expect(labels(me({ employee_id: 'field' }))).toEqual(['All', 'Waiting on you', 'Open', 'Closed'])
  })

  it('shows Purchase everything the database gives them, with what is still to buy apart', () => {
    // The database shows Purchase only what came to them; All hides none of it —
    // a ticket of their own was hidden once while the badge counted it (rl_0019).
    const [all, , pending, closed] = ticketTabs(buyer)
    const bought = ticket({ status: 'closed', parts: [{ id: 'x', route: 'purchase', status: 'received' }] })
    const waiting = ticket({ status: 'parts_requested', parts: [{ id: 'y', route: 'purchase', status: 'requested' }] })
    const localOnly = ticket({ status: 'parts_requested', parts: [{ id: 'z', route: 'local', status: 'requested' }] })
    const theirs = ticket({ status: 'in_transit_return' })
    expect([bought, waiting, localOnly, theirs].map(all.match)).toEqual([true, true, true, true])
    expect([bought, waiting, localOnly, theirs].map(pending.match)).toEqual([false, true, false, false])
    expect([bought, waiting, theirs].map(closed.match)).toEqual([true, false, false])
  })

  it('counts a repair waiting on a component as in repair for the engineer, and as component pending for the desk', () => {
    const t = ticket({ status: 'parts_ready' })
    expect(ticketTabs(engineer).find(x => x.id === 'repair')!.match(t)).toBe(true)
    expect(ticketTabs(desk).find(x => x.id === 'parts')!.match(t)).toBe(true)
    expect(ticketTabs(desk).find(x => x.id === 'unassigned')!.match(ticket({ status: 'accepted' }))).toBe(true)
  })
})

describe('states, approval and the proposal (rl_0014)', () => {
  const desk = me({ is_coordinator: true, trc_ids: [REG] })
  const engineer = me({ employee_id: 'eng', is_engineer: true, trc_ids: [REG] })
  const approver = me({ employee_id: 'boss', is_admin: true, approves: true, trc_ids: [REG] })
  const field = me({ employee_id: 'field' })

  it('offers a state its own Revive Labs and BEMMPs, and the Regional ones', () => {
    expect(serves({ state: 'Kerala' }, 'Kerala')).toBe(true)
    expect(serves({ state: null }, 'Kerala')).toBe(true)
    expect(serves({ state: 'Rajasthan' }, 'Kerala')).toBe(false)
    expect(serves({ state: 'Kerala' }, '')).toBe(false)
  })

  it('names the admins of a Regional Revive Lab as the approvers, or every admin while it has none', () => {
    const labs = [{ id: REG, state: null }, { id: PRJ, state: 'Rajasthan' }]
    const people = [
      { full_name: 'Henry', is_admin: true, trc_ids: [REG, PRJ] },
      { full_name: 'Anu', is_admin: true, trc_ids: [PRJ] },
      { full_name: 'Kevin', is_admin: false, trc_ids: [REG] },
    ]
    expect(approversOf(people, labs)).toEqual(['Henry'])
    expect(approversOf(people, [{ id: REG, state: 'Kerala' }, { id: PRJ, state: 'Rajasthan' }])).toEqual(['Henry', 'Anu'])
    expect(orList(['Henry'])).toBe('Henry')
    expect(orList(['Henry', 'Saranya'])).toBe('Henry or Saranya')
    expect(orList(['Henry', 'Anu', 'Saranya'])).toBe('Henry, Anu or Saranya')
  })

  it('asks the approvers, and nobody else, while it waits', () => {
    const raised = ticket({ status: 'awaiting_approval', approval: { kind: 'raise', status: 'pending' } })
    expect(actionsFor(raised, approver)).toEqual(['approve', 'decline_approval'])
    expect(waitingOnMe(raised, approver)).toBe(true)
    // The field engineer who asked can only give it up; it is not their move.
    expect(actionsFor(raised, field)).toEqual(['discard'])
    expect(waitingOnMe(raised, field)).toBe(false)
    expect(actionsFor(raised, desk)).toEqual([])
    expect(actionsFor(raised, engineer)).toEqual([])
  })

  it('hands an approved raise back to the field engineer to send, and a transfer to the desk', () => {
    const raise = ticket({ status: 'approved', approval: { kind: 'raise', status: 'approved' } })
    expect(actionsFor(raise, field)).toEqual(['send', 'discard'])
    expect(waitingOnMe(raise, field)).toBe(true)
    expect(actionsFor(raise, desk)).toEqual([])

    const transfer = ticket({ status: 'approved', engineer_id: 'eng', approval: { kind: 'transfer', status: 'approved' } })
    expect(actionsFor(transfer, desk)).toEqual(['send', 'cancel_transfer'])
    expect(waitingOnMe(transfer, desk)).toBe(true)
    expect(actionsFor(transfer, field)).toEqual([])
    expect(actionsFor(transfer, engineer)).toEqual([])
  })

  it('lets the desk cancel a transfer while it waits, without it counting as their move', () => {
    const t = ticket({ status: 'awaiting_approval', engineer_id: 'eng', approval: { kind: 'transfer', status: 'pending' } })
    expect(actionsFor(t, desk)).toEqual(['cancel_transfer'])
    expect(waitingOnMe(t, desk)).toBe(false)
    // Nothing for the engineer until it is decided.
    expect(actionsFor(t, engineer)).toEqual([])
  })

  it('gives a raise that was not approved back to the field engineer: send it elsewhere, or discard it', () => {
    const t = ticket({ status: 'not_approved', approval: { kind: 'raise', status: 'declined' } })
    expect(actionsFor(t, field)).toEqual(['reroute', 'discard'])
    expect(waitingOnMe(t, field)).toBe(true)
    expect(actionsFor(t, approver)).toEqual([])
  })

  it('offers the desk only the move the engineer proposed for a spare that cannot be repaired', () => {
    expect(actionsFor(ticket({ status: 'not_repairable', proposal: 'scrap', nr_approved_at: '2026-09-29T10:00:00Z' }), desk)).toEqual(['scrap'])
    expect(actionsFor(ticket({ status: 'not_repairable', proposal: 'return', nr_approved_at: '2026-09-29T10:00:00Z' }), desk)).toEqual(['dispatch'])
    // Sent to its maker: dispatched too, to the OEM's address — never scrapped (rl_0033).
    expect(actionsFor(ticket({ status: 'not_repairable', proposal: 'oem', nr_approved_at: '2026-09-29T10:00:00Z' }), desk)).toEqual(['dispatch'])
    // Closed by an app from before the proposal: the desk chooses, as it did.
    expect(actionsFor(ticket({ status: 'not_repairable', proposal: null, nr_approved_at: '2026-09-29T10:00:00Z' }), desk)).toEqual(['dispatch', 'scrap'])
  })

  it('waits for a manager of its Revive Lab before the desk may move a spare that cannot be repaired (rl_0034)', () => {
    const manager = me({ employee_id: 'mgr', is_manager: true, trc_ids: [REG] })
    const t = ticket({ status: 'not_repairable', proposal: 'oem', engineer_id: 'eng' })
    expect(actionsFor(t, desk)).toEqual([])
    expect(actionsFor(t, manager)).toEqual(['approve_nr', 'decline_nr'])
    expect(waitingOnMe(t, manager)).toBe(true)
    expect(waitingOnMe(t, desk)).toBe(false)
    // A manager who repaired it himself approves his own call too — a Revive Lab may have one manager (rl_0035).
    expect(actionsFor({ ...t, engineer_id: 'mgr' }, manager)).toEqual(['approve_nr', 'decline_nr'])
    // Nor does a manager of another Revive Lab.
    expect(actionsFor(t, me({ employee_id: 'mgr2', is_manager: true, trc_ids: ['other'] }))).toEqual([])
    expect(statusLook('not_repairable', null, 'oem', awaitingManager(t)).short).toBe('Manager approval')
    expect(statusLook('not_repairable', null, 'oem').label).toBe('Not repairable — to send to the OEM')
  })

  it('passes it to the desk once approved: the manager has no dispatch and no scrap (rl_0036)', () => {
    // Joseph P V, as the user showed him: Revive Lab Engineer and Manager, not Coordinator.
    const manager = me({ employee_id: 'mgr', is_manager: true, is_engineer: true, trc_ids: [REG] })
    const approved = { status: 'not_repairable' as const, engineer_id: 'eng', nr_approved_at: '2026-09-30T03:05:00Z' }
    for (const proposal of ['oem', 'return', 'scrap', null] as const) {
      expect(actionsFor(ticket({ ...approved, proposal }), manager)).toEqual([])
      expect(waitingOnMe(ticket({ ...approved, proposal }), manager)).toBe(false)
    }
    // Nor when the repair was his own.
    expect(actionsFor(ticket({ ...approved, proposal: 'oem', engineer_id: 'mgr' }), manager)).toEqual([])
    // It is the coordinator's, and waits on them.
    expect(actionsFor(ticket({ ...approved, proposal: 'oem' }), desk)).toEqual(['dispatch'])
    expect(waitingOnMe(ticket({ ...approved, proposal: 'oem' }), desk)).toBe(true)
    // Somebody who is both approves it, and then sends it.
    const both = me({ employee_id: 'both', is_manager: true, is_coordinator: true, trc_ids: [REG] })
    expect(actionsFor(ticket({ status: 'not_repairable', proposal: 'oem', engineer_id: 'eng' }), both)).toEqual(['approve_nr', 'decline_nr'])
    expect(actionsFor(ticket({ ...approved, proposal: 'oem' }), both)).toEqual(['dispatch'])
    expect(actionsFor(ticket({ ...approved, proposal: 'scrap' }), both)).toEqual(['scrap'])
  })

  it('gives a manager none of the desk’s moves, at any stage (the user, 1 Oct: "coordinator and admin only")', () => {
    const manager = me({ employee_id: 'mgr', is_manager: true, is_engineer: true, trc_ids: [REG] })
    for (const status of ['pending_acceptance', 'transferred', 'accepted', 'repaired', 'service_denied', 'in_transit_return', 'closed'] as const) {
      expect(actionsFor(ticket({ status }), manager)).toEqual([])
      expect(waitingOnMe(ticket({ status }), manager)).toBe(false)
    }
    // Somebody else's repair: no reassigning it, no sending it to another Revive Lab.
    expect(actionsFor(ticket({ status: 'assigned', engineer_id: 'eng' }), manager)).toEqual([])
    expect(actionsFor(ticket({ status: 'in_repair', engineer_id: 'eng' }), manager)).toEqual([])
    // A transfer waiting to be sent, or to be cancelled, is the desk's too.
    expect(actionsFor(ticket({ status: 'approved', engineer_id: 'eng', approval: { kind: 'transfer', status: 'approved' } }), manager)).toEqual([])
    // Components: the request to take on, and the stock to approve, wait on the coordinator.
    const parts = ticket({
      status: 'parts_requested', engineer_id: 'eng',
      parts: [{ id: 'a', route: 'local', status: 'requested' }], stock: [{ id: 's', status: 'requested' }],
    })
    expect(partsWaitingOn(parts, manager)).toBe(0)
    expect(partsWaitingOn(parts, desk)).toBe(2)
    // The category and criticality are the desk's to change.
    const at = { trc_id: REG, accepted_at: '2026-09-23T04:00:00Z', status: 'in_repair' as const }
    expect(canClassify(at, manager)).toBe(false)
    expect(canClassify(at, desk)).toBe(true)
    // The approval is theirs, and it is what waits on them.
    const asked = ticket({ status: 'not_repairable', proposal: 'scrap', engineer_id: 'eng' })
    expect(actionsFor(asked, manager)).toEqual(['approve_nr', 'decline_nr'])
    expect(waitingOnMe(asked, manager)).toBe(true)
  })

  it('gives an admin the desk’s moves at every Revive Lab, and leaves the queue to its coordinators', () => {
    const admin = me({ employee_id: 'adm', is_admin: true })
    expect(actionsFor(ticket(), admin)).toEqual(['accept'])
    expect(actionsFor(ticket({ status: 'accepted' }), admin)).toEqual(['assign', 'transfer'])
    expect(actionsFor(ticket({ status: 'repaired' }), admin)).toEqual(['dispatch'])
    expect(actionsFor(ticket({ status: 'not_repairable', proposal: 'oem', nr_approved_at: '2026-09-30T03:05:00Z' }), admin)).toEqual(['dispatch'])
    expect(actionsFor(ticket({ status: 'not_repairable', proposal: 'scrap', nr_approved_at: '2026-09-30T03:05:00Z' }), admin)).toEqual(['scrap'])
    expect(canClassify({ trc_id: PRJ, accepted_at: '2026-09-23T04:00:00Z', status: 'in_repair' }, admin)).toBe(true)
    // Approving it as not repairable stays the manager's: an admin is not one.
    expect(actionsFor(ticket({ status: 'not_repairable', proposal: 'oem' }), admin)).toEqual([])
    // Stepping in is a choice, not a wait: nothing of the desk's is in their Waiting on you…
    for (const status of ['pending_acceptance', 'accepted', 'repaired'] as const) {
      expect(waitingOnMe(ticket({ status }), admin)).toBe(false)
    }
    // …unless they coordinate that Revive Lab — then it is, there and only there.
    const here = me({ employee_id: 'adm', is_admin: true, is_coordinator: true, trc_ids: [REG] })
    expect(waitingOnMe(ticket({ status: 'pending_acceptance' }), here)).toBe(true)
    expect(actionsFor(ticket({ status: 'pending_acceptance', trc_id: PRJ }), here)).toEqual(['accept'])
    expect(waitingOnMe(ticket({ status: 'pending_acceptance', trc_id: PRJ }), here)).toBe(false)
    // Where a spare goes is theirs to approve when they are an approver, and that does wait on them.
    const routing = ticket({ status: 'awaiting_approval', approval: { kind: 'raise', status: 'pending' } })
    expect(waitingOnMe(routing, me({ employee_id: 'adm', is_admin: true, approves: true }))).toBe(true)
  })

  it('leaves the desk’s queue to the coordinator: a manager waits only on what only a manager does', () => {
    const manager = me({ employee_id: 'mgr', is_manager: true, trc_ids: [REG] })
    const arrived = ticket({ status: 'pending_acceptance' })
    // It waits on the coordinator, not on them — and they have no button for it.
    expect(actionsFor(arrived, manager)).toEqual([])
    expect(waitingOnMe(arrived, manager)).toBe(false)
    expect(waitingOnMe(arrived, desk)).toBe(true)
    // One who is both has the desk's queue.
    expect(waitingOnMe(arrived, me({ is_manager: true, is_coordinator: true, trc_ids: [REG] }))).toBe(true)
  })

  it('says how a closed ticket ended when it did not come back', () => {
    expect(statusLook('closed', 'scrapped').short).toBe('Scrapped')
    expect(statusLook('closed', 'discarded').short).toBe('Discarded')
    expect(statusLook('closed', 'returned').short).toBe('Closed')
    expect(statusLook('awaiting_approval').short).toBe('Waiting for approval')
  })
})

describe('the receipt, and who raises tickets (rl_0015)', () => {
  const desk = me({ is_coordinator: true, trc_ids: [REG] })
  const engineer = me({ employee_id: 'eng', is_engineer: true, trc_ids: [REG] })
  const field = me({ employee_id: 'field' })

  it('gives the field engineer the spare back, and then the close', () => {
    const arriving = ticket({ status: 'in_transit_return' })
    expect(actionsFor(arriving, field)).toEqual(['received', 'hand_over'])
    const back = ticket({ status: 'received_back' })
    expect(actionsFor(back, field)).toEqual(['close_ticket'])
    expect(waitingOnMe(back, field)).toBe(true)
    // Not the Revive Lab's to close: they sent it, and cannot know it fits.
    expect(actionsFor(back, desk)).toEqual([])
    expect(actionsFor(back, engineer)).toEqual([])
  })

  it('does not offer a Revive Lab engineer or Purchase a ticket to raise', () => {
    expect(canRaise(engineer)).toBe(false)
    // Purchase buys for the Revive Lab; it does not send spares in (rl_0019).
    expect(canRaise(me({ is_purchase: true, trc_ids: [REG] }))).toBe(false)
    // A field engineer, and the desk, still raise.
    expect(canRaise(field)).toBe(true)
    expect(canRaise(desk)).toBe(true)
    expect(canRaise(null)).toBe(true)
    // Somebody who is both keeps it: spares arrive at their desk.
    expect(canRaise(me({ employee_id: 'both', is_engineer: true, is_coordinator: true, trc_ids: [REG] }))).toBe(true)
  })

  it('does not offer a Revive Lab manager one either, unless they run a desk (rl_0036)', () => {
    // A manager approves; spares are taken in, and their cards written, at the coordinator's desk.
    expect(canRaise(me({ is_manager: true, trc_ids: [REG] }))).toBe(false)
    expect(canRaise(me({ is_manager: true, is_engineer: true, trc_ids: [REG] }))).toBe(false)
    expect(canRaise(me({ is_manager: true, is_coordinator: true, trc_ids: [REG] }))).toBe(true)
    expect(canRaise(me({ is_manager: true, is_admin: true, trc_ids: [REG] }))).toBe(true)
    // An admin runs every desk.
    expect(canRaise(me({ is_admin: true }))).toBe(true)
    expect(canRaise(me({ is_admin: true, is_engineer: true, trc_ids: [REG] }))).toBe(true)
  })

  it('gives every tab the colour of what it holds', () => {
    expect(ticketTabs(desk).map(x => x.tone)).toEqual(['slate', 'rose', 'red', 'orange', 'green'])
    expect(ticketTabs(engineer).map(x => x.tone)).toEqual(['slate', 'rose', 'indigo', 'sky', 'green'])
  })
})

describe('components through the coordinator (rl_0016)', () => {
  const desk = me({ is_coordinator: true, trc_ids: [REG] })
  const engineer = me({ employee_id: 'eng', is_engineer: true, trc_ids: [REG] })
  const buyer = me({ employee_id: 'buyer', is_purchase: true, trc_ids: [REG] })

  const at = (status: string, route: 'local' | 'purchase' = 'local') =>
    ({ route, status } as { route: 'local' | 'purchase'; status: Parameters<typeof partActor>[0]['status'] })

  it('walks a request from the coordinator to whoever buys it and back', () => {
    // Asked for: with the coordinator, whichever route.
    expect(partActor(at('requested', 'purchase'), desk, REG, 'eng')).toBe(true)
    expect(partActor(at('requested', 'purchase'), buyer, REG, 'eng')).toBe(false)
    // Passed on: with Purchase.
    expect(partActor(at('forwarded', 'purchase'), buyer, REG, 'eng')).toBe(true)
    expect(partActor(at('forwarded', 'purchase'), desk, REG, 'eng')).toBe(false)
    // Being bought: whoever holds it.
    expect(partActor(at('accepted', 'local'), desk, REG, 'eng')).toBe(true)
    expect(partActor(at('accepted', 'purchase'), buyer, REG, 'eng')).toBe(true)
    // Bought: back to the coordinator, to write it into stock.
    expect(partActor(at('bought', 'purchase'), desk, REG, 'eng')).toBe(true)
    expect(partActor(at('bought', 'purchase'), buyer, REG, 'eng')).toBe(false)
    // Sent: the engineer confirms it.
    expect(partActor(at('sent', 'local'), engineer, REG, 'eng')).toBe(true)
    expect(partActor(at('sent', 'local'), desk, REG, 'eng')).toBe(false)
    // Finished with.
    expect(partActor(at('received', 'local'), desk, REG, 'eng')).toBe(false)
    expect(partActor(at('declined', 'local'), desk, REG, 'eng')).toBe(false)
  })

  it('counts stock waiting for the coordinator as theirs to do', () => {
    const t = ticket({
      status: 'parts_requested', engineer_id: 'eng',
      stock: [{ id: 's1', status: 'requested' }, { id: 's2', status: 'approved' }],
    })
    expect(partsWaitingOn(t, desk)).toBe(1)
    expect(waitingOnMe(t, desk)).toBe(true)
    // Not the engineer's: they asked, and are waiting.
    expect(partsWaitingOn(t, engineer)).toBe(0)
    expect(partsWaitingOn(t, buyer)).toBe(0)
  })
})

describe('make, model, a whole machine and the order (rl_0019)', () => {
  it('names a whole machine as a line of its own', () => {
    expect(ITEM_KIND_LABEL.full_machine).toBe('Full Machine')
    expect(cleanItems([{ kind: 'full_machine', name: ' ECG machine ' }])).toEqual([{ kind: 'full_machine', name: 'ECG machine' }])
  })

  it('says when the order Purchase placed is due, while it waits with the coordinator', () => {
    const ordered = partStatusLook({ route: 'purchase', status: 'bought', po_number: 'PO/42', edd: '2026-09-25' })
    expect(ordered.label.startsWith('Ordered — due ')).toBe(true)
    expect(ordered.label).toContain('2026')
    // A local purchase with its bill reads as before, and so does an order with no PO yet.
    expect(partStatusLook({ route: 'local', status: 'bought' })).toEqual(PART_STATUS.bought)
    expect(partStatusLook({ route: 'purchase', status: 'forwarded', po_number: null })).toEqual(PART_STATUS.forwarded)
  })

  it('writes PO once', () => {
    expect(poLabel('1042')).toBe('PO 1042')
    expect(poLabel('PO/2026/0042')).toBe('PO/2026/0042')
    expect(poLabel(' po-77 ')).toBe('po-77')
    expect(poLabel('P.O. 55')).toBe('P.O. 55')
    expect(poLabel('Pole-9')).toBe('PO Pole-9')
  })

  it('names where a local purchase stands', () => {
    expect(PART_PROGRESS).toEqual({ enquiry_given: 'Enquiry given', order_placed: 'Order placed' })
  })
})

describe('what waits on whom, grouped (the user, 23 Sep)', () => {
  const desk = me({ is_coordinator: true, trc_ids: [REG] })
  const engineer = me({ employee_id: 'eng', is_engineer: true, trc_ids: [REG] })

  it('does not count an assigned repair as waiting on the desk: it waits on the engineer', () => {
    const assigned = ticket({ status: 'assigned', engineer_id: 'eng' })
    expect(actionsFor(assigned, desk)).toContain('assign')   // Reassign is still offered,
    expect(waitingOnMe(assigned, desk)).toBe(false)          // but it is not a wait,
    expect(waitingOnMe(assigned, engineer)).toBe(true)       // and the engineer accepts the repair.
  })

  it('still counts an accepted spare with nobody on it as the desk one', () => {
    expect(waitingOnMe(ticket({ status: 'accepted' }), desk)).toBe(true)
  })

  it('gives the engineer what is theirs: accepting it, finishing it, confirming a component', () => {
    expect(waitingOnMe(ticket({ status: 'in_repair', engineer_id: 'eng' }), engineer)).toBe(true)
    expect(waitingOnMe(ticket({ status: 'parts_requested', engineer_id: 'eng' }), engineer)).toBe(false)
    const ready = ticket({ status: 'parts_ready', engineer_id: 'eng', parts: [{ id: 'p', route: 'local', status: 'sent' }] })
    expect(waitingOnMe(ready, engineer)).toBe(true)
  })

  it('groups by where each spare stands, in the order a spare goes', () => {
    const rows = [
      ticket({ status: 'repaired' }), ticket({ status: 'pending_acceptance' }),
      ticket({ status: 'repaired' }), ticket({ status: 'accepted' }),
    ]
    expect(statusGroups(rows).map(x => [x.label, x.rows.length])).toEqual([
      ['Pending acceptance', 1], ['Accepted', 1], ['Pending dispatch', 2],
    ])
  })
})

describe('category and criticality (rl_0024)', () => {
  const desk = me({ is_coordinator: true, trc_ids: [REG] })
  it('lets the desk change them from acceptance until it is dispatched back', () => {
    const at = { trc_id: REG, accepted_at: '2026-09-23T04:00:00Z' }
    expect(canClassify({ ...at, status: 'in_repair' }, desk)).toBe(true)
    expect(canClassify({ ...at, status: 'repaired' }, desk)).toBe(true)
    expect(canClassify({ ...at, status: 'in_transit_return' }, desk)).toBe(false)
    expect(canClassify({ ...at, status: 'closed' }, desk)).toBe(false)
    expect(canClassify({ trc_id: REG, accepted_at: null, status: 'pending_acceptance' }, desk)).toBe(false)
    expect(canClassify({ ...at, status: 'in_repair' }, me({ employee_id: 'eng', is_engineer: true, trc_ids: [REG] }))).toBe(false)
  })
})

describe('a spare sent back not working (rl_0027)', () => {
  it('counts the rounds from its returns', () => {
    expect(roundOf({ field_returns: [] })).toBe(1)
    expect(roundOf({})).toBe(1)
    expect(roundOf({ field_returns: [{}] })).toBe(2)
    expect(roundOf({ field_returns: [{}, {}] })).toBe(3)
  })

  it('says which return it was', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal))
      .toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st'])
  })

  it('leaves closing the ticket to the field engineer it went back to, once it is with them', () => {
    const t = { status: 'received_back' as const, trc_id: REG, engineer_id: 'e1', stakeholder_id: 'f1', raised_by: 'f1' }
    expect(actionsFor(t, me({ employee_id: 'f1' }))).toContain('close_ticket')
    expect(actionsFor(t, me({ employee_id: 'c1', is_coordinator: true, trc_ids: [REG] }))).not.toContain('close_ticket')
  })
})

describe('the desk’s own raise, as one step (the user, 23 Sep)', () => {
  const step = (over: Record<string, unknown>) => ({
    kind: 'status', status: 'pending_acceptance', from_status: null, action: null,
    actor_name: 'Jeevan George', note: null, at: '2026-09-23T10:28:00Z', ...over,
  })
  const raised = step({ note: 'Raised at the Revive Lab' })
  const taken = step({ status: 'accepted', from_status: 'pending_acceptance', note: 'Accepted on arrival — raised at the Revive Lab · Category B · Critical' })
  const assigned = step({ status: 'assigned', from_status: 'accepted', at: '2026-09-23T10:29:00Z' })

  it('makes the raise and the acceptance in the same moment one step, with what was said of the spare', () => {
    const merged = mergeDeskRaise([raised, taken, assigned])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ action: 'raised_at_lab', status: 'accepted', from_status: null, note: 'Category B · Critical' })
    expect(merged[1]).toBe(assigned)
  })

  it('leaves nothing to say when nothing was said', () => {
    const merged = mergeDeskRaise([raised, step({ status: 'accepted', from_status: 'pending_acceptance', note: 'Accepted on arrival — raised at the Revive Lab' })])
    expect(merged).toEqual([expect.objectContaining({ action: 'raised_at_lab', note: null })])
  })

  it('leaves a field engineer’s ticket, accepted later by the coordinator, as two steps', () => {
    const later = step({ status: 'accepted', from_status: 'pending_acceptance', actor_name: 'Henry', at: '2026-09-24T08:00:00Z', note: 'Category A · Non-critical' })
    expect(mergeDeskRaise([raised, later])).toHaveLength(2)
  })
})

describe('a spare on its way back, handed to another field engineer (rl_0028)', () => {
  const t = { status: 'in_transit_return' as const, trc_id: REG, engineer_id: 'e1', stakeholder_id: 'a', raised_by: 'a' }
  const a = me({ employee_id: 'a' }), b = me({ employee_id: 'b' }), c = me({ employee_id: 'c' })

  it('offers the one it is sent back to: received, or transfer', () => {
    expect(actionsFor(t, a)).toEqual(['received', 'hand_over'])
    expect(waitingOnMe(t, a)).toBe(true)
  })

  it('while the other decides: the first can only take it back, the other accepts or declines', () => {
    const asked = { ...t, handover: { status: 'pending' as const, to_id: 'b' } }
    expect(actionsFor(asked, a)).toEqual(['cancel_handover'])
    expect(waitingOnMe(asked, a)).toBe(false)
    expect(actionsFor(asked, b)).toEqual(['accept_handover', 'decline_handover'])
    expect(waitingOnMe(asked, b)).toBe(true)
    expect(actionsFor(asked, c)).toEqual([])
  })

  it('accepted, the new one has the same two buttons — and can pass it on again', () => {
    const theirs = { ...t, stakeholder_id: 'b', handover: { status: 'accepted' as const, to_id: 'b' } }
    expect(actionsFor(theirs, b)).toEqual(['received', 'hand_over'])
    expect(actionsFor(theirs, a)).toEqual([])
  })

  it('declined or cancelled, it is as it was', () => {
    for (const status of ['declined', 'cancelled'] as const) {
      expect(actionsFor({ ...t, handover: { status, to_id: 'b' } }, a)).toEqual(['received', 'hand_over'])
      expect(actionsFor({ ...t, handover: { status, to_id: 'b' } }, b)).toEqual([])
    }
  })
})

describe('the Revive Lab Observer (rl_0039)', () => {
  const observer = me({ employee_id: 'obs', is_observer: true, trc_ids: [REG] })

  it('only watches when Observer is the only box ticked', () => {
    expect(observesOnly(observer)).toBe(true)
    expect(observesOnly(me({ is_observer: true, is_coordinator: true, trc_ids: [REG] }))).toBe(false)
    expect(observesOnly(me({ is_observer: true, is_engineer: true, trc_ids: [REG] }))).toBe(false)
    expect(observesOnly(me({ employee_id: 'field' }))).toBe(false)
    expect(observesOnly(null)).toBe(false)
  })

  it('has nothing to press, wherever a spare stands', () => {
    for (const status of ['pending_acceptance', 'accepted', 'assigned', 'in_repair', 'parts_requested', 'repaired', 'not_repairable', 'service_denied', 'in_transit_return', 'received_back', 'closed'] as const) {
      expect(actionsFor(ticket({ status, engineer_id: 'eng' }), observer)).toEqual([])
      expect(waitingOnMe(ticket({ status, engineer_id: 'eng' }), observer)).toBe(false)
    }
    expect(runsTrc(observer, REG)).toBe(false)
    expect(canClassify({ trc_id: REG, accepted_at: '2026-09-23T04:00:00Z', status: 'in_repair' }, observer)).toBe(false)
    const parts = ticket({ status: 'parts_requested', parts: [{ id: 'a', route: 'local', status: 'requested' }], stock: [{ id: 's', status: 'requested' }] })
    expect(partsWaitingOn(parts, observer)).toBe(0)
  })

  it('is not offered a ticket to raise, unless they also run a desk', () => {
    expect(canRaise(observer)).toBe(false)
    expect(canRaise(me({ is_observer: true, is_coordinator: true, trc_ids: [REG] }))).toBe(true)
    expect(canRaise(me({ is_observer: true, is_admin: true }))).toBe(true)
  })

  it('has the list without a Waiting on you tab', () => {
    expect(ticketTabs(observer).map(x => x.label)).toEqual(['All', 'Open', 'Closed'])
    expect(ticketTabs(observer).map(x => x.tone)).toEqual(['slate', 'amber', 'green'])
    // With another role as well, that role's tabs are theirs.
    expect(ticketTabs(me({ is_observer: true, is_engineer: true, trc_ids: [REG] })).map(x => x.label))
      .toEqual(['All', 'Waiting on you', 'In repair', 'Assigned', 'Closed'])
  })

  it('still confirms a spare of their own, if the desk named them on one', () => {
    const theirs = ticket({ status: 'in_transit_return', stakeholder_id: 'obs' })
    expect(actionsFor(theirs, observer)).toEqual(['received', 'hand_over'])
    expect(waitingOnMe(theirs, observer)).toBe(true)
  })
})
