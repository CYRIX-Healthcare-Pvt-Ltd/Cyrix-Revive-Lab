import { useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import {
  Boxes, Download, FileSpreadsheet, IndianRupee, Receipt, Search, ShoppingCart, Trash2, Upload,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import {
  useComponents, usePartRequests, useTickets, useTrcs, useUploadStock, type Component, type PartRequest,
} from '@/lib/queries'
import {
  buysFor, itemsSummary, partOpen, PART_ROUTE_LABEL, PART_STATUS, runsTrc, TONE_CLASS, type PartRoute,
} from '@/lib/tickets'
import { readStockGrid, stockDiff, type SheetRead, type StockDiff } from '@/lib/stockSheet'
import { Alert, EmptyState, PageLoader, Spinner, StatTile } from '@/components/ui'
import IconChip from '@/components/IconChip'
import { rupees } from '@/components/PartsCard'

type Sub = 'stock' | 'requests' | 'purchases' | 'scrap'

const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'

/**
 * Components: the stock each Revive Lab keeps, the requests for what it
 * does not have, what has been spent buying them, and what was scrapped.
 *
 * Coordinators and managers see all four for their Revive Labs, and upload
 * the stock sheet. Purchase sees the requests that came to them.
 */
export default function Components() {
  const { me } = useAuth()
  const [params, setParams] = useSearchParams()
  const { data: trcs, isLoading } = useTrcs()

  const desk = !!me && (me.is_coordinator || me.is_manager || me.is_admin)
  const subs: Array<[Sub, string, typeof Boxes]> = [
    ...(desk ? [['stock', 'Stock', Boxes] as [Sub, string, typeof Boxes]] : []),
    ['requests', 'Requests', ShoppingCart],
    ...(desk ? [['purchases', 'Purchases', IndianRupee], ['scrap', 'Scrap', Trash2]] as Array<[Sub, string, typeof Boxes]> : []),
  ]
  const asked = params.get('tab') as Sub | null
  const sub = subs.find(([id]) => id === asked)?.[0] ?? subs[0][0]

  // The Revive Labs this person works in; an admin sees them all.
  const labs = useMemo(
    () => (trcs ?? []).filter(t => t.is_active && (me?.is_admin || me?.trc_ids.includes(t.id))),
    [trcs, me],
  )

  if (isLoading) return <PageLoader />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Components</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          {desk ? 'Stock, requests, what was spent, and what was scrapped.' : 'The purchase requests that came to you.'}
        </p>
      </div>

      <div className="flex flex-wrap gap-1 rounded-lg bg-ink-100 p-1 sm:inline-flex">
        {subs.map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setParams(p => { p.set('tab', id); return p }, { replace: true })}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              sub === id ? 'bg-surface text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-800',
            )}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      {sub === 'stock' && <StockTab labs={labs} />}
      {sub === 'requests' && <RequestsTab purchaseOnly={!desk} />}
      {sub === 'purchases' && <PurchasesTab labs={labs} />}
      {sub === 'scrap' && <ScrapTab />}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function LabPicker({ labs, value, onChange }: { labs: Array<{ id: string; name: string }>; value: string; onChange: (id: string) => void }) {
  if (labs.length <= 1) return null
  return (
    <select className="input !py-1.5 sm:w-52" value={value} onChange={e => onChange(e.target.value)} aria-label="Revive Lab">
      {labs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
    </select>
  )
}

const SHEET_HEADINGS = ['SL:NO', 'Cyrix- Part No', 'Mfr Pt No./Value', 'Item', 'Type', 'Available QTY']

function StockTab({ labs }: { labs: Array<{ id: string; name: string }> }) {
  const { me } = useAuth()
  const [labId, setLabId] = useState(labs[0]?.id ?? '')
  const lab = labs.find(l => l.id === labId)
  const { data: stock, isLoading } = useComponents(labId)
  const upload = useUploadStock()
  const file = useRef<HTMLInputElement>(null)

  const [q, setQ] = useState('')
  const [outOnly, setOutOnly] = useState(false)
  const [limit, setLimit] = useState(200)
  const [reading, setReading] = useState(false)
  const [pending, setPending] = useState<{ name: string; read: SheetRead; diff: StockDiff } | null>(null)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const canUpload = !!me && (runsTrc(me, labId) || me.is_admin)

  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return (stock ?? []).filter(c =>
      (!outOnly || c.qty === 0)
      && words.every(w => [c.part_no, c.value, c.item, c.package].filter(Boolean).join(' ').toLowerCase().includes(w)))
  }, [stock, q, outOnly])
  const outOfStock = (stock ?? []).filter(c => c.qty === 0).length

  const choose = async (f: File | undefined) => {
    if (!f) return
    setNotice(null); setPending(null); setReading(true)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' })
      const sheet = wb.Sheets[wb.SheetNames[0]]
      const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' })
      const read = readStockGrid(grid)
      if (read.rows.length === 0) {
        setNotice({ kind: 'error', text: read.problems[0] ?? 'No parts were found in that sheet.' })
        return
      }
      setPending({ name: f.name, read, diff: stockDiff(read.rows, stock ?? []) })
    } catch {
      setNotice({ kind: 'error', text: 'That file could not be read as a spreadsheet.' })
    } finally {
      setReading(false)
    }
  }

  const apply = async () => {
    if (!pending) return
    try {
      const res = await upload.mutateAsync({ trcId: labId, rows: pending.read.rows })
      setPending(null)
      setNotice({
        kind: 'success',
        text: `Stock updated at ${lab?.name}: ${res.added} added, ${res.changed} changed, ${res.same} unchanged${res.not_in_sheet ? `, ${res.not_in_sheet} not in the sheet left as they were` : ''}.`,
      })
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'The upload did not go through.' })
    }
  }

  const download = async () => {
    const XLSX = await import('xlsx')
    const rows = (stock ?? []).map((c, i) => [i + 1, c.part_no, c.value ?? '', c.item ?? '', c.package ?? '', c.qty])
    const ws = XLSX.utils.aoa_to_sheet([SHEET_HEADINGS, ...rows])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Stock')
    XLSX.writeFile(wb, `Component stock - ${lab?.name ?? 'Revive Lab'} - ${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  if (labs.length === 0) {
    return <EmptyState icon={Boxes} title="No Revive Lab">You are not in a Revive Lab yet.</EmptyState>
  }

  return (
    <div className="space-y-4">
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}

      {pending && (
        <div className="card space-y-3 p-4">
          <p className="flex items-center gap-2.5 text-sm font-semibold text-ink-800">
            <IconChip icon={FileSpreadsheet} tone="green" /> {pending.name} → {lab?.name}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile label="New parts" value={pending.diff.added.length} />
            <StatTile label="Changed" value={pending.diff.changed.length} sub="quantity or details" />
            <StatTile label="Unchanged" value={pending.diff.same} />
            <StatTile label="Not in the sheet" value={pending.diff.notInSheet} sub="left as they are" />
          </div>
          {pending.read.emptySlots > 0 && (
            <p className="text-xs text-ink-500">{pending.read.emptySlots} rows marked EMPTY are left out.</p>
          )}
          {pending.read.tidied.length > 0 && (
            <p className="text-xs text-ink-500">Read carefully: {pending.read.tidied.join('; ')}.</p>
          )}
          {pending.read.problems.length > 0 && (
            <Alert kind="warning" title={`${pending.read.problems.length} row${pending.read.problems.length === 1 ? '' : 's'} not uploaded`}>
              <ul className="list-disc pl-4">{pending.read.problems.slice(0, 10).map(p => <li key={p}>{p}</li>)}</ul>
            </Alert>
          )}
          {pending.diff.changed.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">
                    <th className="py-1.5 pr-3 font-medium">Part</th>
                    <th className="px-3 py-1.5 text-right font-medium">Was</th>
                    <th className="py-1.5 pl-3 text-right font-medium">Now</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {pending.diff.changed.slice(0, 10).map(({ row, before }) => (
                    <tr key={row.part_no}>
                      <td className="py-1.5 pr-3"><span className="font-mono text-xs">{row.part_no}</span> {row.value}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-ink-500">{before.qty}</td>
                      <td className="py-1.5 pl-3 text-right font-medium tabular-nums">{row.qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pending.diff.changed.length > 10 && <p className="mt-1 text-xs text-ink-400">and {pending.diff.changed.length - 10} more</p>}
            </div>
          )}
          <p className="text-xs text-ink-500">Each quantity is set to the sheet&rsquo;s count. What engineers took since the sheet was counted is not added back.</p>
          <div className="flex gap-2">
            <button type="button" className="btn-primary" onClick={apply} disabled={upload.isPending}>
              {upload.isPending ? <Spinner className="h-4 w-4" /> : <Upload className="h-4 w-4" />} Update stock
            </button>
            <button type="button" className="btn-secondary" onClick={() => setPending(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-ink-50 px-3 py-2">
          <LabPicker labs={labs} value={labId} onChange={id => { setLabId(id); setPending(null) }} />
          <label className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
            <input className="input !py-1.5 !pl-8" placeholder="Part no, value or type" value={q}
              onChange={e => { setQ(e.target.value); setLimit(200) }} aria-label="Search stock" />
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-ink-600">
            <input type="checkbox" checked={outOnly} onChange={e => setOutOnly(e.target.checked)} /> Out of stock ({outOfStock})
          </label>
          <div className="ml-auto flex gap-2">
            {(stock ?? []).length > 0 && (
              <button type="button" className="btn-secondary !py-1.5 text-sm" onClick={() => void download()}>
                <Download className="h-4 w-4 text-green-600" /> Download
              </button>
            )}
            {canUpload && (
              <button type="button" className="btn-primary !py-1.5 text-sm" onClick={() => file.current?.click()} disabled={reading}>
                {reading ? <Spinner className="h-4 w-4" /> : <Upload className="h-4 w-4" />} Upload stock sheet
              </button>
            )}
            <input ref={file} type="file" className="hidden"
              accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
              onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; void choose(f) }} />
          </div>
        </div>

        {isLoading ? (
          <div className="p-6"><Spinner className="h-5 w-5 text-ink-400" /></div>
        ) : (stock ?? []).length === 0 ? (
          <div className="p-4">
            <EmptyState icon={Boxes} title={`No stock at ${lab?.name ?? 'this Revive Lab'} yet`}>
              {canUpload ? 'Upload the component stock sheet — the Excel with Cyrix Part No, Mfr Pt No./Value, Item, Type and Available QTY.' : 'The coordinator uploads it from the stock sheet.'}
            </EmptyState>
          </div>
        ) : (
          <>
            <p className="px-4 pt-3 text-xs text-ink-500">
              {shown.length === (stock ?? []).length ? `${stock!.length} parts` : `${shown.length} of ${stock!.length} parts`} · {outOfStock} out of stock
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">
                    <th className="px-4 py-2 font-medium">Part no</th>
                    <th className="px-4 py-2 font-medium">Value</th>
                    <th className="hidden px-4 py-2 font-medium sm:table-cell">Item</th>
                    <th className="hidden px-4 py-2 font-medium sm:table-cell">Type</th>
                    <th className="px-4 py-2 text-right font-medium">Qty</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {shown.slice(0, limit).map((c: Component) => (
                    <tr key={c.id} className="hover:bg-ink-50">
                      <td className="px-4 py-2 font-mono text-xs text-ink-700">{c.part_no}</td>
                      <td className="px-4 py-2 text-ink-900">
                        {c.value ?? <span className="text-ink-300">—</span>}
                        <span className="block text-xs text-ink-400 sm:hidden">{[c.item, c.package].filter(Boolean).join(' · ')}</span>
                      </td>
                      <td className="hidden px-4 py-2 text-ink-600 sm:table-cell">{c.item ?? '—'}</td>
                      <td className="hidden px-4 py-2 text-ink-600 sm:table-cell">{c.package ?? '—'}</td>
                      <td className="px-4 py-2 text-right">
                        <span className={clsx('badge tabular-nums', c.qty === 0 ? 'bg-rose-100 text-rose-900' : 'bg-green-100 text-green-900')}>{c.qty}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {shown.length > limit && (
              <div className="p-3 text-center">
                <button type="button" className="btn-secondary !py-1.5 text-sm" onClick={() => setLimit(l => l + 500)}>
                  Show more ({shown.length - limit} left)
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function RequestsTab({ purchaseOnly }: { purchaseOnly: boolean }) {
  const { me } = useAuth()
  const { data: requests, isLoading } = usePartRequests()
  const [show, setShow] = useState<'open' | 'all'>('open')
  const [route, setRoute] = useState<PartRoute | ''>(purchaseOnly ? 'purchase' : '')

  const rows = useMemo(() => (requests ?? []).filter(r =>
    (!purchaseOnly || (r.route === 'purchase' && buysFor(me, r.trc_id)))
    && (!route || r.route === route)
    && (show === 'all' || partOpen(r.status))), [requests, purchaseOnly, me, route, show])

  if (isLoading) return <Spinner className="h-5 w-5 text-ink-400" />

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-ink-50 px-3 py-2">
        <div className="flex gap-1">
          {(['open', 'all'] as const).map(v => (
            <button key={v} type="button" onClick={() => setShow(v)}
              className={clsx('rounded-md px-3 py-1.5 text-sm font-medium', show === v ? 'bg-surface text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-800')}>
              {v === 'open' ? 'Open' : 'All'}
            </button>
          ))}
        </div>
        {!purchaseOnly && (
          <select className="input !py-1.5 sm:w-44" value={route} onChange={e => setRoute(e.target.value as PartRoute | '')} aria-label="Bought by">
            <option value="">Local purchase and purchase</option>
            <option value="local">Local purchase</option>
            <option value="purchase">Purchase</option>
          </select>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="p-4">
          <EmptyState icon={ShoppingCart} title={show === 'open' ? 'Nothing open' : 'No requests yet'}>
            Engineers request components from a ticket while repairing it.
          </EmptyState>
        </div>
      ) : (
        <ul className="divide-y divide-ink-100">
          {rows.map(r => <RequestRow key={r.id} r={r} />)}
        </ul>
      )}
    </div>
  )
}

function RequestRow({ r }: { r: PartRequest }) {
  const status = PART_STATUS[r.status]
  return (
    <li>
      <Link to={`/tickets/${r.ticket_code}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-ink-50">
        <span className="font-mono text-sm font-semibold text-ink-900">{r.ticket_code}</span>
        <span className="min-w-0 flex-1 text-sm text-ink-800">
          <span className="tabular-nums">{r.qty} ×</span> {r.name}
          <span className="block text-xs text-ink-500">{r.facility} · {r.trc_name} · asked by {r.requested_by_name} {day(r.requested_at)}</span>
        </span>
        <span className="badge bg-ink-100 text-ink-600">{PART_ROUTE_LABEL[r.route]}</span>
        <span className={clsx('badge', TONE_CLASS[status.tone])}>{status.label}</span>
        {r.bill_amount !== null && <span className="text-sm font-medium tabular-nums text-ink-900">{rupees(r.bill_amount)}</span>}
      </Link>
    </li>
  )
}

/* ------------------------------------------------------------------ */

type Period = 'month' | 'last' | 'fy' | 'all'

/** From when a period starts, in local time; null for all time. Financial years start in April. */
function periodStart(p: Period, now = new Date()): { from: Date | null; to: Date | null } {
  const y = now.getFullYear(), m = now.getMonth()
  if (p === 'month') return { from: new Date(y, m, 1), to: null }
  if (p === 'last') return { from: new Date(y, m - 1, 1), to: new Date(y, m, 1) }
  if (p === 'fy') return { from: new Date(m >= 3 ? y : y - 1, 3, 1), to: null }
  return { from: null, to: null }
}

function PurchasesTab({ labs }: { labs: Array<{ id: string; name: string }> }) {
  const { data: requests, isLoading } = usePartRequests()
  const [period, setPeriod] = useState<Period>('month')
  const [labId, setLabId] = useState('')

  const bought = useMemo(() => {
    const { from, to } = periodStart(period)
    return (requests ?? []).filter(r =>
      r.bill_amount !== null && r.purchased_at
      && (!labId || r.trc_id === labId)
      && (!from || new Date(r.purchased_at) >= from)
      && (!to || new Date(r.purchased_at) < to))
      .sort((a, b) => Date.parse(b.purchased_at!) - Date.parse(a.purchased_at!))
  }, [requests, period, labId])

  const total = (route: PartRoute) => bought.filter(r => r.route === route).reduce((a, r) => a + (r.bill_amount ?? 0), 0)
  const count = (route: PartRoute) => bought.filter(r => r.route === route).length

  const download = async () => {
    const XLSX = await import('xlsx')
    const rows = bought.map(r => [
      day(r.purchased_at), r.ticket_code, r.trc_name, PART_ROUTE_LABEL[r.route], r.name, r.qty,
      r.vendor ?? '', r.bill_no ?? '', r.bill_amount ?? 0, r.purchased_by_name ?? '',
    ])
    const ws = XLSX.utils.aoa_to_sheet([['Bought on', 'Ticket', 'Revive Lab', 'Bought as', 'Component', 'Qty', 'From', 'Bill no', 'Amount (₹)', 'Bought by'], ...rows])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Purchases')
    XLSX.writeFile(wb, `Component purchases - ${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  if (isLoading) return <Spinner className="h-5 w-5 text-ink-400" />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select className="input !py-1.5 sm:w-44" value={period} onChange={e => setPeriod(e.target.value as Period)} aria-label="Period">
          <option value="month">This month</option>
          <option value="last">Last month</option>
          <option value="fy">This financial year</option>
          <option value="all">All time</option>
        </select>
        {labs.length > 1 && (
          <select className="input !py-1.5 sm:w-52" value={labId} onChange={e => setLabId(e.target.value)} aria-label="Revive Lab">
            <option value="">All Revive Labs</option>
            {labs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
        {bought.length > 0 && (
          <button type="button" className="btn-secondary ml-auto !py-1.5 text-sm" onClick={() => void download()}>
            <Download className="h-4 w-4 text-green-600" /> Download
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SpendTile label="Local purchase" amount={total('local')} count={count('local')} />
        <SpendTile label="Purchase" amount={total('purchase')} count={count('purchase')} />
        <SpendTile label="Together" amount={total('local') + total('purchase')} count={bought.length} strong />
      </div>

      <div className="card overflow-hidden">
        {bought.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={Receipt} title="Nothing bought in this period">Bills attached to component requests add up here.</EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">
                  <th className="px-4 py-2 font-medium">Bought</th>
                  <th className="px-4 py-2 font-medium">Ticket</th>
                  <th className="px-4 py-2 font-medium">Component</th>
                  <th className="hidden px-4 py-2 font-medium md:table-cell">From</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {bought.map(r => (
                  <tr key={r.id} className="hover:bg-ink-50">
                    <td className="px-4 py-2 text-ink-600">{day(r.purchased_at)}</td>
                    <td className="px-4 py-2"><Link to={`/tickets/${r.ticket_code}`} className="font-mono font-semibold text-ink-900">{r.ticket_code}</Link></td>
                    <td className="px-4 py-2 text-ink-900">
                      {r.qty} × {r.name}
                      <span className="block text-xs text-ink-500">{PART_ROUTE_LABEL[r.route]} · {r.trc_name}{r.bill_no ? ` · bill ${r.bill_no}` : ''}</span>
                    </td>
                    <td className="hidden px-4 py-2 text-ink-600 md:table-cell">{r.vendor ?? '—'}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums text-ink-900">{rupees(r.bill_amount ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function SpendTile({ label, amount, count, strong }: { label: string; amount: number; count: number; strong?: boolean }) {
  return (
    <div className={clsx('rounded-xl border p-4', strong ? 'border-ink-300 bg-ink-50' : 'border-ink-200 bg-surface')}>
      <p className="text-xs font-semibold uppercase tracking-label text-ink-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-ink-900">{rupees(amount)}</p>
      <p className="text-xs text-ink-500">{count} {count === 1 ? 'bill' : 'bills'}</p>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function ScrapTab() {
  const { data: tickets, isLoading } = useTickets()
  const scrapped = useMemo(() => (tickets ?? []).filter(t => t.closure === 'scrapped')
    .sort((a, b) => Date.parse(b.scrapped_at ?? b.updated_at) - Date.parse(a.scrapped_at ?? a.updated_at)), [tickets])

  if (isLoading) return <Spinner className="h-5 w-5 text-ink-400" />

  const cell = (children: ReactNode, cls = '') => <td className={clsx('px-4 py-2', cls)}>{children}</td>
  return (
    <div className="card overflow-hidden">
      {scrapped.length === 0 ? (
        <div className="p-4">
          <EmptyState icon={Trash2} title="Nothing scrapped">
            A spare closed as not repairable and moved to scrap by the coordinator is listed here.
          </EmptyState>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">
                <th className="px-4 py-2 font-medium">Ticket</th>
                <th className="px-4 py-2 font-medium">Spare</th>
                <th className="hidden px-4 py-2 font-medium md:table-cell">Hospital</th>
                <th className="hidden px-4 py-2 font-medium sm:table-cell">Revive Lab</th>
                <th className="px-4 py-2 font-medium">Scrapped</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {scrapped.map(t => (
                <tr key={t.id} className="hover:bg-ink-50">
                  {cell(<Link to={`/tickets/${t.code}`} className="font-mono font-semibold text-ink-900">{t.code}</Link>)}
                  {cell(<>{itemsSummary(t) ?? '—'}{t.equipment_name && <span className="block text-xs text-ink-500">{t.equipment_name}</span>}</>, 'text-ink-900')}
                  {cell(t.facility, 'hidden text-ink-600 md:table-cell')}
                  {cell(t.trc_name, 'hidden text-ink-600 sm:table-cell')}
                  {cell(<>{day(t.scrapped_at)}{t.scrapped_by_name && <span className="block text-xs text-ink-500">by {t.scrapped_by_name}</span>}</>, 'text-ink-600')}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
