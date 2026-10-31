import { describe, expect, it } from 'vitest'
import { readWarehouseGrid } from './warehouseSheet'

const HEAD = ['Document Number', 'Item Code', 'Description', 'Quantity', 'Barcode', 'Complaint']

describe("a warehouse's sheet, a ticket a unit (rl_0063)", () => {
  it('reads their headings, Complaint as the issue', () => {
    const { units } = readWarehouseGrid([HEAD, ['D1', 'I1', 'SMPS board', 1, 'BC1', 'No power']])
    expect(units).toEqual([{ doc: 'D1', item: 'I1', desc: 'SMPS board', barcode: 'BC1', issue: 'No power' }])
  })

  it('splits a quantity of 2 into two, sharing out the barcodes', () => {
    const { units } = readWarehouseGrid([HEAD, ['D1', 'I1', 'Probe', 2, 'BC1, BC2', 'Noisy']])
    expect(units.map(u => u.barcode)).toEqual(['BC1', 'BC2'])
  })

  it('gives a single barcode, and every other field, to each of the units', () => {
    const { units } = readWarehouseGrid([HEAD, ['D1', 'I1', 'Probe', '2 Nos', 'BC1', 'Noisy']])
    expect(units).toEqual([
      { doc: 'D1', item: 'I1', desc: 'Probe', barcode: 'BC1', issue: 'Noisy' },
      { doc: 'D1', item: 'I1', desc: 'Probe', barcode: 'BC1', issue: 'Noisy' },
    ])
  })

  it('writes a long numeric barcode out whole, skips empty rows, finds headings under a title', () => {
    const { units } = readWarehouseGrid([['Defective spares'], [], HEAD, ['', '', '', '', '', ''], ['D1', '', 'Board', '', 8901234567890, 'x']])
    expect(units).toHaveLength(1)
    expect(units[0].barcode).toBe('8901234567890')
  })

  it('reads the template, the card\'s names in its order', () => {
    const { units } = readWarehouseGrid([
      ['Document number', 'Item code', 'Quantity', 'Barcode', 'Spares and accessories', 'Issue identified'],
      ['D1', 'I1', 1, 'BC1', 'SMPS board', 'No power'],
    ])
    expect(units).toEqual([{ doc: 'D1', item: 'I1', desc: 'SMPS board', barcode: 'BC1', issue: 'No power' }])
  })

  it('says what is wrong with a sheet it cannot read', () => {
    expect(readWarehouseGrid([['Name', 'Age']]).error).toBeTruthy()
    expect(readWarehouseGrid([['Document Number', 'Item Code']]).error).toMatch(/Spares and accessories/)
    expect(readWarehouseGrid([HEAD]).error).toMatch(/no rows/)
  })
})
