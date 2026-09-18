import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { ArrowDownUp, Inbox, PackagePlus, Search } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useTickets, useTrcs, type Ticket } from '@/lib/queries'
import {
  STATUS, STATUS_ORDER, TONE_CLASS, TONE_DOT, TONE_TEXT, canRaise, itemsSummary, parseTicketCode, ticketTabs,
  type TabId,
} from '@/lib/tickets'
import { EmptyState, PageLoader, SortHeader, StatusBadge } from '@/components/ui'

type SortKey = 'code' | 'raised' | 'status' | 'hospital' | 'spare' | 'trc' | 'field' | 'engineer' | 'age'

const COLUMN: Record<SortKey, string> = {
  code: 'Ticket', raised: 'Raised', status: 'Status', hospital: 'Hospital', spare: 'Spare', trc: 'Revive Lab',
  field: 'Field engineer', engineer: 'Revive Lab engineer', age: 'Age',
}

/** A column's first click: dates newest first, ages longest first, words A to Z. */
const FIRST_ASC: Record<SortKey, boolean> = {
  code: false, raised: false, age: false,
  status: true, hospital: true, spare: true, trc: true, field: true, engineer: true,
}

/** On a phone there are no column headings to click, so the orders are named. */
const PHONE_SORTS: Array<{ key: SortKey; asc: boolean; label: string }> = [
  { key: 'raised', asc: false, label: 'Newest first' },
  { key: 'raised', asc: true, label: 'Oldest first' },
  { key: 'status', asc: true, label: 'Status' },
  { key: 'hospital', asc: true, label: 'Hospital' },
  { key: 'trc', asc: true, label: 'Revive Lab' },
  { key: 'field', asc: true, label: 'Field engineer' },
]

function ageMs(t: Ticket): number {
  const end = t.closed_at ? Date.parse(t.closed_at) : Date.now()
  return Math.max(0, end - Date.parse(t.created_at))
}

/** "3d", "5h" — the age of an open ticket, or how long a closed one took. */
function age(t: Ticket): string {
  const ms = ageMs(t)
  const d = Math.floor(ms / 86_400_000)
  if (d >= 1) return `${d}d`
  const h = Math.floor(ms / 3_600_000)
  return h >= 1 ? `${h}h` : '<1h'
}

/** "17 Sep 2026" and the time, apart — always with the year, so a list that runs into January never leaves anyone guessing which one. */
function raisedOn(iso: string): { date: string; time: string } {
  const d = new Date(iso)
  return {
    date: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
    time: d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
  }
}

function sortValue(key: SortKey, t: Ticket): string | number | null {
  switch (key) {
    case 'code': return t.number
    case 'raised': return Date.parse(t.created_at)
    case 'status': return STATUS[t.status]?.order ?? 99
    case 'hospital': return t.facility
    case 'spare': return itemsSummary(t)
    case 'trc': return t.trc_name
    case 'field': return t.stakeholder_name
    case 'engineer': return t.engineer_name
    case 'age': return ageMs(t)
  }
}

const text = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

export default function Tickets() {
  const { me } = useAuth()
  const navigate = useNavigate()
  const { search } = useLocation()
  const [params, setParams] = useSearchParams()
  const { data: tickets, isLoading } = useTickets()
  const { data: trcs } = useTrcs()

  // Everything that shapes the list lives in the address, so coming back
  // from a ticket finds it as it was left.
  const setParam = (key: string, value: string | null) =>
    setParams(p => { if (value) p.set(key, value); else p.delete(key); return p }, { replace: true })

  // The tabs for what this person does (tickets.ts); an old link to a tab
  // they do not have lands on All.
  const tabs = useMemo(() => ticketTabs(me), [me])
  const asked = params.get('view') as TabId | null
  const tab = tabs.find(x => x.id === asked) ?? tabs[0]
  const view = tab.id
  const trcId = params.get('lab') ?? ''
  const status = params.get('status') ?? ''
  // The search box answers to every key at once; the address follows it,
  // and a link that clears the address clears the box.
  const urlQ = params.get('q') ?? ''
  const [q, setQ] = useState(urlQ)
  useEffect(() => { setQ(urlQ) }, [urlQ])

  const askedSort = params.get('sort') as SortKey | null
  const sortKey: SortKey = askedSort && (Object.keys(COLUMN) as SortKey[]).includes(askedSort) ? askedSort : 'raised'
  const order = params.get('order')
  const asc = order === 'asc' ? true : order === 'desc' ? false : FIRST_ASC[sortKey]

  const setSort = (key: SortKey, up: boolean) => setParams(p => {
    if (key === 'raised' && !up) p.delete('sort'); else p.set('sort', key)
    if (up === FIRST_ASC[key]) p.delete('order'); else p.set('order', up ? 'asc' : 'desc')
    return p
  }, { replace: true })

  const onSort = (key: SortKey) => setSort(key, key === sortKey ? !asc : FIRST_ASC[key])

  const counts = useMemo(() => {
    const all = tickets ?? []
    return Object.fromEntries(tabs.map(x => [x.id, all.filter(x.match).length])) as Record<TabId, number>
  }, [tickets, tabs])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const asNumber = parseTicketCode(q)
    let rows = (tickets ?? []).filter(tab.match)
    if (trcId) rows = rows.filter(t => t.trc_id === trcId)
    if (status) rows = rows.filter(t => t.status === status)
    if (needle) {
      rows = rows.filter(t =>
        (asNumber !== null && t.number === asNumber)
        || [t.code, t.source_ticket_no, t.facility, t.spare_name, t.equipment_name, t.equipment_barcode, t.district, t.state, t.bemmp_code,
            t.stakeholder_name, t.stakeholder_ecode, t.engineer_name, t.in_awb, t.out_awb,
            // Every spare and accessory, not just the first.
            ...(t.items ?? []).map(i => i.name)]
          .some(v => (v ?? '').toLowerCase().includes(needle)))
    }
    const dir = asc ? 1 : -1
    return [...rows].sort((a, b) => {
      const x = sortValue(sortKey, a), y = sortValue(sortKey, b)
      // Nobody yet (no engineer, no spare named) goes last whichever way it runs.
      if (x === null || y === null) {
        if (x !== y) return x === null ? 1 : -1
      } else {
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : text.compare(String(x), String(y))
        if (c !== 0) return c * dir
      }
      // Level on this column: newest first.
      return Date.parse(b.created_at) - Date.parse(a.created_at)
    })
  }, [tickets, tab, q, trcId, status, sortKey, asc])

  // The phone's order, named; one set by a column heading on a wider
  // screen is kept rather than shown as something it is not.
  const phoneSorts = PHONE_SORTS.some(s => s.key === sortKey && s.asc === asc)
    ? PHONE_SORTS
    : [...PHONE_SORTS, { key: sortKey, asc, label: `${COLUMN[sortKey]}, ${asc ? 'ascending' : 'descending'}` }]

  // Scrolled sideways: the ticket column, which stays put, gets an edge.
  const [slid, setSlid] = useState(false)

  if (isLoading) return <PageLoader />

  const pinned = clsx('sticky left-0 z-10 bg-surface', slid && 'shadow-[1px_0_0_rgb(var(--ink-200))]')
  const open = (t: Ticket) => navigate(`/tickets/${t.code}`, { state: { list: search } })

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Tickets</h1>
          <p className="mt-0.5 text-sm text-ink-500">Every spare you can follow.</p>
        </div>
        {canRaise(me) && (
          <Link to="/new" className="btn-primary">
            <PackagePlus className="h-4 w-4" /> Raise ticket
          </Link>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-ink-50 px-3 py-2">
          {/* Each tab in the colour of what it holds, and its count with it:
              a row of grey numbers says nothing about what needs doing. */}
          <div className="flex flex-wrap gap-1">
            {tabs.map(({ id, label, tone }) => {
              const on = view === id
              const n = counts[id]
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setParam('view', id)}
                  className={clsx(
                    'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    on ? clsx(TONE_CLASS[tone], 'shadow-sm') : 'text-ink-500 hover:text-ink-800',
                  )}
                >
                  <span aria-hidden className={clsx('h-1.5 w-1.5 rounded-full', TONE_DOT[tone], !on && !n && 'opacity-40')} />
                  {label}
                  <span className={clsx('tabular-nums', on ? 'opacity-70' : n ? TONE_TEXT[tone] : 'text-ink-300')}>{n}</span>
                </button>
              )
            })}
          </div>
          <div className="ml-auto flex w-full flex-wrap gap-2 sm:w-auto">
            <select className="input !py-1.5 sm:w-40" value={trcId} onChange={e => setParam('lab', e.target.value || null)} aria-label="Filter by Revive Lab">
              <option value="">All Revive Labs</option>
              {(trcs ?? []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select className="input !py-1.5 sm:w-44" value={status} onChange={e => setParam('status', e.target.value || null)} aria-label="Filter by status">
              <option value="">Any status</option>
              {STATUS_ORDER.map(s => <option key={s} value={s}>{STATUS[s].short}</option>)}
            </select>
            <label className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
              <input
                className="input !py-1.5 !pl-8"
                placeholder="RL-07, SR number, hospital…"
                value={q}
                onChange={e => { setQ(e.target.value); setParam('q', e.target.value || null) }}
                aria-label="Search tickets"
              />
            </label>
          </div>
        </div>

        {shown.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={Inbox} title={view === 'parts' ? 'No component is pending' : 'No tickets here'}>
              {view === 'parts'
                ? 'When a repair is waiting on a component — asked for, being bought, or ready — it shows up here.'
                : 'Try another tab, or clear the filters.'}
            </EmptyState>
          </div>
        ) : (
          <>
            {/* A table where there is room for one. Every heading sorts, and
                nothing wraps: when the columns need more room than the
                screen has, the table scrolls sideways and the ticket
                number stays where it is. */}
            <div className="hidden overflow-x-auto lg:block" onScroll={e => setSlid(e.currentTarget.scrollLeft > 0)}>
              <table className="w-full whitespace-nowrap text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">
                    <SortHeader label="Ticket" col="code" sortKey={sortKey} asc={asc} onSort={onSort} className={pinned} />
                    <SortHeader label="Raised" col="raised" sortKey={sortKey} asc={asc} onSort={onSort} />
                    <SortHeader label="Status" col="status" sortKey={sortKey} asc={asc} onSort={onSort} />
                    <SortHeader label="Hospital" col="hospital" sortKey={sortKey} asc={asc} onSort={onSort} />
                    <SortHeader label="Spare" col="spare" sortKey={sortKey} asc={asc} onSort={onSort} />
                    <SortHeader label="Revive Lab" col="trc" sortKey={sortKey} asc={asc} onSort={onSort} />
                    <SortHeader label="Field engineer" col="field" sortKey={sortKey} asc={asc} onSort={onSort} />
                    <SortHeader label="Revive Lab engineer" col="engineer" sortKey={sortKey} asc={asc} onSort={onSort} />
                    <SortHeader label="Age" col="age" align="right" sortKey={sortKey} asc={asc} onSort={onSort} />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {shown.map(t => {
                    const raised = raisedOn(t.created_at)
                    return (
                      <tr key={t.id} className="group cursor-pointer align-top hover:bg-ink-50" onClick={() => open(t)}>
                        <td className={clsx('px-4 py-3 group-hover:bg-ink-50', pinned)}>
                          <Link
                            to={`/tickets/${t.code}`}
                            state={{ list: search }}
                            className="font-mono font-semibold text-ink-900"
                            onClick={e => e.stopPropagation()}
                          >
                            {t.code}
                          </Link>
                          {t.source_ticket_no && <p className="text-xs text-ink-500">{t.source_ticket_no}</p>}
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-ink-800">{raised.date}</p>
                          <p className="text-xs text-ink-500">{raised.time}</p>
                        </td>
                        <td className="px-4 py-3"><StatusBadge status={t.status} closure={t.closure} /></td>
                        <td className="px-4 py-3">
                          <p className="text-ink-900">{t.facility}</p>
                          <p className="text-xs text-ink-500">{[t.district, t.bemmp_code].filter(Boolean).join(' · ')}</p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-ink-900">{itemsSummary(t) ?? <span className="text-ink-300">—</span>}</p>
                          <p className="text-xs text-ink-500">
                            {t.equipment_name}
                            {t.equipment_barcode && <>{t.equipment_name ? ' · ' : ''}<span className="font-mono" title="Equipment barcode">{t.equipment_barcode}</span></>}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-ink-700">{t.trc_name}</p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-ink-700">{t.stakeholder_name}</p>
                          <p className="text-xs text-ink-500">
                            {[t.stakeholder_ecode, t.stakeholder_function].filter(Boolean).join(' · ')}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          {t.engineer_name
                            ? <><p className="text-ink-700">{t.engineer_name}</p><p className="text-xs text-ink-500">{t.engineer_ecode}</p></>
                            : <span className="text-ink-300">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-ink-600">{age(t)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Cards on a phone or a tablet, where nine columns would be a
                sideways scroll — with the order named above them, since
                there are no headings to click. */}
            <div className="flex items-center justify-between gap-3 border-b border-ink-100 px-4 py-2 lg:hidden">
              <p className="text-xs text-ink-500">{shown.length} {shown.length === 1 ? 'ticket' : 'tickets'}</p>
              <label className="flex items-center gap-1.5 text-xs text-ink-500">
                <ArrowDownUp aria-hidden className="h-3.5 w-3.5" />
                Sort
                <select
                  className="input !w-auto !py-1 !pl-2 text-xs font-medium text-ink-800"
                  value={`${sortKey}.${asc ? 'asc' : 'desc'}`}
                  onChange={e => {
                    const [key, way] = e.target.value.split('.') as [SortKey, string]
                    setSort(key, way === 'asc')
                  }}
                >
                  {phoneSorts.map(s => (
                    <option key={`${s.key}.${s.asc}`} value={`${s.key}.${s.asc ? 'asc' : 'desc'}`}>{s.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <ul className="divide-y divide-ink-100 lg:hidden">
              {shown.map(t => {
                const raised = raisedOn(t.created_at)
                const spare = [itemsSummary(t), t.equipment_name, t.district].filter(Boolean).join(' · ')
                return (
                  <li key={t.id}>
                    <Link to={`/tickets/${t.code}`} state={{ list: search }} className="block space-y-1 px-4 py-3 hover:bg-ink-50">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate">
                          <span className="font-mono font-semibold text-ink-900">{t.code}</span>
                          {t.source_ticket_no && <span className="ml-2 text-xs text-ink-500">{t.source_ticket_no}</span>}
                        </span>
                        <StatusBadge status={t.status} closure={t.closure} />
                      </div>
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="min-w-0 text-sm text-ink-800">{t.facility}</p>
                        <p className="shrink-0 text-xs text-ink-500">{raised.date}, {raised.time}</p>
                      </div>
                      {spare && <p className="text-xs text-ink-500">{spare}</p>}
                      <p className="text-xs text-ink-500">
                        {t.trc_name} · {t.stakeholder_name} · {age(t)}
                      </p>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
