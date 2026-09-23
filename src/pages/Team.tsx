import { useMemo, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { ChevronRight, Clock3, Route, Search, Users } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useMyTeam, useTickets, type Ticket } from '@/lib/queries'
import { TONE_DOT, TONE_TEXT, parseTicketCode } from '@/lib/tickets'
import {
  STAGES, branchOf, countTickets, headcount, inTeamOf, indexTeam, isLate, nextMove, openFor, ownerOfTicket, pathTo,
  type TeamCounts, type TeamPerson,
} from '@/lib/team'
import { EmptyState, PageLoader, StatTile, StatusBadge } from '@/components/ui'
import IconChip from '@/components/IconChip'
import { ClassTag } from '@/components/Classification'

/**
 * My team: every spare the people under this person have sent to a Revive
 * Lab — everyone below them, not only their own reports (rl_0029; the user,
 * 23 Sep: "engineers are not direct reportees … so how can we make them see
 * the tickets? And a beautiful dashboard with everything explained and brief
 * data").
 *
 * Four numbers, where the spares are, one row per team, and the oldest
 * first with whose move it is. A row opens that team, down to the engineer
 * (`?under=`), and the way back up is the line above the heading.
 */
export default function Team() {
  const { employee } = useAuth()
  const { data: team, isLoading } = useMyTeam()
  const { data: tickets, isLoading: loadingTickets } = useTickets()
  const [params, setParams] = useSearchParams()
  const { search } = useLocation()

  const viewer = employee?.id ?? ''
  const ix = useMemo(() => indexTeam(team), [team])
  const asked = params.get('under')
  const focus = asked && ix.byId.has(asked) ? asked : viewer
  const focused = focus === viewer ? null : ix.byId.get(focus) ?? null

  // The focus's team's tickets, each with the person it counts for.
  const mine = useMemo(() => (tickets ?? []).flatMap(t => {
    const owner = ownerOfTicket(ix, t)
    return owner && inTeamOf(ix, owner, focus, viewer) ? [{ t, owner }] : []
  }), [tickets, ix, focus, viewer])

  const counts = useMemo(() => countTickets(mine.map(x => x.t)), [mine])

  // One row per report of the focus, carrying their whole team; the focus's own spares apart.
  const rows = useMemo(() => {
    const byBranch = new Map<string, Ticket[]>()
    const own: Ticket[] = []
    for (const { t, owner } of mine) {
      if (owner === focus) { own.push(t); continue }
      const b = branchOf(ix, owner, focus)
      if (!b) continue
      const list = byBranch.get(b) ?? []
      list.push(t)
      byBranch.set(b, list)
    }
    const out = (ix.reports.get(focus) ?? [])
      .map(person => ({
        person,
        people: headcount(ix, person.id),
        leads: (ix.reports.get(person.id) ?? []).length > 0,
        counts: countTickets(byBranch.get(person.id) ?? []),
        sent: (byBranch.get(person.id) ?? []).length,
      }))
      // A report with nobody under them and nothing sent is not a team to read about.
      .filter(r => r.sent > 0 || r.people > 0)
      .sort((a, b) => b.counts.open - a.counts.open || b.counts.late - a.counts.late || b.sent - a.sent
        || a.person.name.localeCompare(b.person.name))
    return { out, own }
  }, [mine, ix, focus])

  const oldest = useMemo(() => mine
    .filter(x => x.t.status !== 'closed')
    .sort((a, b) => Date.parse(a.t.created_at) - Date.parse(b.t.created_at))
    .slice(0, 8), [mine])

  if (isLoading || loadingTickets) return <PageLoader />

  const people = headcount(ix, focus)
  const whose = focused ? `${focused.name.split(/\s+/)[0]}'s team` : 'your team'

  if (ix.byId.size === 0) {
    return (
      <EmptyState icon={Users} title="Nobody reports to you">
        My team shows the spares of the people under you, at every level. It fills in for anyone with a team.
      </EmptyState>
    )
  }

  // What a ticket opened from here goes back to: this page, with this team open.
  const back = { to: '/team' + search, label: focused ? `${focused.name}'s team` : 'My team' }

  /** Open a team, or — with nobody — go back to the whole of the viewer's. */
  const go = (id: string | null) => setParams(id ? { under: id } : {})

  const first = (p: TeamPerson) => p.name.split(/\s+/)[0]
  /** Which team, from where the page stands: "team of Abijith A", "reports to you", "Manish's own". */
  const teamOfLabel = (owner: string) => {
    if (owner === focus) return focused ? `${first(focused)}'s own` : 'your own'
    const b = branchOf(ix, owner, focus)
    const p = b ? ix.byId.get(b) : null
    if (!p) return ''
    if (p.id === owner) return focused ? `reports to ${first(focused)}` : 'reports to you'
    return `team of ${p.name}`
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        {/* The way back up, once a team has been opened. */}
        {focused && <TeamPath path={pathTo(ix, focus)} onGo={go} className="mb-1" />}
        <h1 className="text-xl font-semibold text-ink-900">{focused ? `${focused.name}'s team` : 'My team'}</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          {people.toLocaleString('en-IN')} {people === 1 ? 'person' : 'people'} under {focused ? focused.name.split(/\s+/)[0] : 'you'}
          {' · '}{mine.length} {mine.length === 1 ? 'spare' : 'spares'} sent to a Revive Lab
          {counts.closedThisMonth ? ` · ${counts.closedThisMonth} closed this month` : ''}
          {' · '}everyone below, not only direct reports
        </p>
      </div>
      <FindTicket tickets={tickets ?? []} back={back} />
      </div>

      {mine.length === 0 ? (
        <EmptyState icon={Route} title={`Nothing from ${whose} yet`}>
          When somebody in {whose} sends a defective spare to a Revive Lab, it shows here: where it is, whose move
          it is, and whether it is late.
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Open" value={counts.open} sub="sent in, not back with them yet" />
            <StatTile label="Being repaired" value={counts.byStage.repair} sub="with a Revive Lab engineer, or waiting for a component" />
            <StatTile label="Not yet accepted" value={counts.byStage.sent} sub="sent, the Revive Lab has not taken it in" />
            <StatTile
              label="Late"
              value={<span className={counts.late ? 'text-cyrixRed-600' : 'text-green-700'}>{counts.late}</span>}
              sub="past its time: A 3 days, B 2, C 1, from acceptance"
            />
          </div>

          <StageBar counts={counts} />

          <div className="card p-4">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <h3 className="flex items-center gap-2.5 text-sm font-semibold text-ink-800">
                <IconChip icon={Users} tone="violet" /> By team
              </h3>
              {/* The same way back up, where the rows are (the user, 23 Sep: "add this here also, so easily go back"). */}
              {focused && <TeamPath path={pathTo(ix, focus)} onGo={go} />}
            </div>
            <p className="mb-3 text-xs text-ink-500">
              Each of {focused ? `${focused.name.split(/\s+/)[0]}'s` : 'your'} reports, with everyone under them. Open a team to see the
              teams inside it, down to each engineer.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead>
                  <tr className="whitespace-nowrap text-left text-[11px] font-semibold uppercase tracking-label text-ink-400">
                    <th className="py-1.5 pr-3 font-semibold">Team of</th>
                    <th className="px-3 py-1.5 text-right font-semibold" title="People under them, still with the company">People</th>
                    <th className="px-3 py-1.5 text-right font-semibold" title="Spares sent in and not back yet">Open</th>
                    <th className="px-3 py-1.5 text-right font-semibold" title="Past their category's time at the Revive Lab">Late</th>
                    <th className="px-3 py-1.5 font-semibold" title="The spare open longest">Oldest open</th>
                    <th className="py-1.5 pl-3 text-right font-semibold" title="Fitted and closed since the 1st">Closed this month</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {rows.out.map(r => (
                    <TeamRow
                      key={r.person.id}
                      person={r.person}
                      people={r.people}
                      counts={r.counts}
                      onOpen={r.leads ? () => go(r.person.id) : null}
                    />
                  ))}
                  {rows.own.length > 0 && (
                    <TeamRow
                      person={focused ?? { id: viewer, name: 'Your own', ecode: '', designation: null, manager_id: null, active: true }}
                      label={focused ? `${focused.name}'s own spares` : 'Your own spares'}
                      people={null}
                      counts={countTickets(rows.own)}
                      onOpen={null}
                    />
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="border-b border-ink-200 bg-ink-50 px-4 py-2.5">
              <h3 className="flex items-center gap-2.5 text-sm font-semibold text-ink-800">
                <IconChip icon={Clock3} tone="amber" /> Open longest
              </h3>
              <p className="mt-1 text-xs text-ink-500">The oldest open spares first, where each is, and whose move it is now.</p>
            </div>
            {oldest.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-400">Nothing open. Everything {whose} sent in is closed.</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {oldest.map(({ t, owner }) => (
                  <li key={t.id}>
                    <Link to={`/tickets/${t.code}`} state={{ back }} className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-ink-50 sm:grid-cols-[5rem_minmax(0,1.3fr)_auto_minmax(0,1.4fr)_auto]">
                      <span className="font-mono text-sm font-semibold text-ink-900">{t.code}</span>
                      <span className="min-w-0 truncate text-sm text-ink-800">
                        {t.stakeholder_name}
                        <span className="text-ink-400"> · {teamOfLabel(owner)}</span>
                      </span>
                      <span className="col-span-2 flex flex-wrap items-center gap-1.5 sm:col-span-1">
                        <StatusBadge status={t.status} closure={t.closure} proposal={t.proposal} />
                        <ClassTag ticket={t} />
                      </span>
                      <span className={clsx('col-span-2 min-w-0 truncate text-xs sm:col-span-1', isLate(t) ? 'font-medium text-cyrixRed-700' : 'text-ink-500')}>
                        {nextMove(t)}
                      </span>
                      <span className="hidden text-right text-xs tabular-nums text-ink-400 sm:block" title="Open for">{openFor(t)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Straight to a ticket from its number (RL-17) or the Ticket ID on the route
 * card (the user, 23 Sep: "can they check a ticket if they get ticket id?").
 * Among every ticket this person can see: theirs, their team's at any depth,
 * their Revive Lab's. A Ticket ID on more than one ticket lists them all.
 */
function FindTicket({ tickets, back }: { tickets: readonly Ticket[]; back: { to: string; label: string } }) {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [missed, setMissed] = useState<string | null>(null)
  const find = (e: FormEvent) => {
    e.preventDefault()
    const text = q.trim()
    if (!text) return
    const n = parseTicketCode(text)
    const byNumber = n === null ? undefined : tickets.find(t => t.number === n)
    if (byNumber) { navigate(`/tickets/${byNumber.code}`, { state: { back } }); return }
    const byId = tickets.filter(t => (t.source_ticket_no ?? '').trim().toLowerCase() === text.toLowerCase())
    if (byId.length === 1) { navigate(`/tickets/${byId[0].code}`, { state: { back } }); return }
    if (byId.length > 1) { navigate(`/tickets?q=${encodeURIComponent(text)}`); return }
    setMissed(text)
  }
  return (
    <form onSubmit={find} className="w-full sm:w-auto">
      <div className="flex gap-2">
        <label className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input
            className="input !py-1.5 !pl-8"
            placeholder="Find a ticket: RL-17 or Ticket ID"
            value={q}
            onChange={e => { setQ(e.target.value); setMissed(null) }}
            aria-label="Find a ticket by its RL number or Ticket ID"
          />
        </label>
        <button type="submit" className="btn-secondary !py-1.5 text-sm">Open</button>
      </div>
      {missed && (
        <p className="mt-1 max-w-80 text-xs text-cyrixRed-700" role="alert">
          No ticket “{missed}” among the ones you can see — yours, your team’s and your Revive Lab’s.
        </p>
      )}
    </form>
  )
}

/** "My team › Abijith A › Lislal M": each step but the last goes back to that team. */
function TeamPath({ path, onGo, className }: {
  path: TeamPerson[]
  onGo: (id: string | null) => void
  className?: string
}) {
  return (
    <nav aria-label="Teams" className={clsx('flex flex-wrap items-center gap-1 text-sm text-ink-500', className)}>
      <button type="button" className="link-accent" onClick={() => onGo(null)}>My team</button>
      {path.map((p, i) => (
        <span key={p.id} className="inline-flex items-center gap-1">
          <ChevronRight aria-hidden className="h-3.5 w-3.5 text-ink-300" />
          {i === path.length - 1
            ? <span className="font-medium text-ink-800">{p.name}</span>
            : <button type="button" className="link-accent" onClick={() => onGo(p.id)}>{p.name}</button>}
        </span>
      ))}
    </nav>
  )
}

/** One team: its head, how many people, open, late, the oldest open, closed this month. */
function TeamRow({ person, label, people, counts, onOpen }: {
  person: TeamPerson
  label?: string
  people: number | null
  counts: TeamCounts
  onOpen: (() => void) | null
}) {
  const name = (
    <span className="min-w-0">
      <span className="block truncate font-medium text-ink-900">{label ?? person.name}</span>
      {!label && person.designation && <span className="block truncate text-xs text-ink-400">{person.designation}</span>}
    </span>
  )
  return (
    <tr className={clsx(onOpen && 'cursor-pointer hover:bg-ink-50')} onClick={onOpen ?? undefined}>
      <td className="py-2 pr-3">
        {onOpen ? (
          <button type="button" className="flex w-full items-center gap-1.5 text-left" onClick={e => { e.stopPropagation(); onOpen() }}>
            {name}
            <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-ink-300" />
          </button>
        ) : name}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-ink-500">{people === null ? '' : people.toLocaleString('en-IN')}</td>
      <td className="px-3 py-2 text-right font-semibold tabular-nums text-ink-900">{counts.open || <span className="font-normal text-ink-300">0</span>}</td>
      <td className={clsx('px-3 py-2 text-right tabular-nums', counts.late ? 'font-semibold text-cyrixRed-600' : 'text-ink-300')}>{counts.late}</td>
      <td className="px-3 py-2 text-ink-500">
        {counts.oldest ? <><span className="font-mono text-xs text-ink-700">{counts.oldest.code}</span> · {openFor(counts.oldest)}</> : '—'}
      </td>
      <td className="py-2 pl-3 text-right tabular-nums text-ink-500">{counts.closedThisMonth}</td>
    </tr>
  )
}

/**
 * Where the open spares are: one bar, a segment per stage in the order a
 * spare goes through them, in the colours the ticket badges use.
 */
function StageBar({ counts }: { counts: TeamCounts }) {
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-800">Where the {counts.open} open {counts.open === 1 ? 'spare is' : 'spares are'}</h3>
        <p className="text-xs text-ink-400">left to right is the order a spare goes through</p>
      </div>
      {counts.open > 0 && (
        <div className="my-3 flex h-3.5 gap-0.5 overflow-hidden rounded-full" role="img"
             aria-label={STAGES.map(s => `${s.label} ${counts.byStage[s.key]}`).join(', ')}>
          {STAGES.filter(s => counts.byStage[s.key] > 0).map(s => (
            <div key={s.key} className={TONE_DOT[s.tone]} style={{ flexGrow: counts.byStage[s.key] }} title={`${s.label}: ${counts.byStage[s.key]}`} />
          ))}
        </div>
      )}
      <ul className="mt-2 grid gap-x-5 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {STAGES.map(s => {
          const n = counts.byStage[s.key]
          return (
            <li key={s.key} className={clsx('flex items-start gap-2 text-xs', !n && 'opacity-50')}>
              <span aria-hidden className={clsx('mt-1 h-2 w-2 shrink-0 rounded-full', TONE_DOT[s.tone])} />
              <span>
                <span className={clsx('font-semibold', n ? TONE_TEXT[s.tone] : 'text-ink-500')}>{s.label} {n}</span>
                <span className="text-ink-400"> — {s.hint}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
