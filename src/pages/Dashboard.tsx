import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { AlarmClock, ArrowRight, BellRing, Building2, ChartColumn, HardHat, Inbox, PackagePlus, TrendingUp, Users } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useMembers, useMyTeam, useTickets, useTrcs, useVisibleEvents } from '@/lib/queries'
import {
  REPAIRING, STATUS, STATUS_ORDER, TONE_DOT, TONE_FILL, TONE_TEXT, canRaise, itemsSummary, statusGroups, ticketTabs, waitingOnMe,
} from '@/lib/tickets'
import { asDays, formatSpan, ticketTat, type TatEvent } from '@/lib/tat'
import { EmptyState, PageLoader, ReturnedTag, SectorTag, StatTile, TransferTag, WarehouseChip } from '@/components/ui'
import IconChip from '@/components/IconChip'
import { CATEGORY_CLASS, ClassTag } from '@/components/Classification'
import {
  PERIODS, categoryReport, countTickets, engineerWork, inRange, indexTeam, ownerOfTicket, percent, periodRange,
  type CategoryRow, type EngineerWork, type Period,
} from '@/lib/team'

const TOOLTIP = { fontSize: 12, borderRadius: 8, border: '1px solid #d4d8e0' }
const TICK = { fontSize: 11, fill: '#606b82' }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** Revive Lab went live in September 2026; the trend has nothing to say before it. */
const FIRST_MONTH = new Date(2026, 8, 1)

/**
 * Where everything is, and how long it is taking.
 *
 * Counted from exactly the tickets this person can see — a field engineer's
 * dashboard is their own spares, a coordinator's is their Revive Lab, an admin's is
 * everything — so the same screen serves everybody without a second set of
 * rules about who may see which number.
 */
export default function Dashboard() {
  const { me, employee } = useAuth()
  const { data: tickets, isLoading } = useTickets()
  const { data: events } = useVisibleEvents()
  const { data: trcs } = useTrcs()
  // The desk's own reports need its engineers, idle ones included.
  const desk = !!me && (me.is_coordinator || me.is_manager || me.is_admin)
  const { data: members } = useMembers(desk)
  const { data: team } = useMyTeam()
  const [params, setParams] = useSearchParams()
  const period: Period = PERIODS.some(p => p.id === params.get('period')) ? params.get('period') as Period : 'month'
  const words = PERIODS.find(p => p.id === period)!.words

  const stats = useMemo(() => {
    /*
      Only what came to this person. Their first tab asks the same question —
      Purchase sees the tickets a purchase request brought them and nothing
      else, and a dashboard counting the rest counted other people's work.
    */
    const [mine] = ticketTabs(me)
    const all = (tickets ?? []).filter(mine.match)
    const byTicket = new Map<string, TatEvent[]>()
    for (const e of events ?? []) {
      const list = byTicket.get(e.ticket_id) ?? []
      list.push(e)
      byTicket.set(e.ticket_id, list)
    }
    const tatOf = (id: string, trcId: string) => ticketTat(byTicket.get(id) ?? [], trcId)

    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const range = periodRange(period)

    // A ticket discarded before it went anywhere took no turnaround to count.
    const closed = all.filter(t => t.status === 'closed' && t.closed_at && t.closure !== 'discarded')
    const recentClosed = closed.filter(t => inRange(Date.parse(t.closed_at!), range))
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

    /*
      Month by month, by the month each ticket closed in — from September
      2026, when Revive Lab went live (the user, 24 Sep: "start tat trend
      from sep 26"), to this month; the last twelve once there are more.
    */
    const first = Math.max(FIRST_MONTH.getTime(), new Date(now.getFullYear(), now.getMonth() - 11, 1).getTime())
    const months: Date[] = []
    for (let d = new Date(first); d.getTime() <= now.getTime(); d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(d)
    const trend = months.map(d => {
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
        'Reach Revive Lab': avg('reach'),
        closed: inMonth.length,
      }
    })

    return {
      open: all.filter(t => t.status !== 'closed').length,
      mine: all.filter(t => waitingOnMe(t, me)),
      // Back with the field engineer, waiting to be fitted and closed (rl_0015).
      back: all.filter(t => t.status === 'received_back').length,
      // Waiting on a component is still in repair.
      inRepair: all.filter(t => t.status === 'assigned' || REPAIRING.includes(t.status)).length,
      moving: all.filter(t => t.status === 'in_transit_return' || t.status === 'transferred').length,
      closedThisMonth: closed.filter(t => Date.parse(t.closed_at!) >= monthStart).length,
      avgTotal,
      recentClosed: recentClosed.length,
      byStatus,
      byTrc,
      trend,
      total: all.length,
    }
  }, [tickets, events, trcs, me, period])

  // Every Revive Lab engineer at this person's Revive Labs (all of them for an admin), and the reports on them.
  const lab = useMemo(() => {
    if (!desk) return null
    const all = tickets ?? []
    const history = new Map<string, TatEvent[]>()
    for (const e of events ?? []) {
      const list = history.get(e.ticket_id) ?? []
      list.push(e)
      history.set(e.ticket_id, list)
    }
    const roster = (members ?? [])
      .filter(m => m.is_engineer && (me!.is_admin || m.trc_ids.some(id => me!.trc_ids.includes(id))))
      .map(m => ({ id: m.employee_id, name: m.full_name }))
    const range = periodRange(period)
    return {
      engineers: engineerWork(all, id => history.get(id) ?? [], roster, Date.now(), range),
      categories: categoryReport(all),
    }
  }, [desk, tickets, events, members, me, period])

  // The viewer's team's spares, for the card that leads to My team (rl_0029).
  const teamCounts = useMemo(() => {
    const ix = indexTeam(team)
    const list = (tickets ?? []).filter(t => ownerOfTicket(ix, t))
    return list.length ? countTickets(list) : null
  }, [team, tickets])

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
        <div className="flex flex-wrap items-center gap-2">
          {/* The period for everything about what happened — sent back, on
              time, the average. What is true now needs none. */}
          <div className="inline-flex rounded-lg border border-ink-200 bg-ink-50 p-0.5" role="group" aria-label="Period">
            {PERIODS.map(p => (
              <button
                key={p.id}
                type="button"
                aria-pressed={period === p.id}
                onClick={() => setParams(q => { if (p.id === 'month') q.delete('period'); else q.set('period', p.id); return q }, { replace: true })}
                className={clsx('rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  period === p.id ? 'bg-surface text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-800')}
              >
                {p.label}
              </button>
            ))}
          </div>
          {canRaise(me) && (
            <Link to="/new" className="btn-primary">
              <PackagePlus className="h-4 w-4" /> Raise ticket
            </Link>
          )}
        </div>
      </div>

      {/* grid-fill: the fifth tile takes a whole row on a phone rather than half of one. */}
      <div className="grid-fill grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Open" value={stats.open} sub={`of ${stats.total} tickets`} />
        <StatTile label="Waiting on you" value={stats.mine.length} sub="your move next" tone={stats.mine.length ? 'brand' : 'default'} />
        <StatTile label="With Revive Lab engineer" value={stats.inRepair} sub="assigned or being repaired" />
        <StatTile
          label="In transit"
          value={stats.moving}
          sub={stats.back ? `going back · ${stats.back} to be fitted` : 'going back, or between Revive Labs'}
        />
        {/* From raising to back with the field engineer, averaged over the
            tickets closed in the period chosen above. */}
        <StatTile
          label="Average TAT"
          value={stats.avgTotal === null ? '—' : formatSpan(stats.avgTotal)}
          sub={stats.recentClosed
            ? `raised → back with the field engineer · ${stats.recentClosed} closed ${words}`
            : `raised → back with the field engineer · none closed ${words}`}
        />
      </div>

      {stats.total === 0 ? (
        <EmptyState icon={Inbox} title="No tickets yet">
          A ticket starts when a field engineer sends a defective spare to a Revive Lab, or when one arrives
          at the Revive Lab and the coordinator raises it.
          {canRaise(me) && <> <Link to="/new" className="link-accent">Raise the first one</Link>.</>}
        </EmptyState>
      ) : (
        <>
          {/* The one card that asks something of whoever reads it: a neon
              edge in the Cyrix red, and what waits in groups by where each
              spare stands — Pending acceptance, Pending dispatch … — in the
              order a spare goes through them (the user, 23 Sep). */}
          {stats.mine.length > 0 && (
            <div className="neon-card">
              <div className="neon-card-body">
                <div className="flex items-center justify-between border-b border-ink-200 bg-ink-50 px-4 py-2.5">
                  <h3 className="flex items-center gap-2.5 text-sm font-semibold text-ink-800">
                    <IconChip icon={BellRing} tone="red" /> Waiting on you
                  </h3>
                  <Link
                    to="/tickets?view=mine"
                    className="rounded-full bg-cyrixRed-600 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-white hover:bg-cyrixRed-700"
                    title="Open them on Tickets"
                  >
                    {stats.mine.length}
                  </Link>
                </div>
                {statusGroups(stats.mine).map(g => (
                  <section key={g.key} aria-label={`${g.label}: ${g.rows.length}`}>
                    <h4 className="flex items-center gap-2 border-b border-ink-100 bg-ink-50/60 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-label">
                      <span aria-hidden className={clsx('h-2 w-2 rounded-full', TONE_DOT[g.tone])} />
                      <span className={TONE_TEXT[g.tone]}>{g.label}</span>
                      <span className="tabular-nums text-ink-400">{g.rows.length}</span>
                    </h4>
                    <ul className="divide-y divide-ink-100 border-b border-ink-100 last:border-b-0">
                      {g.rows.map(t => (
                        <li key={t.id}>
                          <Link to={`/tickets/${t.code}`} state={{ back: { to: '/', label: 'Dashboard' } }} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-ink-50">
                            <span className="font-mono text-sm font-semibold text-ink-900">{t.code}</span>
                            {t.source === 'warehouse' && <WarehouseChip />}
                            <ReturnedTag ticket={t} />
                            <TransferTag ticket={t} />
                            <span className="min-w-0 flex-1 truncate text-sm text-ink-600">
                              {t.facility} <SectorTag ticket={t} className="mx-0.5" />{itemsSummary(t) ? ` · ${itemsSummary(t)}` : ''}
                            </span>
                            <ClassTag ticket={t} />
                            <span className="text-xs text-ink-400">{t.trc_name}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </div>
          )}

          {teamCounts && (
            <Link to="/team" className="card flex flex-wrap items-center gap-x-5 gap-y-2 p-4 hover:bg-ink-50">
              <span className="flex items-center gap-2.5 text-sm font-semibold text-ink-800">
                <IconChip icon={Users} tone="violet" /> My team
              </span>
              <span className="text-sm text-ink-600"><b className="tabular-nums text-ink-900">{teamCounts.open}</b> open</span>
              <span className="text-sm text-ink-600"><b className="tabular-nums text-ink-900">{teamCounts.byStage.repair}</b> being repaired</span>
              <span className="text-sm text-ink-600"><b className="tabular-nums text-ink-900">{teamCounts.byStage.sent}</b> not yet accepted</span>
              <span className={clsx('text-sm', teamCounts.late ? 'text-cyrixRed-700' : 'text-ink-600')}>
                <b className="tabular-nums">{teamCounts.late}</b> above TAT
              </span>
              <span className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-ink-700">
                Everyone under you, team by team <ArrowRight aria-hidden className="h-4 w-4" />
              </span>
            </Link>
          )}

          {lab && <CategoryTat rows={lab.categories} />}
          {lab && <EngineerTable rows={lab.engineers} words={words} />}
          {lab && <EngineerCategories rows={lab.engineers} words={words} />}

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="card p-4">
              <h3 className="mb-1 flex items-center gap-2.5 text-sm font-semibold text-ink-800">
                <IconChip icon={ChartColumn} tone="sky" /> Tickets by status
              </h3>
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
              <h3 className="mb-1 flex items-center gap-2.5 text-sm font-semibold text-ink-800">
                <IconChip icon={Building2} tone="violet" /> Tickets by Revive Lab
              </h3>
              <p className="mb-3 text-xs text-ink-500">Where each ticket is now — a transferred ticket counts at the Revive Lab it went to.</p>
              <div className="h-64">
                {stats.byTrc.length === 0 ? (
                  <p className="pt-16 text-center text-sm text-ink-400">No tickets at any Revive Lab yet.</p>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={stats.byTrc} margin={{ left: -10, right: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eceef2" vertical={false} />
                      <XAxis dataKey="name" tick={TICK} />
                      <YAxis allowDecimals={false} tick={TICK} />
                      <Tooltip contentStyle={TOOLTIP} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="Open" stackId="a" fill="#d97706" />
                      <Bar dataKey="Closed" stackId="a" fill={TONE_FILL.green} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>

          <div className="card p-4">
            <h3 className="mb-1 flex items-center gap-2.5 text-sm font-semibold text-ink-800">
              <IconChip icon={TrendingUp} tone="indigo" /> TAT trend
            </h3>
            <p className="mb-3 text-xs text-ink-500">
              Average days, for tickets closed in each month: end to end, repair time with the Revive Lab engineer, and time to reach the Revive Lab.
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
                  <Line type="monotone" dataKey="Reach Revive Lab" stroke="#d97706" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * A, B and C against their time — the Revive Lab's clock for each runs from
 * acceptance until the spare is dispatched back (rl_0024). What is at the
 * Revive Lab now: in TAT and above it, as counts and as a share.
 */
function CategoryTat({ rows }: { rows: CategoryRow[] }) {
  return (
    <div className="card p-4">
      <h3 className="mb-1 flex items-center gap-2.5 text-sm font-semibold text-ink-800">
        <IconChip icon={AlarmClock} tone="red" /> TAT by category
      </h3>
      <p className="mb-3 text-xs text-ink-500">
        Each category has its own time at the Revive Lab, from acceptance until it is dispatched back:
        A 3 days, B 2, C 1. In TAT is still inside it; above TAT is past it.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {rows.map(r => {
          const inShare = r.atLab ? r.inTat / r.atLab : null
          return (
            <div key={r.category} className="rounded-xl border border-ink-200 p-3">
              <div className="flex items-center gap-2">
                <span className={clsx('inline-block min-w-6 rounded px-1.5 py-0.5 text-center text-sm font-bold', CATEGORY_CLASS[r.category])}>
                  {r.category}
                </span>
                <span className="text-sm font-medium text-ink-800">{r.days} {r.days === 1 ? 'day' : 'days'}</span>
              </div>
              <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div>
                  <dt className="text-[11px] text-ink-500">At the lab</dt>
                  <dd className="text-lg font-semibold tabular-nums text-ink-900">{r.atLab}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-ink-500">In TAT</dt>
                  <dd className={clsx('text-lg font-semibold tabular-nums', r.inTat ? 'text-green-700' : 'text-ink-300')}>{r.inTat}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-ink-500">Above TAT</dt>
                  <dd className={clsx('text-lg font-semibold tabular-nums', r.aboveTat ? 'text-cyrixRed-600' : 'text-ink-300')}>{r.aboveTat}</dd>
                </div>
              </dl>
              <div className="mt-3 border-t border-ink-100 pt-2">
                <div className="flex items-baseline justify-between text-xs">
                  <span className={clsx('font-semibold tabular-nums', inShare === null ? 'text-ink-300' : 'text-green-700')}>
                    In TAT {percent(r.inTat, r.atLab)}
                  </span>
                  <span className={clsx('font-semibold tabular-nums', inShare === null ? 'text-ink-300' : r.aboveTat ? 'text-cyrixRed-600' : 'text-ink-400')}>
                    Above TAT {percent(r.aboveTat, r.atLab)}
                  </span>
                </div>
                <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-ink-100" aria-hidden>
                  {inShare !== null && <>
                    <div className="h-full bg-green-500" style={{ width: `${Math.round(inShare * 100)}%` }} />
                    <div className="h-full bg-cyrixRed-500" style={{ width: `${100 - Math.round(inShare * 100)}%` }} />
                  </>}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** A heading cell, right-aligned; its title is what a hover explains. */
const TH = 'px-3 py-2 text-right font-semibold'

/** A count, grey at nought. */
function Count({ n, strong = false }: { n: number; strong?: boolean }) {
  return <span className={clsx('tabular-nums', n ? (strong ? 'font-semibold text-ink-900' : 'text-ink-700') : 'text-ink-300')}>{n}</span>
}

/** An average time, or a dash when there is nothing to average. */
const avg = (ms: number | null) => (ms === null ? <span className="text-ink-300">—</span> : formatSpan(ms))

/**
 * The engineers, as the user laid it out (24 Sep): total tickets, closed,
 * closed %, the average closure TAT, open, and the average open TAT. Closed
 * is repairs they closed in the period; open is with them now.
 */
function EngineerTable({ rows, words }: { rows: EngineerWork[]; words: string }) {
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-ink-200 bg-ink-50 px-4 py-2.5">
        <h3 className="flex items-center gap-2.5 text-sm font-semibold text-ink-800">
          <IconChip icon={HardHat} tone="indigo" /> Revive Lab engineers
        </h3>
        <p className="mt-1 text-xs text-ink-500">Closed is {words}; open is now. Open an engineer to see their tickets.</p>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-ink-400">No Revive Lab engineer has had a ticket yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-sm">
            <thead>
              <tr className="border-b border-ink-200 text-left text-[11px] font-semibold uppercase tracking-label text-ink-400">
                <th className="px-4 py-2 font-semibold">Engineer</th>
                <th className={TH} title={`Closed ${words}, and open now`}>Total tickets</th>
                <th className={TH} title={`Repairs they closed ${words}`}>Closed</th>
                <th className={TH}>Closed %</th>
                <th className={TH} title="Closed less assigned, on average">Average closure TAT</th>
                <th className={TH} title="Assigned, in repair or waiting for a component">Open</th>
                <th className="px-4 py-2 text-right font-semibold" title="Today less assigned, on average">Average open TAT</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.map(r => (
                <tr key={r.id} className="hover:bg-ink-50">
                  <td className="px-4 py-2.5">
                    <Link to={`/tickets?eng=${r.id}`} className="font-medium text-ink-900 hover:underline">{r.name}</Link>
                  </td>
                  <td className="px-3 py-2.5 text-right"><Count n={r.total} strong /></td>
                  <td className="px-3 py-2.5 text-right"><Count n={r.closed} /></td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {r.total ? <span className="font-semibold text-ink-800">{percent(r.closed, r.total)}</span> : <span className="text-ink-300">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{avg(r.avgClosureMs)}</td>
                  <td className="px-3 py-2.5 text-right"><Count n={r.open} strong /></td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-ink-700">{avg(r.avgOpenMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/**
 * The same engineers by category (the user, 24 Sep): total and open, then A,
 * B and C each as total and open.
 */
function EngineerCategories({ rows, words }: { rows: EngineerWork[]; words: string }) {
  const shown = rows.filter(r => r.total > 0)
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-ink-200 bg-ink-50 px-4 py-2.5">
        <h3 className="flex items-center gap-2.5 text-sm font-semibold text-ink-800">
          <IconChip icon={HardHat} tone="violet" /> Engineers by category
        </h3>
        <p className="mt-1 text-xs text-ink-500">Total is closed {words} and open now; A 3 days, B 2, C 1.</p>
      </div>
      {shown.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-ink-400">No Revive Lab engineer has a ticket {words}.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-sm">
            <thead>
              <tr className="text-[11px] font-semibold uppercase tracking-label text-ink-400">
                <th rowSpan={2} className="border-b border-ink-200 px-4 py-2 text-left align-bottom font-semibold">Engineer</th>
                <th rowSpan={2} className={clsx(TH, 'border-b border-ink-200 align-bottom')}>Total</th>
                <th rowSpan={2} className={clsx(TH, 'border-b border-ink-200 align-bottom')}>Open</th>
                {(['A', 'B', 'C'] as const).map(c => (
                  <th key={c} colSpan={2} className="border-l border-ink-200 px-3 pt-2 text-center font-semibold">
                    <span className={clsx('inline-block min-w-5 rounded px-1 py-px text-center text-[11px] font-bold normal-case', CATEGORY_CLASS[c])}>{c}</span>
                  </th>
                ))}
              </tr>
              <tr className="border-b border-ink-200 text-[11px] font-semibold uppercase tracking-label text-ink-400">
                {(['A', 'B', 'C'] as const).flatMap(c => [
                  <th key={`${c}-t`} className={clsx(TH, 'border-l border-ink-200')}>Total</th>,
                  <th key={`${c}-o`} className={TH}>Open</th>,
                ])}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {shown.map(r => (
                <tr key={r.id} className="hover:bg-ink-50">
                  <td className="px-4 py-2.5">
                    <Link to={`/tickets?eng=${r.id}`} className="font-medium text-ink-900 hover:underline">{r.name}</Link>
                  </td>
                  <td className="px-3 py-2.5 text-right"><Count n={r.total} strong /></td>
                  <td className="px-3 py-2.5 text-right"><Count n={r.open} strong /></td>
                  {(['A', 'B', 'C'] as const).flatMap(c => [
                    <td key={`${c}-t`} className="border-l border-ink-100 px-3 py-2.5 text-right"><Count n={r.byCategory[c].total} /></td>,
                    <td key={`${c}-o`} className="px-3 py-2.5 text-right"><Count n={r.byCategory[c].open} /></td>,
                  ])}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
