import { describe, it, expect } from 'vitest'
import { readStockGrid, stockDiff, type StockRow } from './stockSheet'

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
    expect(diff.changed).toEqual([{ row: expect.objectContaining({ part_no: 'C-001', qty: 8 }), before: current[0] }])
    expect(diff.same).toBe(1)
    expect(diff.notInSheet).toBe(1)
  })
})
