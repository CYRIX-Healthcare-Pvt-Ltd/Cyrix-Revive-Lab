import type { Workbook } from 'exceljs'
import type { PartRequest } from '@/lib/queries'
import { PART_ROUTE_LABEL } from '@/lib/tickets'

/*
  Components → Download Excel (the user, 23 Nov: "we need download excel there, components tab, for pur, coord etc,
  is it possible to get image also in excel same row?"). One row a request, as the list shows it, with the
  request's photo in the row itself. Company colours as every Cyrix Excel (black heading, red title, light grey).
*/
const BLACK = 'FF111111', RED = 'FFE30613', HEAD = 'FFF3F4F6'
const PHOTO_PX = 88            // the picture's side in the cell
const ROW_PT = 70              // a row with a picture (points)

const day = (iso: string | null | undefined) => (iso ? new Date(iso.length === 10 ? `${iso}T00:00:00+05:30` : iso)
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '')

export type ExcelRow = { r: PartRequest; waiting: string }

/** A photo made small and turned into a JPEG, so any phone format (HEIC, WebP) goes in and the file stays light. */
export type Photo = { buf: ArrayBuffer; w: number; h: number }
export async function photoJpeg(url: string): Promise<Photo | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const bmp = await createImageBitmap(await res.blob())
    const scale = Math.min(1, (PHOTO_PX * 2) / Math.max(bmp.width, bmp.height))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale))
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
    bmp.close?.()
    const blob = await new Promise<Blob | null>(ok => c.toBlob(ok, 'image/jpeg', 0.82))
    return blob ? { buf: await blob.arrayBuffer(), w: c.width, h: c.height } : null
  } catch {
    return null
  }
}

export function buildComponentsWorkbook(wb: Workbook, o: {
  title: string
  rows: ExcelRow[]
  photos: Map<string, Photo>   // by request id
}) {
  const ws = wb.addWorksheet('Components', { views: [{ state: 'frozen', ySplit: 2, xSplit: 3 }] })
  const cols: Array<[string, number, (x: ExcelRow) => string | number | null]> = [
    ['Request', 12, ({ r }) => r.ticket_code ?? r.code ?? ''],
    ['Photo', 14, () => ''],
    ['Component', 30, ({ r }) => r.name],
    ['Qty', 7, ({ r }) => r.qty],
    ['For', 30, ({ r }) => (r.ticket_id ? r.facility ?? '' : `${r.trc_name}'s stock`)],
    ['Revive Lab', 18, ({ r }) => r.trc_name],
    ['Route', 12, ({ r }) => PART_ROUTE_LABEL[r.route]],
    ['Asked by', 20, ({ r }) => r.requested_by_name ?? ''],
    ['Asked on', 13, ({ r }) => day(r.requested_at)],
    ['Waiting on', 30, ({ waiting }) => waiting],
    ['Note', 30, ({ r }) => r.note ?? ''],
    ['Part no', 14, ({ r }) => r.part_no ?? ''],
    ['Value', 12, ({ r }) => r.value ?? ''],
    ['Item', 14, ({ r }) => r.item ?? ''],
    ['Package', 12, ({ r }) => r.package ?? ''],
    ['Item code', 14, ({ r }) => r.item_code ?? ''],
    ['Accepted by', 18, ({ r }) => r.accepted_by_name ?? ''],
    ['Accepted on', 13, ({ r }) => day(r.accepted_at)],
    ['PO no', 14, ({ r }) => r.po_number ?? ''],
    ['PO date', 13, ({ r }) => day(r.po_date)],
    ['Expected delivery', 13, ({ r }) => day(r.edd)],
    ['Vendor', 20, ({ r }) => r.vendor ?? ''],
    ['Bill no', 14, ({ r }) => r.bill_no ?? ''],
    ['Bill amount (₹)', 13, ({ r }) => r.bill_amount],
    ['Bought qty', 10, ({ r }) => r.bought_qty],
    ['Purchased by', 18, ({ r }) => r.purchased_by_name ?? ''],
    ['Purchased on', 13, ({ r }) => day(r.purchased_at)],
    ['Added to stock by', 18, ({ r }) => r.stocked_by_name ?? ''],
    ['Added to stock on', 13, ({ r }) => day(r.stocked_at)],
    ['Declined reason', 26, ({ r }) => r.declined_reason ?? ''],
  ]
  ws.columns = cols.map(([, width]) => ({ width }))

  // Title row, then headings.
  ws.mergeCells(1, 1, 1, cols.length)
  const t = ws.getCell(1, 1)
  t.value = o.title
  t.font = { bold: true, size: 13, color: { argb: RED } }
  ws.getRow(1).height = 22
  const head = ws.getRow(2)
  cols.forEach(([label], i) => {
    const c = head.getCell(i + 1)
    c.value = label
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLACK } }
    c.alignment = { vertical: 'middle', wrapText: true }
  })
  head.height = 30
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: cols.length } }

  o.rows.forEach((x, i) => {
    const rowNo = i + 3
    const row = ws.getRow(rowNo)
    cols.forEach(([, , get], j) => {
      const c = row.getCell(j + 1)
      const v = get(x)
      c.value = v === null || v === undefined ? '' : v
      c.alignment = { vertical: 'middle', wrapText: true }
      if (i % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD } }
    })
    row.getCell(24).numFmt = '#,##0.00'
    const photo = o.photos.get(x.r.id)
    if (photo) {
      const id = wb.addImage({ buffer: photo.buf, extension: 'jpeg' })
      const k = PHOTO_PX / Math.max(photo.w, photo.h)
      // Inside the Photo cell (column B), a little in from its corner.
      ws.addImage(id, { tl: { col: 1.08, row: rowNo - 1 + 0.06 }, ext: { width: Math.round(photo.w * k), height: Math.round(photo.h * k) }, editAs: 'oneCell' })
      row.height = ROW_PT
    } else {
      row.height = 30
    }
  })
}

/** "Revive Lab components - All time - 2026-11-23.xlsx" */
export const componentsFileName = (what: string, now = new Date()) =>
  `Revive Lab components - ${what.replace(/[\\/:*?"<>|]/g, '-')} - ${now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}.xlsx`
