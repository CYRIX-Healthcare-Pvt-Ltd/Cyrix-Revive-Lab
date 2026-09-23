/**
 * The Tickets page as a spreadsheet: whatever the list shows this person —
 * the tab, the filters, the search, the order — one row a ticket (the user,
 * 23 Sep: "what is there in their ticket tab, downloaded in Excel"). The
 * list's own columns come first, in its order; then everything else the
 * ticket records, from the route card to how it closed.
 *
 * Dates are real dates, so Excel sorts and filters them: numbers in Excel's
 * own count of days, worked out here — the library's conversion drifts by a
 * few seconds in India's time zone — and shown in the app's way, 23 Sep 2026,
 * 10:49 AM.
 */
import type { Ticket } from './queries'
import { CRITICALITY_LABEL, ITEM_KIND_LABEL, OUTCOME_LABEL, statusLook } from './tickets'
import { categoryTat, formatSpan } from './tat'

export type Cell = string | number | null

type Kind = 'text' | 'datetime' | 'date' | 'money' | 'number'

interface Column {
  heading: string
  /** In characters, for Excel's column width. */
  width: number
  kind: Kind
  value: (t: Ticket, now: number) => Cell
}

const DAY = 86_400_000
/** Excel counts days from 30 Dec 1899; 1 Jan 1970 is day 25569. */
const EPOCH = 25_569

/** A moment, as Excel's day number in this device's time — India's, for everyone using it. */
export function excelDateTime(iso: string | null | undefined): number | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return (d.getTime() - d.getTimezoneOffset() * 60_000) / DAY + EPOCH
}

/** A day with no time — a courier's date — as Excel's whole day number. */
export function excelDate(day: string | null | undefined): number | null {
  const m = day?.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY + EPOCH
}

const person = (name: string | null | undefined, ecode: string | null | undefined) =>
  name ? (ecode ? `${name} (${ecode})` : name) : null

/** Pvt, Govt — or a warehouse's, which has neither (the list's tag after the hospital). */
function sector(t: Ticket): string | null {
  if (t.source === 'warehouse') return 'Warehouse'
  if (!t.bemmp_code) return null
  return (t.asks_billing_estimate ?? t.bemmp_code.toLowerCase() === 'pvt') ? 'Pvt' : 'Govt'
}

/** "Within TAT", "Within TAT — 1d 4h left", "Exceeded by 2d 3h" — against the category's days (rl_0024). */
function tatWords(t: Ticket, now: number): string | null {
  const tat = categoryTat(t, now)
  if (!tat) return null
  if (tat.exceeded) return `Exceeded by ${formatSpan(tat.overMs)}`
  return tat.endedAt !== null ? 'Within TAT' : `Within TAT — ${formatSpan(-tat.overMs)} left`
}

/** How it ended, as the ticket page says it. */
function finalStatus(t: Ticket): string | null {
  if (t.status !== 'closed') return null
  if (t.closure === 'scrapped') return 'Scrapped'
  if (t.closure === 'discarded') return 'Discarded — never sent'
  if (t.source === 'warehouse') return 'Back in warehouse stock'
  if (t.final_working === null) return 'Closed'
  return t.final_working ? 'Fitted and working' : 'Fitted — not working'
}

/** Every spare and accessory, with what each is; a ticket from before the list has only its spare's name. */
function items(t: Ticket): string | null {
  const list = t.items ?? []
  if (list.length === 0) return t.spare_name
  return list.map(i => `${i.name} (${ITEM_KIND_LABEL[i.kind] ?? i.kind})`).join('; ')
}

function ageDays(t: Ticket, now: number): number {
  const end = t.closed_at ? Date.parse(t.closed_at) : now
  return Math.round((Math.max(0, end - Date.parse(t.created_at)) / DAY) * 10) / 10
}

export const TICKET_COLUMNS: readonly Column[] = [
  // The list's columns, in its order.
  { heading: 'Ticket', width: 9, kind: 'text', value: t => t.code },
  { heading: 'Ticket ID', width: 14, kind: 'text', value: t => t.source_ticket_no },
  { heading: 'Raised on', width: 22, kind: 'datetime', value: t => excelDateTime(t.created_at) },
  { heading: 'Status', width: 22, kind: 'text', value: t => statusLook(t.status, t.closure, t.proposal).short },
  { heading: 'Returned not working (times)', width: 12, kind: 'number', value: t => (t.field_returns?.length || null) },
  { heading: 'Category', width: 9, kind: 'text', value: t => t.spare_category },
  { heading: 'Criticality', width: 12, kind: 'text', value: t => (t.criticality ? CRITICALITY_LABEL[t.criticality] : null) },
  { heading: 'Category TAT', width: 26, kind: 'text', value: tatWords },
  { heading: 'Hospital / warehouse', width: 28, kind: 'text', value: t => t.facility },
  { heading: 'Govt / Pvt', width: 10, kind: 'text', value: sector },
  { heading: 'Spares and accessories', width: 34, kind: 'text', value: items },
  { heading: 'Equipment', width: 22, kind: 'text', value: t => t.equipment_name },
  { heading: 'Revive Lab', width: 22, kind: 'text', value: t => t.trc_name },
  { heading: 'Field engineer / in-charge', width: 26, kind: 'text', value: t => person(t.stakeholder_name, t.stakeholder_ecode) },
  { heading: 'Revive Lab engineer', width: 24, kind: 'text', value: t => person(t.engineer_name, t.engineer_ecode) },
  { heading: 'Age (days)', width: 10, kind: 'number', value: ageDays },
  // Then the rest of the route card, and the journey.
  { heading: 'BEMMP', width: 9, kind: 'text', value: t => t.bemmp_code },
  { heading: 'Contract', width: 9, kind: 'text', value: t => t.contract_type },
  { heading: 'District', width: 16, kind: 'text', value: t => t.district },
  { heading: 'State', width: 14, kind: 'text', value: t => t.state },
  { heading: 'Make', width: 16, kind: 'text', value: t => t.equipment_make },
  { heading: 'Model', width: 16, kind: 'text', value: t => t.equipment_model },
  { heading: 'Equipment barcode', width: 18, kind: 'text', value: t => t.equipment_barcode },
  { heading: 'Issue', width: 40, kind: 'text', value: t => t.issue },
  { heading: 'Their manager', width: 22, kind: 'text', value: t => t.stakeholder_manager_name },
  { heading: 'Sent by', width: 22, kind: 'text', value: t => t.raised_by_name },
  { heading: 'Contact number', width: 15, kind: 'text', value: t => t.contact_number },
  { heading: 'Courier to the Revive Lab', width: 18, kind: 'text', value: t => t.in_courier },
  { heading: 'AWB to the Revive Lab', width: 18, kind: 'text', value: t => t.in_awb },
  { heading: 'Sent on', width: 13, kind: 'date', value: t => excelDate(t.in_dispatched_on) },
  { heading: 'Accepted on', width: 22, kind: 'datetime', value: t => excelDateTime(t.accepted_at) },
  { heading: 'Repair expected by', width: 13, kind: 'date', value: t => excelDate(t.expected_by) },
  { heading: 'Repair outcome', width: 22, kind: 'text', value: t => (t.outcome ? OUTCOME_LABEL[t.outcome] : null) },
  { heading: 'Dispatched back on', width: 13, kind: 'date', value: t => excelDate(t.out_dispatched_on) },
  { heading: 'Return courier', width: 16, kind: 'text', value: t => t.out_courier },
  { heading: 'Return AWB', width: 18, kind: 'text', value: t => t.out_awb },
  { heading: 'Estimated billing (₹)', width: 14, kind: 'money', value: t => (t.billing_estimate === null || t.billing_estimate === undefined ? null : Number(t.billing_estimate)) },
  { heading: 'Received back on', width: 22, kind: 'datetime', value: t => excelDateTime(t.received_at) },
  { heading: 'Final status', width: 22, kind: 'text', value: finalStatus },
  { heading: 'Closed on', width: 22, kind: 'datetime', value: t => excelDateTime(t.closed_at) },
  { heading: 'Why it came back (latest)', width: 40, kind: 'text', value: t => t.field_returns?.[t.field_returns.length - 1]?.reason ?? null },
  { heading: 'Return address', width: 40, kind: 'text', value: t => t.return_address },
]

/**
 * The columns, with "Team of" after the field engineer when the list shows a
 * manager which of their teams each ticket is from (rl_0029).
 */
function columnsFor(teamOf?: (t: Ticket) => string | null): readonly Column[] {
  if (!teamOf) return TICKET_COLUMNS
  const at = TICKET_COLUMNS.findIndex(c => c.heading === 'Field engineer / in-charge') + 1
  const team: Column = { heading: 'Team of', width: 22, kind: 'text', value: t => teamOf(t) }
  return [...TICKET_COLUMNS.slice(0, at), team, ...TICKET_COLUMNS.slice(at)]
}

/** The headings and one row a ticket, in the order given. */
export function ticketSheet(
  tickets: readonly Ticket[], now = Date.now(), teamOf?: (t: Ticket) => string | null,
): { headings: string[]; rows: Cell[][] } {
  const columns = columnsFor(teamOf)
  return {
    headings: columns.map(c => c.heading),
    rows: tickets.map(t => columns.map(c => {
      const v = c.value(t, now)
      return v === undefined || v === '' ? null : v
    })),
  }
}

const FORMAT: Partial<Record<Kind, string>> = {
  datetime: 'dd mmm yyyy, h:mm AM/PM',
  date: 'dd mmm yyyy',
  money: '#,##0.00',
}

/**
 * The workbook, from the library handed in — loaded only when somebody
 * downloads, so the list does not carry it. Column widths, the formats of
 * dates and rupees, and Excel's filter arrows on the heading row.
 */
export function ticketWorkbook(
  XLSX: typeof import('xlsx'), tickets: readonly Ticket[], now = Date.now(), teamOf?: (t: Ticket) => string | null,
) {
  const columns = columnsFor(teamOf)
  const { headings, rows } = ticketSheet(tickets, now, teamOf)
  const ws = XLSX.utils.aoa_to_sheet([headings, ...rows])
  columns.forEach((col, c) => {
    const z = FORMAT[col.kind]
    if (!z) return
    for (let r = 1; r <= rows.length; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      if (cell && cell.t === 'n') cell.z = z
    }
  })
  ws['!cols'] = columns.map(col => ({ wch: col.width }))
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 1), c: headings.length - 1 } }) }
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Tickets')
  return wb
}

/** "Revive Lab tickets - Waiting on you - 2026-09-23.xlsx": the tab it came from, and the day. */
export function ticketFileName(tabLabel: string, now = new Date()): string {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `Revive Lab tickets - ${tabLabel} - ${day}.xlsx`
}
