import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { Inbox, PackagePlus, Search } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useTickets, useTrcs, type Ticket } from '@/lib/queries'
import { STATUS, STATUS_ORDER, itemsSummary, waitingOnMe, parseTicketCode } from '@/lib/tickets'
import { EmptyState, PageLoader, SortHeader, StatusBadge } from '@/components/ui'

type View = 'mine' | 'open' | 'closed' | 'all'
type SortKey = 'code' | 'status' | 'trc' | 'facility' | 'age'

const VIEWS: Array<[View, string]> = [
  ['mine', 'Waiting on me'],
  ['open', 'Open'],
  ['closed', 'Closed'],
  ['all', 'All'],
]

/** "3d", "5h" — the age of an open ticket, or how long a closed one took. */
function age(t: Ticket): string {
  const end = t.closed_at ? Date.parse(t.closed_at) : Date.now()
  const ms = Math.max(0, end - Date.parse(t.created_at))
  const d = Math.floor(ms / 86_400_000)
  if (d >= 1) return `${d}d`
  const h = Math.floor(ms / 3_600_000)
  return h >= 1 ? `${h}h` : '<1h'
}

export default function Tickets() {
  const { me } = useAuth()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { data: tickets, isLoading } = useTickets()
  const { data: trcs } = useTrcs()

  const view = (params.get('view') as View) || 'open'
  const [q, setQ] = useState('')
  const [trcId, setTrcId] = useState('')
  const [status, setStatus] = useState('')
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [asc, setAsc] = useState(true)

  const counts = useMemo(() => {
    const all = tickets ?? []
    return {
      mine: all.filter(t => waitingOnMe(t, me)).length,
      open: all.filter(t => t.status !== 'closed').length,
      closed: all.filter(t => t.status === 'closed').length,
      all: all.length,
    }
  }, [tickets, me])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const asNumber = parseTicketCode(q)
    let rows = (tickets ?? []).filter(t =>
      view === 'mine' ? waitingOnMe(t, me)
        : view === 'open' ? t.status !== 'closed'
          : view === 'closed' ? t.status === 'closed'
            : true)
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
    if (sortKey) {
      const dir = asc ? 1 : -1
      const val = (t: Ticket): string | number =>
        sortKey === 'code' ? t.number
          : sortKey === 'status' ? STATUS[t.status].order
            : sortKey === 'trc' ? t.trc_name
              : sortKey === 'facility' ? t.facility.toLowerCase()
                : Date.parse(t.created_at)
      rows = [...rows].sort((a, b) => {
        const x = val(a), y = val(b)
        return (x < y ? -1 : x > y ? 1 : 0) * dir
      })
    }
    return rows
  }, [tickets, view, q, trcId, status, sortKey, asc, me])

  const onSort = (k: SortKey) => {
    if (sortKey === k) setAsc(v => !v)
    else { setSortKey(k); setAsc(true) }
  }

  if (isLoading) return <PageLoader />

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Tickets</h1>
          <p className="mt-0.5 text-sm text-ink-500">Every spare you can follow, newest first.</p>
        </div>
        <Link to="/new" className="btn-primary">
          <PackagePlus className="h-4 w-4" /> Raise ticket
        </Link>
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-ink-50 px-3 py-2">
          <div className="flex flex-wrap gap-1">
            {VIEWS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setParams(p => { p.set('view', id); return p }, { replace: true })}
                className={clsx(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  view === id ? 'bg-surface text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-800',
                )}
              >
                {label}
                <span className="ml-1.5 tabular-nums text-ink-400">{counts[id]}</span>
              </button>
            ))}
          </div>
          <div className="ml-auto flex w-full flex-wrap gap-2 sm:w-auto">
            <select className="input !py-1.5 sm:w-40" value={trcId} onChange={e => setTrcId(e.target.value)} aria-label="Filter by Revive Lab">
              <option value="">All Revive Labs</option>
              {(trcs ?? []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select className="input !py-1.5 sm:w-44" value={status} onChange={e => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="">Any status</option>
              {STATUS_ORDER.map(s => <option key={s} value={s}>{STATUS[s].short}</option>)}
            </select>
            <label className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
              <input
                className="input !py-1.5 !pl-8"
                placeholder="RL-07, SR number, hospital…"
                value={q}
                onChange={e => setQ(e.target.value)}
                aria-label="Search tickets"
              />
            </label>
          </div>
        </div>

        {shown.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={Inbox} title={view === 'mine' ? 'Nothing is waiting on you' : 'No tickets here'}>
              {view === 'mine'
                ? 'When a ticket needs your move — accepting, assigning, repairing, dispatching — it shows up here.'
                : 'Try another view, or clear the filters.'}
            </EmptyState>
          </div>
        ) : (
          <>
            {/* A table where there is room for one. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">
                    <SortHeader label="Ticket" col="code" sortKey={sortKey} asc={asc} onSort={onSort} />
                    <SortHeader label="Status" col="status" sortKey={sortKey} asc={asc} onSort={onSort} />
                    <SortHeader label="Revive Lab" col="trc" sortKey={sortKey} asc={asc} onSort={onSort} />
                    <SortHeader label="Facility" col="facility" sortKey={sortKey} asc={asc} onSort={onSort} />
                    <th className="px-4 py-2.5 font-medium">Field engineer</th>
                    <th className="px-4 py-2.5 font-medium">Revive Lab engineer</th>
                    <SortHeader label="Age" col="age" align="right" sortKey={sortKey} asc={asc} onSort={onSort} />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {shown.map(t => (
                    <tr
                      key={t.id}
                      className="cursor-pointer hover:bg-ink-50"
                      onClick={() => navigate(`/tickets/${t.code}`)}
                    >
                      <td className="px-4 py-3">
                        <Link to={`/tickets/${t.code}`} className="font-mono font-semibold text-ink-900" onClick={e => e.stopPropagation()}>
                          {t.code}
                        </Link>
                        {t.source_ticket_no && <p className="text-xs text-ink-400">{t.source_ticket_no}</p>}
                      </td>
                      <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
                      <td className="px-4 py-3 text-ink-700">{t.trc_name}</td>
                      <td className="px-4 py-3">
                        <p className="text-ink-900">{t.facility}</p>
                        <p className="text-xs text-ink-400">{[itemsSummary(t), t.equipment_name, t.district].filter(Boolean).join(' · ')}</p>
                      </td>
                      <td className="px-4 py-3 text-ink-700">
                        {t.stakeholder_name}
                        <span className="ml-1.5 text-xs text-ink-400">{t.stakeholder_ecode}</span>
                      </td>
                      <td className="px-4 py-3 text-ink-700">{t.engineer_name ?? <span className="text-ink-300">—</span>}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-ink-600">{age(t)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Cards on a phone, where seven columns would be a sideways scroll. */}
            <ul className="divide-y divide-ink-100 md:hidden">
              {shown.map(t => (
                <li key={t.id}>
                  <Link to={`/tickets/${t.code}`} className="block space-y-1.5 px-4 py-3 hover:bg-ink-50">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-ink-900">{t.code}</span>
                      <StatusBadge status={t.status} />
                    </div>
                    <p className="text-sm text-ink-800">{t.facility}</p>
                    <p className="text-xs text-ink-500">
                      {t.trc_name} · {t.stakeholder_name} · {age(t)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
