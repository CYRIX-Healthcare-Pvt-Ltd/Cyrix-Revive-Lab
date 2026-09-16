import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { ArrowRight, Inbox, PackagePlus } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useTickets, useTrcs, useVisibleEvents } from '@/lib/queries'
import { STATUS, STATUS_ORDER, TONE_FILL, waitingOnMe } from '@/lib/tickets'
import { asDays, formatSpan, ticketTat, type TatEvent } from '@/lib/tat'
import { EmptyState, PageLoader, StatTile, StatusBadge } from '@/components/ui'

const TOOLTIP = { fontSize: 12, borderRadius: 8, border: '1px solid #d4d8e0' }
const TICK = { fontSize: 11, fill: '#606b82' }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Where everything is, and how long it is taking.
 *
 * Counted from exactly the tickets this person can see — a field engineer's
 * dashboard is their own spares, a coordinator's is their lab, an admin's is
 * everything — so the same screen serves everybody without a second set of
 * rules about who may see which number.
 */
export default function Dashboard() {
  const { me, employee } = useAuth()
  const { data: tickets, isLoading } = useTickets()
  const { data: events } = useVisibleEvents()
  const { data: trcs } = useTrcs()

  const stats = useMemo(() => {
    const all = tickets ?? []
    const byTicket = new Map<string, TatEvent[]>()
    for (const e of events ?? []) {
      const list = byTicket.get(e.ticket_id) ?? []
      list.push(e)
      byTicket.set(e.ticket_id, list)
    }
    const tatOf = (id: string, trcId: string) => ticketTat(byTicket.get(id) ?? [], trcId)

    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const ninetyDays = Date.now() - 90 * 86_400_000

    const closed = all.filter(t => t.status === 'closed' && t.closed_at)
    const recentClosed = closed.filter(t => Date.parse(t.closed_at!) >= ninetyDays)
    const avgTotal = recentClosed.length
      ? recentClosed.reduce((a, t) => a + (tatOf(t.id, t.trc_id).total.ms ?? 0), 0) / recentClosed.length
      : null

    const byStatus = STATUS_ORDER.map(s => ({
      status: s,
      name: STATUS[s].short,
      count: all.filter(t => t.status === s).length,
      fill: TONE_FILL[STATUS[s].tone],
    }))

    const byTrc = (trcs ?? []).map(trc => ({
      name: trc.name,
      Open: all.filter(t => t.trc_id === trc.id && t.status !== 'closed').length,
      Closed: all.filter(t => t.trc_id === trc.id && t.status === 'closed').length,
    })).filter(r => r.Open + r.Closed > 0)

    // The last six months, by the month each ticket closed in.
    const trend = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1)
      const next = new Date(d.getFullYear(), d.getMonth() + 1, 1)
      const inMonth = closed.filter(t => {
        const c = Date.parse(t.closed_at!)
        return c >= d.getTime() && c < next.getTime()
      })
      const avg = (pick: 'total' | 'repair' | 'reach') => {
        const vals = inMonth.map(t => tatOf(t.id, t.trc_id)[pick].ms).filter((v): v is number => v !== null)
        return vals.length ? asDays(vals.reduce((a, v) => a + v, 0) / vals.length) : null
      }
      return {
        month: `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`,
        'End to end': avg('total'),
        Repair: avg('repair'),
        'Reach TRC': avg('reach'),
        closed: inMonth.length,
      }
    })

    return {
      open: all.filter(t => t.status !== 'closed').length,
      mine: all.filter(t => waitingOnMe(t, me)),
      inRepair: all.filter(t => t.status === 'assigned' || t.status === 'in_repair').length,
      moving: all.filter(t => t.status === 'in_transit_return' || t.status === 'transferred').length,
      closedThisMonth: closed.filter(t => Date.parse(t.closed_at!) >= monthStart).length,
      avgTotal,
      recentClosed: recentClosed.length,
      byStatus,
      byTrc,
      trend,
      total: all.length,
    }
  }, [tickets, events, trcs, me])

  if (isLoading) return <PageLoader />

  const firstName = employee?.full_name.split(/\s+/)[0]

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">
            {firstName ? `Hello, ${firstName}` : 'Revive Lab'}
          </h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Where every spare is, and how long it has taken.
          </p>
        </div>
        <Link to="/new" className="btn-primary">
          <PackagePlus className="h-4 w-4" /> Raise ticket
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Open" value={stats.open} sub={`of ${stats.total} tickets`} />
        <StatTile label="Waiting on you" value={stats.mine.length} sub="your move next" tone={stats.mine.length ? 'brand' : 'default'} />
        <StatTile label="At the bench" value={stats.inRepair} sub="assigned or in repair" />
        <StatTile label="In transit" value={stats.moving} sub="going back, or between TRCs" />
        <StatTile
          label="Average TAT"
          value={stats.avgTotal === null ? '—' : formatSpan(stats.avgTotal)}
          sub={stats.recentClosed ? `raised to received · ${stats.recentClosed} closed, 90 days` : 'nothing closed in 90 days'}
        />
      </div>

      {stats.total === 0 ? (
        <EmptyState icon={Inbox} title="No tickets yet">
          A ticket starts when a field engineer sends a defective spare to a TRC, or when one arrives
          at the TRC and the coordinator raises it. <Link to="/new" className="link-accent">Raise the first one</Link>.
        </EmptyState>
      ) : (
        <>
          {stats.mine.length > 0 && (
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-ink-200 bg-ink-50 px-4 py-2.5">
                <h3 className="text-sm font-semibold text-ink-800">Waiting on you</h3>
                <Link to="/tickets?view=mine" className="inline-flex items-center gap-1 text-xs font-medium text-ink-600 hover:text-ink-900">
                  All of them <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
              <ul className="divide-y divide-ink-100">
                {stats.mine.slice(0, 5).map(t => (
                  <li key={t.id}>
                    <Link to={`/tickets/${t.code}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-ink-50">
                      <span className="font-mono text-sm font-semibold text-ink-900">{t.code}</span>
                      <StatusBadge status={t.status} />
                      <span className="min-w-0 flex-1 truncate text-sm text-ink-600">
                        {t.facility}{t.item ? ` · ${t.item}` : ''}
                      </span>
                      <span className="text-xs text-ink-400">{t.trc_name}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="card p-4">
              <h3 className="mb-1 text-sm font-semibold text-ink-800">Tickets by status</h3>
              <p className="mb-3 text-xs text-ink-500">Every ticket you can see, by where it is in the journey.</p>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.byStatus} layout="vertical" margin={{ left: 10, right: 16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eceef2" horizontal={false} />
                    <XAxis type="number" allowDecimals={false} tick={TICK} />
                    <YAxis type="category" dataKey="name" width={118} tick={TICK} />
                    <Tooltip contentStyle={TOOLTIP} formatter={(v: unknown) => [`${v}`, 'Tickets']} />
                    <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                      {stats.byStatus.map(d => <Cell key={d.status} fill={d.fill} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="card p-4">
              <h3 className="mb-1 text-sm font-semibold text-ink-800">Tickets by TRC</h3>
              <p className="mb-3 text-xs text-ink-500">Where each ticket is now — a transferred ticket counts at the TRC it went to.</p>
              <div className="h-64">
                {stats.byTrc.length === 0 ? (
                  <p className="pt-16 text-center text-sm text-ink-400">No tickets at any TRC yet.</p>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={stats.byTrc} margin={{ left: -10, right: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eceef2" vertical={false} />
                      <XAxis dataKey="name" tick={TICK} />
                      <YAxis allowDecimals={false} tick={TICK} />
                      <Tooltip contentStyle={TOOLTIP} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="Open" stackId="a" fill="#d97706" />
                      <Bar dataKey="Closed" stackId="a" fill="#11141c" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>

          <div className="card p-4">
            <h3 className="mb-1 text-sm font-semibold text-ink-800">TAT trend</h3>
            <p className="mb-3 text-xs text-ink-500">
              Average days, for tickets closed in each month: end to end, time at the bench, and time to reach the TRC.
            </p>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={stats.trend} margin={{ left: -10, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eceef2" vertical={false} />
                  <XAxis dataKey="month" tick={TICK} />
                  <YAxis tick={TICK} />
                  <Tooltip
                    contentStyle={TOOLTIP}
                    formatter={(v: unknown) => (typeof v === 'number' ? `${v} days` : '—')}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="End to end" stroke="#11141c" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                  <Line type="monotone" dataKey="Repair" stroke="#4f46e5" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                  <Line type="monotone" dataKey="Reach TRC" stroke="#d97706" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

