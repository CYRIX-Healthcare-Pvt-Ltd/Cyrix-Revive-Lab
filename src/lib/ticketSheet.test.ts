import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import type { Ticket } from './queries'
import { excelDate, excelDateTime, ticketFileName, ticketSheet, ticketWorkbook, TICKET_COLUMNS } from './ticketSheet'

// Everyone using it is in India: the times in the sheet are India's. Set
// before anything below builds a workbook, which happens as the file loads.
process.env.TZ = 'Asia/Kolkata'

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 't1', number: 9, code: 'RL-09', status: 'pending_acceptance', trc_id: 'lab', trc_name: 'Cochin Revive lab',
  source_ticket_no: 'SR-99', facility: 'DH Kollam', district: 'Kollam', state: 'Kerala', bemmp_code: 'KL',
  asks_billing_estimate: false, source: 'hospital', items: [], spare_name: 'SMPS', equipment_name: 'Defibrillator',
  stakeholder_name: 'Anand K', stakeholder_ecode: 'E1', engineer_name: null, engineer_ecode: null,
  created_at: '2026-09-22T05:19:00Z', closed_at: null, closure: null, proposal: null, outcome: null, final_working: null,
  spare_category: null, criticality: null, accepted_at: null, dispatched_at: null, scrapped_at: null,
  billing_estimate: null, field_returns: [], in_dispatched_on: null, out_dispatched_on: null, expected_by: null, received_at: null,
  ...over,
} as unknown as Ticket)

const column = (heading: string) => {
  const i = TICKET_COLUMNS.findIndex(c => c.heading === heading)
  if (i < 0) throw new Error(`no column ${heading}`)
  return (t: Ticket, now = Date.parse('2026-09-23T06:30:00Z')) => ticketSheet([t], now).rows[0][i]
}

describe('dates Excel sorts as dates', () => {
  it('turns a moment into India’s time, in Excel’s count of days', () => {
    // 04:30 UTC is 10:00 in India: day 46288 and ten twenty-fourths.
    expect(excelDateTime('2026-09-23T04:30:00Z')).toBeCloseTo(46288 + 10 / 24, 9)
  })

  it('keeps a courier’s date a whole day', () => {
    expect(excelDate('2026-09-25')).toBe(46290)
    expect(excelDate(null)).toBeNull()
  })
})

describe('one row a ticket, the list’s columns first', () => {
  it('starts as the list does', () => {
    expect(TICKET_COLUMNS.slice(0, 4).map(c => c.heading)).toEqual(['Ticket', 'Ticket ID', 'Raised on', 'Status'])
  })

  it('says Pvt, Govt or Warehouse after the hospital', () => {
    const sector = column('Govt / Pvt')
    expect(sector(ticket())).toBe('Govt')
    expect(sector(ticket({ bemmp_code: 'Pvt', asks_billing_estimate: true }))).toBe('Pvt')
    expect(sector(ticket({ source: 'warehouse', bemmp_code: null }))).toBe('Warehouse')
  })

  it('lists every spare and accessory, with what each is', () => {
    const items = column('Spares and accessories')
    expect(items(ticket({ items: [{ kind: 'spare', name: 'SMPS board' }, { kind: 'accessory', name: 'Power cable' }] })))
      .toBe('SMPS board (Spare); Power cable (Accessory)')
    expect(items(ticket())).toBe('SMPS')
  })

  it('says how it closed', () => {
    const final = column('Final status')
    expect(final(ticket({ status: 'closed', closure: 'returned', final_working: true }))).toBe('Fitted and working')
    expect(final(ticket({ status: 'closed', closure: 'returned', final_working: false }))).toBe('Fitted — not working')
    expect(final(ticket({ status: 'closed', closure: 'returned', source: 'warehouse' }))).toBe('Back in warehouse stock')
    expect(final(ticket({ status: 'closed', closure: 'scrapped' }))).toBe('Scrapped')
    expect(final(ticket())).toBeNull()
  })

  it('counts the returns, and gives the latest reason', () => {
    const r = { reason: 'first' }, s = { reason: 'Same fault again' }
    const t = ticket({ field_returns: [r, s] as unknown as Ticket['field_returns'] })
    expect(column('Returned not working (times)')(t)).toBe(2)
    expect(column('Why it came back (latest)')(t)).toBe('Same fault again')
    expect(column('Returned not working (times)')(ticket())).toBeNull()
  })

  it('weighs the category TAT', () => {
    const tat = column('Category TAT')
    // Category C is a day: accepted 30 hours before now, not dispatched.
    expect(tat(ticket({ spare_category: 'C', accepted_at: '2026-09-22T00:30:00Z' }))).toBe('Exceeded by 6h')
    expect(tat(ticket({ spare_category: 'A', accepted_at: '2026-09-22T06:30:00Z' }))).toBe('Within TAT — 2d left')
    expect(tat(ticket({ spare_category: 'A', accepted_at: '2026-09-20T06:30:00Z', dispatched_at: '2026-09-21T06:30:00Z' }))).toBe('Within TAT')
    expect(tat(ticket())).toBeNull()
  })
})

describe('the workbook', () => {
  const wb = ticketWorkbook(XLSX, [
    ticket({ billing_estimate: 12500.5, in_dispatched_on: '2026-09-21' }),
    ticket({ code: 'RL-10', number: 10 }),
  ])
  const ws = wb.Sheets.Tickets
  const at = (heading: string, row: number) =>
    ws[XLSX.utils.encode_cell({ r: row, c: TICKET_COLUMNS.findIndex(c => c.heading === heading) })]

  it('has the headings, a row a ticket and the filter arrows', () => {
    expect(ws.A1.v).toBe('Ticket')
    expect(ws.A2.v).toBe('RL-09')
    expect(ws.A3.v).toBe('RL-10')
    expect(ws['!autofilter']?.ref).toMatch(/^A1:[A-Z]+3$/)
    expect(ws['!cols']).toHaveLength(TICKET_COLUMNS.length)
  })

  it('writes dates as dates and rupees as rupees', () => {
    expect(at('Raised on', 1)).toMatchObject({ t: 'n', z: 'dd mmm yyyy, h:mm AM/PM' })
    expect(at('Sent on', 1)).toMatchObject({ t: 'n', v: 46286, z: 'dd mmm yyyy' })
    expect(at('Estimated billing (₹)', 1)).toMatchObject({ t: 'n', v: 12500.5, z: '#,##0.00' })
    // Nothing recorded is an empty cell, not the word null.
    expect(at('Estimated billing (₹)', 2)).toBeUndefined()
  })

  it('reads back in Excel’s own words', () => {
    const back = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' }).Sheets.Tickets
    const raised = back[XLSX.utils.encode_cell({ r: 1, c: 2 })]
    expect(raised.w).toBe('22 Sep 2026, 10:49 AM')
  })
})

describe('the file’s name', () => {
  it('says the tab and the day', () => {
    expect(ticketFileName('Waiting on you', new Date(2026, 8, 23, 18, 0))).toBe('Revive Lab tickets - Waiting on you - 2026-09-23.xlsx')
  })
})
