import { describe, it, expect } from 'vitest'
import { partNamed, partNoSuggestions, readStockGrid, stockDiff, STOCK_SHEET_HEADINGS, type StockRow } from './stockSheet'

// The first rows of the Revive Labs' own sheet, and the odd ones in it.
const HEAD = ['SL:NO', 'Cyrix- Part No', 'Mfr Pt No./Value', 'Item', 'Type', 'Available QTY']
const grid: unknown[][] = [
  HEAD,
  [1, 'C-001', 'IRF 640', 'MOSFET', 'TH', 8],
  [2, 'C-002', 'P80NF10', 'MOSFET', 'TH', 49],
  [4, 'C-004', '4D0N65F', 'MOSFET', 'TH', 0],
  [30, 'C-030', 'EMPTY', 'EMPTY', 'EMPTY', 'EMPTY'],
  [31, 'C-031', 'LM358', '0', '0', '`3'],
  [32, 'C-032', 'BC547', 'TRANSISTOR', 'TH', 'many'],
  [33, 'C-001', 'IRF 640 again', 'MOSFET', 'TH', 2],
  [34, '', '', '', '', ''],
]

describe('reading the stock sheet', () => {
  const read = readStockGrid(grid)

  it('finds the columns by their headings and reads each part', () => {
    expect(read.rows[0]).toEqual({ part_no: 'C-001', value: 'IRF 640', item: 'MOSFET', package: 'TH', qty: 8 })
    expect(read.rows.map(r => r.part_no)).toEqual(['C-001', 'C-002', 'C-004', 'C-031'])
  })

  it('keeps a part with none in stock', () => {
    expect(read.rows.find(r => r.part_no === 'C-004')?.qty).toBe(0)
  })

  it('leaves out the EMPTY slots, and counts them', () => {
    expect(read.emptySlots).toBe(1)
  })

  it('reads "`3" as 3 and says so; "0" in Item and Type means nothing there', () => {
    expect(read.rows.find(r => r.part_no === 'C-031')).toEqual({ part_no: 'C-031', value: 'LM358', item: null, package: null, qty: 3 })
    expect(read.tidied).toEqual(['C-031: "`3" read as 3'])
  })

  it('reports what it cannot read instead of guessing', () => {
    expect(read.problems).toEqual([
      'C-032: quantity "many" is not a count',
      'C-001: in the sheet twice — the first row is used',
    ])
  })

  it('still reads a sheet with its columns in another order', () => {
    const moved = readStockGrid([
      ['Available QTY', 'Item', 'Cyrix- Part No', 'Mfr Pt No./Value'],
      [5, 'IC', 'C-100', 'TL074'],
    ])
    expect(moved.rows).toEqual([{ part_no: 'C-100', value: 'TL074', item: 'IC', package: null, qty: 5 }])
  })

  it('says so when there is no part number column at all', () => {
    expect(readStockGrid([['Name', 'Count'], ['x', 1]]).problems).toHaveLength(1)
  })
})

describe('what an upload would change', () => {
  const current: StockRow[] = [
    { part_no: 'C-001', value: 'IRF 640', item: 'MOSFET', package: 'TH', qty: 5 },
    { part_no: 'C-002', value: 'P80NF10', item: 'MOSFET', package: 'TH', qty: 49 },
    { part_no: 'C-900', value: 'OLD', item: 'IC', package: 'TH', qty: 1 },
  ]
  const diff = stockDiff(readStockGrid(grid).rows, current)

  it('tells new parts, changed counts, unchanged ones and parts the sheet leaves out apart', () => {
    expect(diff.added.map(r => r.part_no)).toEqual(['C-004', 'C-031'])
    expect(diff.changed).toEqual([{ row: expect.objectContaining({ part_no: 'C-001', qty: 8 }), before: current[0], fields: ['Qty 5 → 8'] }])
    expect(diff.same).toBe(1)
    expect(diff.notInSheet).toBe(1)
  })
})

describe('the counting sheet of 29 Sep: BIN and Location', () => {
  // The Revive Lab's own sheet, as it came: " BIN" with a space before it.
  const sheet = readStockGrid([
    ['Cyrix- Part No', 'Value', 'Item', 'Type', ' BIN', 'Location', 'Qty'],
    ['C-001', 'IRF 640', 'MOSFET', 'TH', 'B1', 'A', 4],
    ['C-923', '3.6V 60mAH', 'NI MH BATTERY RECH', 'TH', 'B1', 'A2', 1],
    ['C-924', 'FUSE 3.15A ', 'GLASS FUSE', 'EXT', '', '', 10],
  ])

  it('reads its seven columns, the template the screen downloads', () => {
    expect([...STOCK_SHEET_HEADINGS]).toEqual(['Cyrix- Part No', 'Value', 'Item', 'Type', 'BIN', 'Location', 'Qty'])
    expect(sheet.rows[0]).toEqual({ part_no: 'C-001', value: 'IRF 640', item: 'MOSFET', package: 'TH', bin: 'B1', location: 'A', qty: 4 })
    expect(sheet.rows[2]).toMatchObject({ value: 'FUSE 3.15A', bin: null, location: null })
  })

  it('an older sheet, without them, says nothing about them', () => {
    expect('bin' in readStockGrid(grid).rows[0]).toBe(false)
  })

  it('says what replacing would change, BIN and Location with the rest', () => {
    const current: StockRow[] = [
      { part_no: 'C-001', value: 'IRF 640', item: 'MOSFET', package: 'TH', bin: null, location: null, qty: 5 },
      { part_no: 'C-923', value: '3.6V 60mAH', item: 'NI MH BATTERY RECH', package: 'TH', bin: 'B1', location: 'A2', qty: 1 },
    ]
    const diff = stockDiff(sheet.rows, current)
    expect(diff.changed).toEqual([expect.objectContaining({ fields: ['BIN — → B1', 'Location — → A', 'Qty 5 → 4'] })])
    expect(diff.same).toBe(1)
    expect(diff.added.map(r => r.part_no)).toEqual(['C-924'])
  })
})

describe('part numbers for a new part', () => {
  const parts = ['C-001', 'C-002', 'C-004', 'C-007', 'C-1329', 'X-99 odd'].map(part_no => ({ part_no }))

  it('offers the next after the highest, then the free ones in between', () => {
    expect(partNoSuggestions(parts, 4)).toEqual(['C-1330', 'C-003', 'C-005', 'C-006'])
    expect(partNoSuggestions([])).toEqual(['C-001'])
  })

  it('finds the part a number already belongs to, spaces and case aside — but not the one being edited', () => {
    expect(partNamed(parts, ' c-004 ')?.part_no).toBe('C-004')
    expect(partNamed(parts, 'C-003')).toBeUndefined()
    expect(partNamed(parts, 'C-004', parts[2])).toBeUndefined()
  })
})
