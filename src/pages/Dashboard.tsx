import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { AlarmClock, ArrowRight, BellRing, Building2, ChartColumn, HardHat, Inbox, PackagePlus, TrendingUp, Users } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useMembers, useMyTeam, useTickets, useTrcs, useVisibleEvents, type Ticket } from '@/lib/queries'
import { dateTime as dateTimeOf, dayDate } from '@/lib/when'
import {
  REPAIRING, STATUS, STATUS_ORDER, TONE_DOT, TONE_FILL, TONE_TEXT, canRaise, itemsSummary, statusGroups, ticketTabs, waitingOnMe,
} from '@/lib/tickets'
import { formatSpan, ticketTat, type TatEvent } from '@/lib/tat'
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
/** Revive Lab has been in use since 26 September 2026; the trend starts there (the user, 29 Sep). */
const TREND_START = new Date(2026, 8, 26)

type TrendBy = 'day' | 'week' | 'month' | 'year'
const TREND_BY: ReadonlyArray<{ id: TrendBy; label: string; each: string }> = [
  { id: 'day', label: 'Day', each: 'day' },
  { id: 'week', label: 'Week', each: 'week' },
  { id: 'month', label: 'Month', each: 'month' },
  { id: 'year', label: 'Year', each: 'year' },
]

/**
 * The stretches the trend is drawn over, oldest first: the last 30 days,
 * the last 12 weeks (Monday to Sunday), the last 12 months, or every year —
 * none before 26 Sep 2026, and the first cut to begin there, so nothing
 * closed before it counts.
 */
function trendBuckets(by: TrendBy, now: Date): Array<{ label: string; from: number; to: number }> {
  const start = TREND_START.getTime()
  const at = (y: number, m: number, d: number) => new Date(y, m, d)
  const dayLabel = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]}`
  const raw: Array<{ from: Date; to: Date; label: (from: Date) => string }> = []
  if (by === 'day') {
    for (let i = 29; i >= 0; i--) {
      const d = at(now.getFullYear(), now.getMonth(), now.getDate() - i)
      raw.push({ from: d, to: at(d.getFullYear(), d.getMonth(), d.getDate() + 1), label: dayLabel })
    }
  } else if (by === 'week') {
    // This week's Monday.
    const monday = at(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7))
    for (let i = 11; i >= 0; i--) {
      const d = at(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7 * i)
      raw.push({ from: d, to: at(d.getFullYear(), d.getMonth(), d.getDate() + 7), label: dayLabel })
    }
  } else if (by === 'month') {
    // "Sep 2026", in full: "Sep 26" read as the 26th.
    for (let i = 11; i >= 0; i--) {
      const d = at(now.getFullYear(), now.getMonth() - i, 1)
      raw.push({ from: d, to: at(d.getFullYear(), d.getMonth() + 1, 1), label: f => `${MONTHS[f.getMonth()]} ${f.getFullYear()}` })
    }
  } else {
    for (let y = TREND_START.getFullYear(); y <= now.getFullYear(); y++) {
      raw.push({ from: at(y, 0, 1), to: at(y + 1, 0, 1), label: f => String(f.getFullYear()) })
    }
  }
  return raw
    .filter(b => b.to.getTime() > start)
    .map(b => {
      const from = b.from.getTime() < start ? TREND_START : b.from
      return { label: b.label(from), from: from.getTime(), to: b.to.getTime() }
    })
}

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
  // The TAT trend by the day, week, month or year tickets closed in (the user, 29 Sep).
  const [trendBy, setTrendBy] = useState<TrendBy>('month')

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
      By the day, week, month or year each ticket closed in, as chosen on
      the card (the user, 29 Sep) — from September 2026, when Revive Lab
      went live ("start tat trend from sep 26"), to now.
    */
    const trend = trendBuckets(trendBy, now).map(({ label, from, to }) => {
      const inMonth = closed.filter(t => {
        const c = Date.parse(t.closed_at!)
        return c >= from && c < to
      })
      const avg = (pick: 'total' | 'repair' | 'reach') => {
        const vals = inMonth.map(t => tatOf(t.id, t.trc_id)[pick].ms).filter((v): v is number => v !== null)
        // Days, unrounded: a label under a day reads in hours, and 0.1 of a day hid which (the user, 29 Sep).
        return vals.length ? Math.round((vals.reduce((a, v) => a + v, 0) / vals.length / 86_400_000) * 1000) / 1000 : null
      }
      return {
        month: label,
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
  }, [tickets, events, trcs, me, period, trendBy])

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
                {statusGroups(stats.mine).map(g => ({ ...g, rows: longestWaitFirst(g.rows) })).map(g => (
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
                            {/* From the right, each the same width on every row: the days, the
                                Revive Lab, then category and criticality — so each makes a column. */}
                            <ClassTag ticket={t} column />
                            <span className="truncate text-xs text-ink-400 sm:w-32 sm:shrink-0 sm:text-right" title={t.trc_name}>{t.trc_name}</span>
                            <WaitedFor ticket={t} />
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
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2.5 text-sm font-semibold text-ink-800">
                <IconChip icon={TrendingUp} tone="indigo" /> TAT trend
              </h3>
              <div className="inline-flex rounded-lg border border-ink-200 bg-ink-50 p-0.5" role="radiogroup" aria-label="Trend by">
                {TREND_BY.map(b => (
                  <button
                    key={b.id}
                    type="button"
                    role="radio"
                    aria-checked={trendBy === b.id}
                    onClick={() => setTrendBy(b.id)}
                    className={clsx('rounded-md px-3 py-1 text-xs font-medium transition-colors',
                      trendBy === b.id ? 'bg-surface text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-800')}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="mb-3 text-xs text-ink-500">
              Average days, for tickets closed in each {TREND_BY.find(b => b.id === trendBy)!.each}: end to end, repair time with the Revive Lab engineer, and time to reach the Revive Lab — since 26 Sep 2026, when Revive Lab came into use.
            </p>
            <TrendChart data={stats.trend} />
          </div>
        </>
      )}
    </div>
  )
}

/** The three lines, in the order their labels win a place. Teal, not near-black: that was invisible on the dark theme. */
const TREND_LINES = [
  { key: 'End to end', color: '#0d9488' },
  { key: 'Repair', color: '#4f46e5' },
  { key: 'Reach Revive Lab', color: '#d97706' },
] as const

type TrendPoint = Record<string, string | number | null>

/**
 * The axis: four even steps to a top a quarter above the highest point, so
 * the highest label has room and the ticks read 0, 2, 4, 6, 8 — not 0, 2, 5.
 */
function trendAxis(data: readonly TrendPoint[]): { top: number; ticks: number[] } {
  const max = Math.max(0, ...data.flatMap(d => TREND_LINES.map(l => d[l.key])).filter((v): v is number => typeof v === 'number'))
  const want = Math.max(max * 1.25, 0.4)
  const step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100].find(s => s * 4 >= want) ?? Math.ceil(want / 4)
  return { top: step * 4, ticks: [0, 1, 2, 3, 4].map(i => Math.round(i * step * 100) / 100) }
}

/**
 * Which points carry their value (the user, 29 Sep: "show data labels
 * beautifully also, but if congested dont show … in mobile we dont need").
 * None on a phone. Otherwise each label is placed where it would sit —
 * above its point, in the chart's own geometry — and kept only if it
 * touches no label already placed and no point: End to end first, then
 * repair, then reaching the Revive Lab.
 */
function trendLabels(data: readonly TrendPoint[], width: number, top: number): Set<string> {
  const show = new Set<string>()
  if (width < 640 || data.length === 0) return show
  // The LineChart's layout: 50px of axis on the left, 16 on the right; 190px of plot under a 5px margin.
  const x0 = 50
  const plotW = width - x0 - 16
  const plotH = 190
  const xAt = (i: number) => x0 + (data.length === 1 ? plotW / 2 : (i * plotW) / (data.length - 1))
  const yAt = (v: number) => 5 + plotH * (1 - v / top)
  type Box = { l: number; r: number; t: number; b: number }
  const placed: Box[] = []
  // Every point is somewhere a label may not cover.
  for (const line of TREND_LINES) {
    data.forEach((d, i) => {
      const v = d[line.key]
      if (typeof v === 'number') placed.push({ l: xAt(i) - 4, r: xAt(i) + 4, t: yAt(v) - 4, b: yAt(v) + 4 })
    })
  }
  for (const line of TREND_LINES) {
    data.forEach((d, i) => {
      const v = d[line.key]
      if (typeof v !== 'number') return
      const w = labelWidth(v)
      const box = { l: xAt(i) - w / 2, r: xAt(i) + w / 2, t: yAt(v) - 26, b: yAt(v) - 10 }
      if (box.t < 0 || placed.some(p => box.l < p.r + 2 && box.r > p.l - 2 && box.t < p.b + 2 && box.b > p.t - 2)) return
      placed.push(box)
      show.add(`${line.key}:${i}`)
    })
  }
  return show
}

/** 1.2d; under a day in hours, 10h; under an hour, <1h (the user, 29 Sep: "if less that day can we show as hours?"). */
const spanLabel = (days: number): string =>
  days >= 1 ? `${Math.round(days * 10) / 10}d` : days * 24 >= 1 ? `${Math.round(days * 24)}h` : '<1h'

/** The same, in words, for the tooltip. */
const spanWords = (days: number): string =>
  days >= 1 ? `${Math.round(days * 10) / 10} days` : days * 24 >= 1 ? `${Math.round(days * 24)} hours` : 'under an hour'

const labelWidth = (v: number) => 10 + 6 * spanLabel(v).length

/** The value above its point, in a pill of its line's colour. */
function TrendLabel({ x, y, value, index, name, color, show }: {
  x?: number | string; y?: number | string; value?: unknown; index?: number; name: string; color: string; show: Set<string>
}) {
  if (typeof value !== 'number' || typeof x !== 'number' || typeof y !== 'number' || !show.has(`${name}:${index}`)) return null
  const w = labelWidth(value)
  return (
    <g pointerEvents="none">
      <rect x={x - w / 2} y={y - 26} width={w} height={16} rx={8} fill={color} fillOpacity={0.16} stroke={color} strokeOpacity={0.45} />
      <text x={x} y={y - 14.5} textAnchor="middle" fontSize={10.5} fontWeight={600} fill={color}>{spanLabel(value)}</text>
    </g>
  )
}

/** The chart's width as it is drawn, for placing labels. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

function TrendChart({ data }: { data: TrendPoint[] }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const { top, ticks } = useMemo(() => trendAxis(data), [data])
  const show = useMemo(() => trendLabels(data, width, top), [data, width, top])
  return (
    <div ref={ref} className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ left: -10, right: 16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eceef2" vertical={false} />
          <XAxis dataKey="month" tick={TICK} />
          <YAxis tick={TICK} domain={[0, top]} ticks={ticks} />
          <Tooltip
            contentStyle={TOOLTIP}
            formatter={(v: unknown) => (typeof v === 'number' ? spanWords(v) : '—')}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {TREND_LINES.map(l => (
            <Line key={l.key} type="monotone" dataKey={l.key} stroke={l.color} strokeWidth={2} dot={{ r: 3 }} connectNulls>
              <LabelList dataKey={l.key} content={p => <TrendLabel {...p} name={l.key} color={l.color} show={show} />} />
            </Line>
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

/**
 * What waits on the coordinator, and since when (the user, 29 Sep): a spare
 * pending acceptance from the day it was raised — or sent back, which is
 * when its wait began — and one pending dispatch from the day its repair
 * was closed, "so that he can see easily which is long pending".
 */
function waitingSince(t: Ticket): { label: string; at: string } | null {
  if (t.status === 'pending_acceptance') {
    const back = t.field_returns?.[t.field_returns.length - 1]
    return back ? { label: 'Returned', at: back.at } : { label: 'Raised', at: t.created_at }
  }
  if (t.repaired_at && (t.status === 'repaired' || t.status === 'not_repairable' || t.status === 'service_denied')) {
    return { label: t.status === 'repaired' ? 'Repaired' : 'Repair closed', at: t.repaired_at }
  }
  return null
}

/** Whole days by the calendar, from that day to today: 0 today, 1 yesterday. */
function daysSince(at: string, now = new Date()): number {
  const d = new Date(at)
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  return Math.round((day(now) - day(d)) / 86_400_000)
}

/**
 * Within a group: hospitals' spares before warehouses' — a warehouse's is
 * the least urgent (the user, 29 Sep) — and in each, the one waiting
 * longest first; one without a date after them.
 */
function longestWaitFirst<T extends Ticket>(rows: readonly T[]): T[] {
  const at = (t: T) => { const s = waitingSince(t); return s ? Date.parse(s.at) : Infinity }
  const last = (t: T) => (t.source === 'warehouse' ? 1 : 0)
  return [...rows].sort((a, b) => last(a) - last(b) || at(a) - at(b))
}

/**
 * "Raised 12 Sept 2026 · 17 days": the day it started waiting, and how many
 * days that is — last on the row and the same width on every row, so the
 * days make one column down the card (the user, 29 Sep: "misaligned").
 */
function WaitedFor({ ticket: t }: { ticket: Ticket }) {
  const since = waitingSince(t)
  if (!since) return null
  const days = daysSince(since.at)
  return (
    <span
      className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap text-xs text-ink-500 sm:w-60"
      title={`${since.label} ${dateTimeOf(since.at)}`}
    >
      <span>{since.label} {dayDate(since.at)}</span>
      <span className={clsx('w-16 shrink-0 rounded-full py-0.5 text-center font-semibold tabular-nums',
        days > 0 ? 'bg-ink-100 text-ink-900' : 'bg-ink-50 text-ink-500')}>
        {days === 0 ? 'today' : `${days} ${days === 1 ? 'day' : 'days'}`}
      </span>
    </span>
  )
}

/**
 * A, B and C against their time — from the coordinator's acceptance until
 * the Revive Lab engineer closes the repair (rl_0030). What the Revive Lab
 * has now, repaired or not: in TAT and above it, as counts and as a share.
 */
function CategoryTat({ rows }: { rows: CategoryRow[] }) {
  return (
    <div className="card p-4">
      <h3 className="mb-1 flex items-center gap-2.5 text-sm font-semibold text-ink-800">
        <IconChip icon={AlarmClock} tone="red" /> TAT by category
      </h3>
      <p className="mb-3 text-xs text-ink-500">
        Each category has its own repair time, from the coordinator's acceptance until the Revive Lab engineer
        closes the repair: A 3 days, B 2, C 1. In TAT is inside it; above TAT is past it. Waiting for dispatch after
        the repair does not count.
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
              {/* Each column stands on its number: a label that wraps on a
                  narrow card grows upward, and the three numbers stay level. */}
              <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="flex flex-col justify-end">
                  <dt className="text-[11px] leading-tight text-ink-500">At the Revive Lab</dt>
                  <dd className="text-lg font-semibold tabular-nums text-ink-900">{r.atLab}</dd>
                </div>
                <div className="flex flex-col justify-end">
                  <dt className="text-[11px] leading-tight text-ink-500">In TAT</dt>
                  <dd className={clsx('text-lg font-semibold tabular-nums', r.inTat ? 'text-green-700' : 'text-ink-300')}>{r.inTat}</dd>
                </div>
                <div className="flex flex-col justify-end">
                  <dt className="text-[11px] leading-tight text-ink-500">Above TAT</dt>
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
