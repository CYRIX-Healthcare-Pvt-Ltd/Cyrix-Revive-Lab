/**
 * A warehouse's Excel sheet, as its team sends it (the user, 30 Oct): Document Number, Item Code,
 * Description, Quantity, Barcode, Complaint. The template has the card's names, in its order (the user: "give the
 * same field names"), and their own headings are read too.
 *
 * One ticket a unit: a quantity of 2 is two tickets. The barcodes in the cell are shared out between
 * them, one each, when the cell has more than one; a single barcode goes on the first, and the rest are
 * typed on the page before raising.
 */
export const SHEET_HEADERS = ['Document number', 'Item code', 'Quantity', 'Barcode', 'Spares and accessories', 'Issue identified'] as const

export interface SheetUnit { doc: string; item: string; desc: string; barcode: string; issue: string }

/** More than this in one sheet is two sheets: each is a ticket raised one after another. */
export const MAX_UNITS = 200

const COLUMN: Record<string, keyof SheetUnit | 'qty'> = {
  documentnumber: 'doc', documentno: 'doc', docno: 'doc', docnumber: 'doc', document: 'doc',
  itemcode: 'item',
  sparesandaccessories: 'desc', spare: 'desc', sparename: 'desc', description: 'desc', itemdescription: 'desc', itemname: 'desc',
  quantity: 'qty', qty: 'qty',
  barcode: 'barcode', barcodes: 'barcode', serialnumber: 'barcode', serialno: 'barcode',
  issueidentified: 'issue', complaint: 'issue', issue: 'issue',
}

const key = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
// A long barcode Excel holds as a number is written out whole, not as 8.9E+12.
const text = (v: unknown) => (typeof v === 'number' ? (Number.isInteger(v) ? v.toFixed(0) : String(v)) : String(v ?? '').trim())

export function readWarehouseGrid(grid: readonly (readonly unknown[])[]): { units: SheetUnit[]; error?: string } {
  // The headings: the first of the top rows that names two of the columns.
  const at = grid.slice(0, 10).findIndex(row => row.filter(c => COLUMN[key(c)]).length >= 2)
  if (at < 0) return { units: [], error: 'The headings were not found — use the template’s.' }
  const cols = new Map<keyof SheetUnit | 'qty', number>()
  grid[at].forEach((c, i) => { const k = COLUMN[key(c)]; if (k && !cols.has(k)) cols.set(k, i) })
  if (!cols.has('desc')) return { units: [], error: 'The sheet needs a Spares and accessories column.' }
  const cell = (row: readonly unknown[], k: keyof SheetUnit | 'qty') => {
    const i = cols.get(k)
    return i === undefined ? '' : text(row[i])
  }

  const units: SheetUnit[] = []
  for (const row of grid.slice(at + 1)) {
    if (!row.some(c => text(c))) continue
    const qty = Math.max(1, Math.min(50, parseInt(cell(row, 'qty'), 10) || 1))
    const codes = cell(row, 'barcode').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)
    for (let u = 0; u < qty; u++) {
      units.push({
        doc: cell(row, 'doc'), item: cell(row, 'item'), desc: cell(row, 'desc'), issue: cell(row, 'issue'),
        barcode: codes.length <= 1 ? (u === 0 ? codes[0] ?? '' : '') : u < qty - 1 ? codes[u] ?? '' : codes.slice(u).join(', '),
      })
    }
    if (units.length > MAX_UNITS) return { units: [], error: `More than ${MAX_UNITS} tickets in one sheet — split it in two.` }
  }
  if (!units.length) return { units, error: 'The sheet has no rows under its headings.' }
  return { units }
}

/** The template: the headings, and room to type. */
export function templateBook(XLSX: typeof import('xlsx')) {
  const ws = XLSX.utils.aoa_to_sheet([[...SHEET_HEADERS]])
  ws['!cols'] = [18, 14, 10, 22, 36, 40].map(wch => ({ wch }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Tickets')
  return wb
}
