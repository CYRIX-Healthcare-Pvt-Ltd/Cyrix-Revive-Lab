import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  Boxes, CheckCircle2, ClipboardList, Download, FileSpreadsheet, IndianRupee, PackageMinus, Pencil, Plus, Receipt, Search, ShoppingCart, Trash2,
  TriangleAlert, Upload, X,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import {
  useApproveUse, useComponents, usePartRequests, useStockUses, useTickets, useTrcs, useUploadStock,
  type Component, type PartRequest, type StockUseRow,
} from '@/lib/queries'
import {
  buysFor, itemsSummary, partActor, poLabel, PART_ROUTE_LABEL, requestsStockAt, runsTrc,
  stockRequestsWaitingOn, STOCK_USE_STATUS, TONE_CLASS, purchaseSees,
  type PartRoute,
} from '@/lib/tickets'
import { signedLinks } from '@/lib/partFiles'
import { readStockGrid, stockDiff, STOCK_SHEET_HEADINGS, type SheetRead, type StockDiff } from '@/lib/stockSheet'
import { PartHistoryDialog, StockPartDialog, UploadMenu, WhereTag } from '@/components/StockPart'
import { Alert, EmptyState, PageLoader, Spinner, StatTile } from '@/components/ui'
import IconChip from '@/components/IconChip'
import Lightbox from '@/components/Lightbox'
import { RequestPartForm } from '@/components/PartForms'
import {
  rupees, BillDialog, DeclineDialog, DeclineUseDialog, OrderDialog, RequestItem, StockDialog,
} from '@/components/PartsCard'

type Sub = 'stock' | 'taken' | 'requests' | 'purchases' | 'scrap'

const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'

/**
 * Components: the stock each Revive Lab keeps, what engineers have taken
 * out of it, the requests for what it does not have, what has been spent
 * buying them, and what was scrapped.
 *
 * Coordinators and managers see all of it for their Revive Labs, upload the
 * stock sheet, and approve what comes off it. Purchase sees the requests
 * that came to them.
 *
 * Component requests with no ticket, for the stock (PR-01 on), have a tab
 * of their own — and are all a Revive Lab engineer with no other role
 * comes here for (rl_0044; the user, 7 Oct).
 */
export default function Components() {
  const { me } = useAuth()
  const [params, setParams] = useSearchParams()
  const { data: trcs, isLoading } = useTrcs()

  const desk = !!me && (me.is_coordinator || me.is_manager || me.is_admin)
  // A Revive Lab engineer with no other role is here only for their component requests (rl_0044).
  const engineerOnly = !!me && !desk && !me.is_purchase
  const { data: allRequests } = usePartRequests()
  const prWaiting = stockRequestsWaitingOn(allRequests ?? [], me)
  // Requests from a ticket and for the stock in one tab (the user, 22 Oct: "the components tab is confusing").
  const subs: Array<[Sub, string, typeof Boxes]> = [
    ...(desk ? [['stock', 'Stock', Boxes]] as Array<[Sub, string, typeof Boxes]> : []),
    ['requests', 'Requests', ShoppingCart],
    ...(desk ? [['taken', 'Stock taken — to approve', PackageMinus], ['purchases', 'Spending', IndianRupee], ['scrap', 'Scrap', Trash2]] as Array<[Sub, string, typeof Boxes]> : []),
  ]
  // An old link to the component requests tab opens Requests.
  const asked = (params.get('tab') === 'pr' ? 'requests' : params.get('tab')) as Sub | null
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
        <h1 className="text-xl font-semibold text-ink-900">{engineerOnly ? 'Component requests' : 'Components'}</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          {engineerOnly
            ? 'Components the Revive Lab needs in stock, asked for without a ticket. The coordinator purchases them, or passes them to Purchase, and adds them to stock.'
            : desk ? 'Stock, what has come off it, requests, what was spent, and what was scrapped.' : 'The purchase requests that came to you.'}
        </p>
      </div>

      {subs.length > 1 && (
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
            {id === 'requests' && prWaiting > 0 && <span className="tabular-nums text-orange-600">{prWaiting}</span>}
          </button>
        ))}
      </div>
      )}

      {sub === 'stock' && <StockTab labs={labs} />}
      {sub === 'taken' && <TakenTab />}
      {sub === 'requests' && <RequestsTab desk={desk} engineerOnly={engineerOnly} />}
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
  // Add stock (null part) or Edit one (the part): the one-at-a-time form (the user, 29 Sep).
  const [editing, setEditing] = useState<{ part: Component | null } | null>(null)
  const [historyOf, setHistoryOf] = useState<Component | null>(null)

  const canUpload = !!me && (runsTrc(me, labId) || me.is_admin)

  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return (stock ?? []).filter(c =>
      (!outOnly || c.qty === 0)
      && words.every(w => [c.part_no, c.value, c.item, c.package, c.bin, c.location].filter(Boolean).join(' ').toLowerCase().includes(w)))
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

  /** existing: what to do with part numbers already in stock that the sheet says otherwise about. */
  const apply = async (existing: 'replace' | 'skip') => {
    if (!pending) return
    try {
      const res = await upload.mutateAsync({ trcId: labId, rows: pending.read.rows, existing })
      setPending(null)
      setNotice({
        kind: 'success',
        text: `Stock updated at ${lab?.name}: ${res.added} added, ${res.changed} replaced${res.skipped ? `, ${res.skipped} skipped — already in stock, kept as they were` : ''}, ${res.same} unchanged${res.not_in_sheet ? `, ${res.not_in_sheet} not in the sheet left as they were` : ''}.`,
      })
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'The upload did not go through.' })
    }
  }

  // The template's own columns, so what is downloaded uploads as it is.
  /** The stock as it is — or, as a template, its headings alone to fill in. */
  const download = async (template = false) => {
    const XLSX = await import('xlsx')
    const rows = template ? [] : (stock ?? []).map(c => [c.part_no, c.value ?? '', c.item ?? '', c.package ?? '', c.bin ?? '', c.location ?? '', c.qty])
    const ws = XLSX.utils.aoa_to_sheet([[...STOCK_SHEET_HEADINGS], ...rows])
    ws['!cols'] = [{ wch: 14 }, { wch: 24 }, { wch: 20 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 6 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Stock')
    XLSX.writeFile(wb, template
      ? 'Component stock sheet - template.xlsx'
      : `Component stock - ${lab?.name ?? 'Revive Lab'} - ${new Date().toISOString().slice(0, 10)}.xlsx`)
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
            <StatTile label="New parts" value={pending.diff.added.length} sub="added" />
            <StatTile label="Already in stock" value={pending.diff.changed.length} sub="the sheet says otherwise" />
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
          {/* Part numbers already in stock: replace them with the sheet, or skip them (the user, 29 Sep). */}
          {pending.diff.changed.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50/70 p-3">
              <p className="flex items-start gap-2 text-sm font-semibold text-amber-900">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                {pending.diff.changed.length} part number{pending.diff.changed.length === 1 ? ' is' : 's are'} already in stock, and the sheet says otherwise.
                Replace {pending.diff.changed.length === 1 ? 'it' : 'them'} with the sheet, or skip {pending.diff.changed.length === 1 ? 'it' : 'them'} and keep what is in stock?
              </p>
              <div className="mt-2 max-h-64 overflow-auto rounded-md border border-amber-200 bg-surface">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">
                      <th className="px-3 py-1.5 font-medium">Part</th>
                      <th className="px-3 py-1.5 font-medium">What would change</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {pending.diff.changed.map(({ row, before, fields }) => (
                      <tr key={row.part_no}>
                        <td className="whitespace-nowrap px-3 py-1.5 align-top">
                          <span className="font-mono text-xs text-ink-700">{row.part_no}</span>{' '}
                          <span className="text-ink-900">{before.value ?? before.item}</span>
                        </td>
                        <td className="px-3 py-1.5 text-xs text-ink-600">{fields.join(' · ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <p className="text-xs text-ink-500">A part replaced takes the sheet&rsquo;s count. What engineers took since the sheet was counted is not added back.</p>
          <div className="flex flex-wrap gap-2">
            {pending.diff.changed.length > 0 ? (
              <>
                <button type="button" className="btn-primary" onClick={() => void apply('replace')} disabled={upload.isPending}>
                  {upload.isPending ? <Spinner className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
                  Replace {pending.diff.changed.length}{pending.diff.added.length ? ` and add ${pending.diff.added.length}` : ''}
                </button>
                <button type="button" className="btn-secondary" onClick={() => void apply('skip')} disabled={upload.isPending}>
                  Skip them{pending.diff.added.length ? ` — add only the ${pending.diff.added.length} new` : ''}
                </button>
              </>
            ) : (
              <button type="button" className="btn-primary" onClick={() => void apply('replace')} disabled={upload.isPending}>
                {upload.isPending ? <Spinner className="h-4 w-4" /> : <Upload className="h-4 w-4" />} Update stock
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={() => setPending(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-ink-50 px-3 py-2">
          <LabPicker labs={labs} value={labId} onChange={id => { setLabId(id); setPending(null) }} />
          <label className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
            <input className="input !py-1.5 !pl-8" placeholder="Part no, value, type or BIN" value={q}
              onChange={e => { setQ(e.target.value); setLimit(200) }} aria-label="Search stock" />
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-ink-600">
            <input type="checkbox" checked={outOnly} onChange={e => setOutOnly(e.target.checked)} /> Out of stock ({outOfStock})
          </label>
          <div className="ml-auto flex flex-wrap gap-2">
            {canUpload && (
              <button type="button" className="btn-secondary !py-1.5 text-sm" onClick={() => { setNotice(null); setEditing({ part: null }) }}>
                <Plus className="h-4 w-4 text-indigo-600" /> Add stock
              </button>
            )}
            {(stock ?? []).length > 0 && (
              <button type="button" className="btn-secondary !py-1.5 text-sm" onClick={() => void download()}>
                <Download className="h-4 w-4 text-green-600" /> Download
              </button>
            )}
            {/* Two ways in: the empty template to fill, or a filled sheet to upload (the user, 29 Sep). */}
            {canUpload && (
              <UploadMenu
                busy={reading}
                onTemplate={() => void download(true)}
                onUpload={() => file.current?.click()}
              />
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
              {canUpload
                ? `Upload the component stock sheet — the Excel with ${STOCK_SHEET_HEADINGS.join(', ')} — or add parts one at a time.`
                : 'The coordinator uploads it from the stock sheet.'}
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
                    <th className="hidden px-4 py-2 font-medium md:table-cell">BIN</th>
                    <th className="hidden px-4 py-2 font-medium md:table-cell">Location</th>
                    <th className="px-4 py-2 text-right font-medium">Qty</th>
                    {canUpload && <th className="w-12 px-2 py-2"><span className="sr-only">Edit</span></th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {shown.slice(0, limit).map((c: Component) => (
                    <tr key={c.id} className="hover:bg-ink-50">
                      <td className="px-4 py-2">
                        {/* Its history: who added it, who changed what (the user, 29 Sep). */}
                        <button type="button" className="link-accent font-mono text-xs" onClick={() => setHistoryOf(c)} title={`History of ${c.part_no}`}>
                          {c.part_no}
                        </button>
                      </td>
                      <td className="px-4 py-2 text-ink-900">
                        {c.value ?? <span className="text-ink-300">—</span>}
                        <span className="block text-xs text-ink-400 sm:hidden">{[c.item, c.package].filter(Boolean).join(' · ')}</span>
                        {/* On a narrow screen, where it is kept goes under the value. */}
                        <WhereTag bin={c.bin} location={c.location} className="mt-0.5 md:hidden" />
                      </td>
                      <td className="hidden px-4 py-2 text-ink-600 sm:table-cell">{c.item ?? '—'}</td>
                      <td className="hidden px-4 py-2 text-ink-600 sm:table-cell">{c.package ?? '—'}</td>
                      <td className="hidden px-4 py-2 font-medium text-ink-800 md:table-cell">{c.bin ?? <span className="font-normal text-ink-300">—</span>}</td>
                      <td className="hidden px-4 py-2 font-medium text-ink-800 md:table-cell">{c.location ?? <span className="font-normal text-ink-300">—</span>}</td>
                      <td className="px-4 py-2 text-right">
                        <span className={clsx('badge tabular-nums', c.qty === 0 ? 'bg-rose-100 text-rose-900' : 'bg-green-100 text-green-900')}>{c.qty}</span>
                      </td>
                      {canUpload && (
                        <td className="px-2 py-1 text-right">
                          <button
                            type="button"
                            className="rounded-md p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-800"
                            onClick={() => { setNotice(null); setEditing({ part: c }) }}
                            title={`Edit ${c.part_no}`}
                            aria-label={`Edit ${c.part_no}`}
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                        </td>
                      )}
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

      {editing && lab && (
        <StockPartDialog
          labId={labId}
          labName={lab.name}
          stock={stock ?? []}
          part={editing.part}
          onClose={() => setEditing(null)}
          onDone={text => { setEditing(null); setNotice({ kind: 'success', text }) }}
        />
      )}
      {historyOf && (
        <PartHistoryDialog part={(stock ?? []).find(c => c.id === historyOf.id) ?? historyOf} onClose={() => setHistoryOf(null)} />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * What engineers have taken from the stock, and what the coordinator said.
 *
 * The same approvals as on each ticket, in one place: a repair is waiting
 * on every one of these, so what is open comes first and is approved from
 * here without opening the ticket.
 */
function TakenTab() {
  const linkState = useBack()
  const { me } = useAuth()
  const { data: rows, isLoading } = useStockUses()
  const approve = useApproveUse()
  const [show, setShow] = useState<'open' | 'all'>('open')
  const [refusing, setRefusing] = useState<StockUseRow | null>(null)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const shown = useMemo(
    () => (rows ?? []).filter(u => show === 'all' || u.status === 'requested'),
    [rows, show],
  )
  const waiting = (rows ?? []).filter(u => u.status === 'requested').length

  const take = async (u: StockUseRow) => {
    setNotice(null)
    try {
      await approve.mutateAsync({ id: u.id })
      setNotice({ kind: 'success', text: `${u.qty} × ${u.part_no} off the stock for ${u.ticket_code}.` })
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'That did not go through.' })
    }
  }

  if (isLoading) return <Spinner className="h-5 w-5 text-ink-400" />

  return (
    <div className="space-y-4">
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-ink-50 px-3 py-2">
          <div className="flex gap-1">
            {(['open', 'all'] as const).map(v => (
              <button key={v} type="button" onClick={() => setShow(v)}
                className={clsx('rounded-md px-3 py-1.5 text-sm font-medium', show === v ? 'bg-surface text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-800')}>
                {v === 'open' ? 'Waiting' : 'All'}
                {v === 'open' && waiting > 0 && <span className="ml-1.5 tabular-nums text-orange-600">{waiting}</span>}
                {v === 'all' && (rows ?? []).length > 0 && <span className="ml-1.5 tabular-nums text-ink-400">{(rows ?? []).length}</span>}
              </button>
            ))}
          </div>
        </div>

        {shown.length === 0 ? (
          <div className="p-4">
            {/* Waiting empty is not nothing recorded: say where the rest are (the user, 29 Sep: "still data not showing"). */}
            {show === 'open' && (rows ?? []).length > 0 ? (
              <EmptyState icon={PackageMinus} title="Nothing waiting for approval">
                All {(rows ?? []).length} taken from stock so far {(rows ?? []).length === 1 ? 'has' : 'have'} been approved or declined.{' '}
                <button type="button" className="link-accent font-medium" onClick={() => setShow('all')}>Show all {(rows ?? []).length}</button>
              </EmptyState>
            ) : (
              <EmptyState icon={PackageMinus} title={show === 'open' ? 'Nothing waiting' : 'Nothing taken from stock yet'}>
                An engineer repairing a spare takes what they need from this Revive Lab’s stock, and it comes off the
                count once you approve it.
              </EmptyState>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-ink-100">
            {shown.map(u => {
              const status = STOCK_USE_STATUS[u.status]
              const desk = runsTrc(me, u.trc_id)
              return (
                <li key={u.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Link to={`/tickets/${u.ticket_code}`} state={linkState} className="font-mono text-sm font-semibold text-ink-900">
                      {u.ticket_code}
                    </Link>
                    <span className="min-w-0 flex-1 text-sm text-ink-800">
                      <span className="tabular-nums">{u.qty} ×</span> {u.value ?? u.item ?? u.part_no}
                      <span className="ml-1.5 font-mono text-xs text-ink-500">{u.part_no}</span>
                      {/* Where to go and get it (the user, 29 Sep). */}
                      <WhereTag bin={u.bin} location={u.location} missing={u.status === 'requested'} className="ml-2 align-middle" />
                      <span className="block text-xs text-ink-500">
                        {u.facility} · {u.trc_name} · requested by {u.requested_by_name} {day(u.requested_at)}
                        {u.status === 'requested' && <> · {u.in_stock} in stock</>}
                      </span>
                    </span>
                    <span className={clsx('badge', TONE_CLASS[status.tone])}>{status.label}</span>
                  </div>
                  {u.decision_note && <p className="mt-1 text-sm text-ink-600">{u.decision_note}</p>}
                  {u.status === 'requested' && desk && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button type="button" className="btn-primary !py-1.5 text-sm" disabled={approve.isPending}
                        onClick={() => void take(u)}>
                        {approve.isPending ? <Spinner className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4 text-green-400" />} Approve
                      </button>
                      <button type="button" className="btn-secondary !py-1.5 text-sm" onClick={() => { setNotice(null); setRefusing(u) }}>
                        <X className="h-4 w-4 text-rose-600" /> Decline
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {refusing && (
        <DeclineUseDialog
          use={refusing}
          onClose={() => setRefusing(null)}
          onDone={text => { setRefusing(null); setNotice({ kind: 'success', text }) }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * Requests: every component request — from a ticket, or for a Revive Lab's stock (PR-01 on) — in one list,
 * with a summary of where they stand for each buyer (the user, 22 Oct: "we cannot know what all is pending with
 * the coordinator, what went to Purchase, what local purchase was done, what is the status"; "the manager cannot
 * know how much is the coordinator's and how much Purchase's"). The coordinator's local purchases and the
 * Purchase team's each get a row of counts — a total, then each stage, coloured by where it stands — and what
 * each spent; a count filters the list. The days to look at: all time by default, this month, or any two dates.
 * Each request shows its journey and who it waits on; one for the stock opens, with its buttons, in place.
 */
type StageKey = 'c_decide' | 'c_enquiry' | 'c_order' | 'c_bought' | 'c_stock' | 'p_accept' | 'p_accepted' | 'p_bought' | 'p_stock'
type Lane = 'c' | 'p'
const STAGES: Record<Lane, { who: string; sub: string; stages: Array<[StageKey, string]> }> = {
  c: { who: 'Coordinator', sub: 'local purchase', stages: [['c_decide', 'Pending to decide'], ['c_enquiry', 'Enquiry given'], ['c_order', 'Order placed'], ['c_bought', 'Purchased'], ['c_stock', 'Added to stock']] },
  p: { who: 'Purchase team', sub: 'passed on by the coordinator', stages: [['p_accept', 'Pending to accept'], ['p_accepted', 'Accepted — ordered'], ['p_bought', 'Purchased'], ['p_stock', 'Added to stock']] },
}
// The colour says where it stands: waiting for a decision orange, being bought amber then sky, bought violet, in stock green.
const STAGE_INK: Record<StageKey, string> = {
  c_decide: 'text-orange-600', p_accept: 'text-orange-600',
  c_enquiry: 'text-amber-600', c_order: 'text-sky-700', p_accepted: 'text-sky-700',
  c_bought: 'text-violet-700', p_bought: 'text-violet-700',
  c_stock: 'text-green-700', p_stock: 'text-green-700',
}
const STAGE_CHIP: Record<StageKey, string> = {
  c_decide: 'bg-orange-100 text-orange-900', p_accept: 'bg-orange-100 text-orange-900',
  c_enquiry: 'bg-amber-100 text-amber-900', c_order: 'bg-sky-100 text-sky-900', p_accepted: 'bg-sky-100 text-sky-900',
  c_bought: 'bg-violet-100 text-violet-900', p_bought: 'bg-violet-100 text-violet-900',
  c_stock: 'bg-green-100 text-green-900', p_stock: 'bg-green-100 text-green-900',
}
const JOURNEY = ['Requested', 'Decided', 'Buying', 'Purchased', 'Added to stock']

/** The one box a request counts in; none once declined or cancelled. */
function stageOf(r: PartRequest): StageKey | null {
  if (r.status === 'declined' || r.status === 'cancelled') return null
  if (r.status === 'requested') return 'c_decide'
  if (r.status === 'forwarded') return 'p_accept'
  const lane: Lane = r.route === 'purchase' ? 'p' : 'c'
  if (r.status === 'accepted') return lane === 'p' ? 'p_accepted' : r.progress === 'order_placed' ? 'c_order' : 'c_enquiry'
  if (r.status === 'bought') return lane === 'p' ? 'p_bought' : 'c_bought'
  return lane === 'p' ? 'p_stock' : 'c_stock'
}
const stepOf = (k: StageKey) => (k.endsWith('decide') || k.endsWith('accept') ? 1 : k.endsWith('bought') ? 3 : k.endsWith('stock') ? 4 : 2)

/** Who moves it next, in words. */
function waitingOn(r: PartRequest, k: StageKey | null): { text: string; late?: boolean } {
  if (!k) return { text: r.status === 'declined' ? 'Declined' : 'Cancelled' }
  switch (k) {
    case 'c_decide': return { text: 'Coordinator — buy or pass to Purchase' }
    case 'c_enquiry': return { text: 'Coordinator — enquiry given' }
    case 'c_order': return { text: 'Coordinator — order placed' }
    case 'p_accept': return { text: 'Purchase — to accept' }
    case 'p_accepted': return { text: 'Purchase — to order' }
    case 'c_bought': case 'p_bought': {
      if (k === 'p_bought' && r.edd) {
        const due = r.edd.slice(0, 10)
        return { text: `Ordered — due ${day(due)}`, late: due < new Date().toLocaleDateString('en-CA') }
      }
      return { text: r.ticket_id ? 'Coordinator — add to stock and send' : 'Coordinator — add to stock' }
    }
    default: return { text: r.status === 'sent' ? 'Engineer — confirm received' : 'Added to stock' }
  }
}

type ReqPeriod = 'all' | 'month' | 'custom'
/*
  Back from a ticket opened here lands where it was clicked (the user, 22 Oct): the ticket's back link returns to this
  tab, and the Requests filters and the scroll are kept for the browser tab's life.
*/
function useBack() {
  const { pathname, search } = useLocation()
  return { back: { to: pathname + search, label: 'Components' } }
}

function useKept<T>(key: string, initial: T) {
  const name = `revive-components:${key}`
  const [v, setV] = useState<T>(() => {
    try { const raw = sessionStorage.getItem(name); return raw === null ? initial : JSON.parse(raw) as T } catch { return initial }
  })
  useEffect(() => { try { sessionStorage.setItem(name, JSON.stringify(v)) } catch { /* private window: not kept */ } }, [name, v])
  return [v, setV] as const
}

const firstOfMonth = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), 1).toLocaleDateString('en-CA') }
const todayIso = () => new Date().toLocaleDateString('en-CA')

function RequestsTab({ desk, engineerOnly }: { desk: boolean; engineerOnly: boolean }) {
  const { me } = useAuth()
  const { data: trcs } = useTrcs()
  const { data: requests, isLoading } = usePartRequests()
  const [period, setPeriod] = useKept<ReqPeriod>('period', 'all')
  const [from, setFrom] = useKept('from', firstOfMonth())
  const [to, setTo] = useKept('to', todayIso())
  const [kind, setKind] = useKept<'all' | 'ticket' | 'stock'>('kind', engineerOnly ? 'stock' : 'all')
  const [sel, setSel] = useKept<StageKey | `${Lane}*` | null>('sel', null)
  const [openId, setOpenId] = useKept<string | null>('open', null)
  const linkState = useBack()
  // The scroll, left with the page and found again once the list is in.
  const scrolled = useRef(false)
  useEffect(() => () => { try { sessionStorage.setItem('revive-components:scroll', String(window.scrollY)) } catch { /* not kept */ } }, [])
  useEffect(() => {
    if (scrolled.current || !requests) return
    scrolled.current = true
    let y = 0
    try { y = Number(sessionStorage.getItem('revive-components:scroll') ?? 0) } catch { /* not kept */ }
    if (y > 0) requestAnimationFrame(() => window.scrollTo(0, y))
  }, [requests])
  const [asking, setAsking] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error' | 'warning'; text: string } | null>(null)
  const [billFor, setBillFor] = useState<PartRequest | null>(null)
  const [orderFor, setOrderFor] = useState<PartRequest | null>(null)
  const [stockFor, setStockFor] = useState<PartRequest | null>(null)
  const [declineFor, setDeclineFor] = useState<PartRequest | null>(null)
  const [viewing, setViewing] = useState<{ images: string[]; index: number } | null>(null)

  // Where this person may ask for a component for the stock.
  const askAt = useMemo(() => (trcs ?? []).filter(t => t.is_active && requestsStockAt(me, t.id)), [trcs, me])
  // What this person sees: from a ticket, the desk all and Purchase what came to them; for the stock, the lab's own
  // people, a manager of the lab, and Purchase what was passed to them (as before, rl_0044).
  const mine = useMemo(() => (requests ?? []).filter(r => r.ticket_id !== null
    ? !engineerOnly && (desk || purchaseSees(me, r))
    : (me?.is_admin || requestsStockAt(me, r.trc_id) || (!!me?.is_manager && me.trc_ids.includes(r.trc_id)) || purchaseSees(me, r))), [requests, me, desk, engineerOnly])
  const [a, b] = period === 'all' ? [null, null] : period === 'month' ? [firstOfMonth(), todayIso()] : from <= to ? [from, to] : [to, from]
  const inDays = useMemo(() => mine.filter(r => {
    if (kind === 'ticket' && r.ticket_id === null) return false
    if (kind === 'stock' && r.ticket_id !== null) return false
    const d = r.requested_at.slice(0, 10)
    return !a || (d >= a && d <= b!)
  }), [mine, kind, a, b])
  const counted = useMemo(() => inDays.map(r => ({ r, k: stageOf(r) })), [inDays])
  const shown = counted.filter(({ k }) => !sel || (sel.endsWith('*') ? k?.startsWith(sel[0] + '_') : k === sel))

  const paths = useMemo(() => shown.filter(x => x.r.id === openId).flatMap(x => [x.r.photo_path, ...x.r.bill_paths]).filter((p): p is string => !!p), [shown, openId])
  const { data: links } = useQuery({
    enabled: paths.length > 0,
    queryKey: ['revive', 'part-links', paths],
    staleTime: 50 * 60_000,
    queryFn: () => signedLinks(paths),
  })

  if (isLoading) return <Spinner className="h-5 w-5 text-ink-400" />
  const said = (text: string) => setNotice({ kind: 'success', text })
  const pick = (k: typeof sel) => setSel(s => (s === k ? null : k))

  return (
    <div className="space-y-4">
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {asking && (
        <RequestPartForm
          labs={askAt}
          onCancel={() => setAsking(false)}
          onError={text => setNotice({ kind: 'error', text })}
          onDone={(text, warning) => {
            setAsking(false)
            setNotice(warning ? { kind: 'warning', text: `${text} ${warning}` } : { kind: 'success', text })
          }}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-lg border border-ink-200">
          {([['all', 'All time'], ['month', 'This month'], ['custom', 'Custom']] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setPeriod(k)}
              className={clsx('h-9 px-3 text-sm font-semibold', period === k ? 'bg-ink-900 text-[color:rgb(var(--surface))]' : 'text-ink-700 hover:bg-ink-100')}>{l}</button>
          ))}
        </div>
        {period === 'custom' && (
          <span className="flex items-center gap-2 text-sm text-ink-600">
            From <input type="date" className="input !w-auto !py-1.5" value={from} max={todayIso()} onChange={e => setFrom(e.target.value)} />
            To <input type="date" className="input !w-auto !py-1.5" value={to} max={todayIso()} onChange={e => setTo(e.target.value)} />
          </span>
        )}
        {!engineerOnly && (
          <select className="input !w-auto !py-1.5" value={kind} onChange={e => setKind(e.target.value as typeof kind)} aria-label="For">
            <option value="all">For a ticket and for stock</option>
            <option value="ticket">For a ticket</option>
            <option value="stock">For stock</option>
          </select>
        )}
        {askAt.length > 0 && !asking && (
          <button type="button" className="btn-primary ml-auto !py-1.5 text-sm" onClick={() => { setNotice(null); setAsking(true) }}>
            <Plus className="h-4 w-4" /> Request a component
          </button>
        )}
      </div>

      {(['c', 'p'] as const).map(lane => {
        const L = STAGES[lane]
        const inLane = counted.filter(x => x.k?.startsWith(lane + '_'))
        const spent = inLane.reduce((t, x) => t + (x.r.bill_amount ?? 0), 0)
        return (
          <div key={lane}>
            <p className="mb-1.5 text-sm font-semibold text-ink-900">{L.who} <span className="font-normal text-ink-500">· {L.sub} · spent {rupees(spent)}</span></p>
            {/* Each row fills the width with its own boxes: the coordinator six, Purchase five (the user, 22 Oct). */}
            <div className={clsx('grid grid-cols-3 gap-2', lane === 'c' ? 'sm:grid-cols-6' : 'sm:grid-cols-5')}>
              <button type="button" onClick={() => pick(`${lane}*`)}
                className={clsx('rounded-xl border p-3 text-left', sel === `${lane}*` ? 'border-cyrixRed-500 ring-1 ring-cyrixRed-500' : 'border-ink-300 hover:border-ink-400')}>
                <span className="block text-2xl font-semibold tabular-nums text-ink-900">{inLane.length}</span>
                <span className="block text-xs text-ink-500">Total</span>
                <Split xs={inLane.map(x => x.r)} />
              </button>
              {L.stages.map(([k, label]) => {
                const n = inLane.filter(x => x.k === k).length
                return (
                  <button key={k} type="button" onClick={() => pick(k)}
                    className={clsx('rounded-xl border bg-ink-50 p-3 text-left', sel === k ? 'border-cyrixRed-500 ring-1 ring-cyrixRed-500' : 'border-transparent hover:border-ink-300')}>
                    <span className={clsx('block text-2xl font-semibold tabular-nums', n ? STAGE_INK[k] : 'text-ink-400')}>{n}</span>
                    <span className="block text-xs leading-tight text-ink-600">{label}</span>
                    {n > 0 && <Split xs={inLane.filter(x => x.k === k).map(x => x.r)} />}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}

      <div className="card overflow-hidden">
        <p className="border-b border-ink-200 bg-ink-50 px-4 py-2 text-xs text-ink-500">
          {period === 'all' ? 'All time' : period === 'month' ? 'This month' : `${day(a)} – ${day(b)}`} · {shown.length} request{shown.length === 1 ? '' : 's'}
          {sel && <button type="button" className="link-accent ml-2 font-medium" onClick={() => setSel(null)}>Show all</button>}
        </p>
        {shown.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={ClipboardList} title="Nothing here">
              No request in these days{sel ? ' at this stage' : ''}.
            </EmptyState>
          </div>
        ) : (
          <ul className="divide-y divide-ink-100">
            {shown.map(({ r, k }) => {
              const w = waitingOn(r, k)
              const step = k ? stepOf(k) : -1
              const head = (
                <>
                  <span className="font-mono text-sm font-semibold text-ink-900">{r.ticket_code ?? r.code}</span>
                  <span className="min-w-0 flex-1 text-sm text-ink-800">
                    <span className="tabular-nums">{r.qty} ×</span> {r.name}
                    <span className="block text-xs text-ink-500">
                      {r.ticket_id ? r.facility : `for ${r.trc_name}’s stock`}{r.ticket_id ? ` · ${r.trc_name}` : ''} · asked by {r.requested_by_name} {day(r.requested_at)}
                      {' · '}{PART_ROUTE_LABEL[r.route]}
                    </span>
                    {k && (
                      <span className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px]">
                        {JOURNEY.map((s, i) => (
                          <span key={s} className="inline-flex items-center gap-1">
                            {i > 0 && <span className="text-ink-300">›</span>}
                            <span className={clsx('rounded-full px-2 py-0.5', step === 4 || i < step ? 'text-green-700' : i === step ? clsx('font-semibold', STAGE_CHIP[k]) : 'text-ink-400')}>
                              {step === 4 || i < step ? '✓ ' : ''}{s}
                            </span>
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  <span className="min-w-[9rem] text-right text-xs text-ink-500">
                    {k && step < 4 && <span className="block">Waiting on</span>}
                    <span className={clsx('block font-semibold', w.late ? 'text-cyrixRed-700' : k ? STAGE_INK[k] : 'text-ink-500')}>{w.text}</span>
                    {r.po_number && <span className="block font-mono">{poLabel(r.po_number)}</span>}
                    {r.item_code && <span className="block font-mono">Item {r.item_code}</span>}
                    {r.bill_amount !== null && <span className="block font-medium tabular-nums text-ink-900">{rupees(r.bill_amount)}</span>}
                  </span>
                </>
              )
              return (
                <li key={r.id}>
                  {r.ticket_id ? (
                    <Link to={`/tickets/${r.ticket_code}`} state={linkState} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3 hover:bg-ink-50">{head}</Link>
                  ) : (
                    <>
                      <button type="button" onClick={() => setOpenId(id => (id === r.id ? null : r.id))}
                        className="flex w-full flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-ink-50">{head}</button>
                      {/* A request for the stock opens in place, with the buttons for whoever moves it next. */}
                      {openId === r.id && (
                        <div className="px-3 pb-3">
                          <RequestItem
                            r={r}
                            links={links ?? {}}
                            mine={partActor(r, me, r.trc_id, null)}
                            desk={runsTrc(me, r.trc_id)}
                            buyer={buysFor(me, r.trc_id)}
                            isEngineer={false}
                            isAsker={r.requested_by === me?.employee_id}
                            head={<>
                              <span className="font-mono font-semibold text-ink-900">{r.code}</span>
                              <span className="text-ink-500">for {r.trc_name}’s stock</span>
                            </>}
                            onBill={() => { setNotice(null); setBillFor(r) }}
                            onOrder={() => { setNotice(null); setOrderFor(r) }}
                            onStock={() => { setNotice(null); setStockFor(r) }}
                            onDecline={() => { setNotice(null); setDeclineFor(r) }}
                            onView={(images, index) => setViewing({ images, index })}
                            onNotice={setNotice}
                          />
                        </div>
                      )}
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {billFor && <BillDialog request={billFor} onClose={() => setBillFor(null)} onDone={text => { setBillFor(null); said(text) }} />}
      {orderFor && <OrderDialog request={orderFor} onClose={() => setOrderFor(null)} onDone={text => { setOrderFor(null); said(text) }} />}
      {stockFor && <StockDialog request={stockFor} onClose={() => setStockFor(null)} onDone={text => { setStockFor(null); said(text) }} />}
      {declineFor && (
        <DeclineDialog
          request={declineFor}
          buyer={buysFor(me, declineFor.trc_id) && !runsTrc(me, declineFor.trc_id)}
          onClose={() => setDeclineFor(null)}
          onDone={text => { setDeclineFor(null); said(text) }}
        />
      )}
      <Lightbox
        images={(viewing?.images ?? []).map((src, i) => ({ src, alt: `Photo ${i + 1}` }))}
        index={viewing?.index ?? null}
        onIndex={i => setViewing(v => (v ? { ...v, index: i } : v))}
        onClose={() => setViewing(null)}
      />
    </div>
  )
}


/** How many of these came from a ticket (RL) and how many were for the stock (PR), under a count (the user, 22 Oct). */
function Split({ xs }: { xs: PartRequest[] }) {
  const rl = xs.filter(x => x.ticket_id !== null).length
  return <span className="mt-1 block text-[11px] tabular-nums text-ink-500">RL {rl} · PR {xs.length - rl}</span>
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
  const linkState = useBack()
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
      day(r.purchased_at), r.ticket_code ?? r.code ?? '', r.trc_name, PART_ROUTE_LABEL[r.route], r.name, r.qty,
      r.vendor ?? '', r.bill_no ?? '', r.bill_amount ?? 0, r.purchased_by_name ?? '',
    ])
    const ws = XLSX.utils.aoa_to_sheet([['Purchased on', 'Ticket or PR', 'Revive Lab', 'Purchased as', 'Component', 'Qty', 'From', 'Bill no', 'Amount (₹)', 'Purchased by'], ...rows])
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
            <EmptyState icon={Receipt} title="Nothing purchased in this period">Bills attached to component requests add up here.</EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">
                  <th className="px-4 py-2 font-medium">Purchased</th>
                  <th className="px-4 py-2 font-medium">Ticket / PR</th>
                  <th className="px-4 py-2 font-medium">Component</th>
                  <th className="hidden px-4 py-2 font-medium md:table-cell">From</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {bought.map(r => (
                  <tr key={r.id} className="hover:bg-ink-50">
                    <td className="px-4 py-2 text-ink-600">{day(r.purchased_at)}</td>
                    <td className="px-4 py-2">
                      {r.ticket_code
                        ? <Link to={`/tickets/${r.ticket_code}`} state={linkState} className="font-mono font-semibold text-ink-900">{r.ticket_code}</Link>
                        : <span className="font-mono font-semibold text-ink-900">{r.code}</span>}
                    </td>
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
  const linkState = useBack()
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
                  {cell(<Link to={`/tickets/${t.code}`} state={linkState} className="font-mono font-semibold text-ink-900">{t.code}</Link>)}
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
