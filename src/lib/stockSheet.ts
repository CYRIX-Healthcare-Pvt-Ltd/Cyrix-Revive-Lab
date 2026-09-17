/**
 * The component stock sheet, read.
 *
 * The sheet the Revive Labs keep has six columns — SL:NO, Cyrix- Part No,
 * Mfr Pt No./Value, Item, Type, Available QTY — and a thousand-odd rows,
 * some of them reserved part numbers marked EMPTY. The columns are found by
 * their headings rather than their places, so a sheet with a column moved
 * or added still reads.
 *
 * Nothing here talks to the database: this turns the grid into rows the
 * upload can send, says what it left out and why, and — against the stock
 * as it stands — what the upload will change, so the coordinator sees that
 * before anything moves.
 */

export interface StockRow {
  part_no: string
  value: string | null
  item: string | null
  package: string | null
  qty: number
}

export interface SheetRead {
  rows: StockRow[]
  /** Part numbers kept for later, marked EMPTY in the sheet. */
  emptySlots: number
  /** Quantities written oddly but clear enough to read — "`3" is 3. */
  tidied: string[]
  /** Rows that could not be read, and why. They are not uploaded. */
  problems: string[]
}

type Col = keyof StockRow

const HEADINGS: Array<[Col, RegExp]> = [
  ['part_no', /cyrix.*part|part\s*no|part\s*number|part\s*#/i],
  ['value', /mfr|manufacturer|value/i],
  ['item', /^\s*item\s*$|description|component/i],
  ['package', /^\s*type\s*$|package|mount/i],
  ['qty', /qty|quantity|stock|available/i],
]

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).trim()

/** "0", "EMPTY" and blanks say nothing about a part. */
const meaningful = (v: unknown): string | null => {
  const s = text(v)
  return s === '' || s === '0' || /^empty$/i.test(s) ? null : s
}

/** The heading row and where each column is, or null when the sheet has no part number column. */
function findColumns(grid: unknown[][]): { at: number; cols: Partial<Record<Col, number>> } | null {
  for (let r = 0; r < Math.min(grid.length, 15); r++) {
    const row = grid[r] ?? []
    const cols: Partial<Record<Col, number>> = {}
    row.forEach((cell, c) => {
      const h = text(cell)
      if (!h) return
      for (const [col, re] of HEADINGS) {
        // The first column a heading matches keeps it: "Cyrix- Part No" before "Mfr Pt No./Value".
        if (cols[col] === undefined && re.test(h) && !Object.values(cols).includes(c)) { cols[col] = c; break }
      }
    })
    if (cols.part_no !== undefined && cols.qty !== undefined) return { at: r, cols }
  }
  return null
}

export function readStockGrid(grid: unknown[][]): SheetRead {
  const found = findColumns(grid)
  if (!found) {
    return { rows: [], emptySlots: 0, tidied: [], problems: ['No Part No and QTY columns were found in the sheet.'] }
  }
  const { at, cols } = found
  const cell = (row: unknown[], col: Col) => (cols[col] === undefined ? '' : row[cols[col]!])

  const rows: StockRow[] = []
  const tidied: string[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  let emptySlots = 0

  for (let r = at + 1; r < grid.length; r++) {
    const row = grid[r] ?? []
    const part = text(cell(row, 'part_no'))
    if (!part) continue
    const rawQty = cell(row, 'qty')
    const item = text(cell(row, 'item'))

    if (/^empty$/i.test(item) || /^empty$/i.test(text(rawQty))) { emptySlots++; continue }

    let qty: number | null = null
    if (typeof rawQty === 'number') {
      qty = Number.isInteger(rawQty) && rawQty >= 0 ? rawQty : null
    } else {
      const s = text(rawQty)
      if (s === '') qty = 0
      else if (/^\d+$/.test(s)) qty = Number(s)
      else {
        const digits = s.replace(/[^\d]/g, '')
        // One number with stray marks around it: "`3", "3 nos". Two numbers, or none, is not a count.
        if (digits && /^[^\d]*\d+[^\d]*$/.test(s)) { qty = Number(digits); tidied.push(`${part}: "${s}" read as ${qty}`) }
      }
    }
    if (qty === null) { problems.push(`${part}: quantity "${text(rawQty)}" is not a count`); continue }

    const key = part.toLowerCase()
    if (seen.has(key)) { problems.push(`${part}: in the sheet twice — the first row is used`); continue }
    seen.add(key)

    if (part.length > 40) { problems.push(`${part.slice(0, 40)}…: part number longer than 40 characters`); continue }

    rows.push({
      part_no: part,
      value: meaningful(cell(row, 'value'))?.slice(0, 160) ?? null,
      item: meaningful(item)?.slice(0, 80) ?? null,
      package: meaningful(cell(row, 'package'))?.slice(0, 40) ?? null,
      qty,
    })
  }
  return { rows, emptySlots, tidied, problems }
}

export interface StockDiff {
  added: StockRow[]
  changed: Array<{ row: StockRow; before: StockRow }>
  same: number
  /** In the stock but not in the sheet — left as they are. */
  notInSheet: number
}

/** What uploading these rows would do to the stock as it stands. */
export function stockDiff(rows: readonly StockRow[], current: readonly StockRow[]): StockDiff {
  const byPart = new Map(current.map(c => [c.part_no.trim().toLowerCase(), c]))
  const added: StockRow[] = []
  const changed: StockDiff['changed'] = []
  let same = 0
  for (const row of rows) {
    const before = byPart.get(row.part_no.toLowerCase())
    if (!before) { added.push(row); continue }
    byPart.delete(row.part_no.toLowerCase())
    if (before.value !== row.value || before.item !== row.item || before.package !== row.package || before.qty !== row.qty) {
      changed.push({ row, before })
    } else {
      same++
    }
  }
  return { added, changed, same, notInSheet: byPart.size }
}
