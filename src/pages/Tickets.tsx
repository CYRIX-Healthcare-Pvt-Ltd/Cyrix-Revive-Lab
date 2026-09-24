import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { ArrowDownUp, Download, Inbox, PackagePlus, Search } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useMyTeam, useTickets, type Ticket } from '@/lib/queries'
import { branchOf, indexTeam, ownerOfTicket } from '@/lib/team'
import {
  STATUS, STATUS_ORDER, TONE_CLASS, TONE_DOT, TONE_TEXT, canRaise, itemsSummary, parseTicketCode, statusGroups, ticketTabs,
  type TabId, type TicketStatus, type Tone,
} from '@/lib/tickets'
import { EmptyState, PageLoader, ReturnedTag, SectorTag, SortHeader, Spinner, StatusBadge, TransferTag, WarehouseChip } from '@/components/ui'
import { ticketFileName, ticketWorkbook } from '@/lib/ticketSheet'
import { ClassTag } from '@/components/Classification'
import { clockTime, dayDate } from '@/lib/when'

type SortKey = 'code' | 'raised' | 'status' | 'category' | 'hospital' | 'spare' | 'trc' | 'field' | 'team' | 'engineer' | 'age'

const COLUMN: Record<SortKey, string> = {
  code: 'Ticket', raised: 'Raised', status: 'Status', category: 'Category', hospital: 'Hospital', spare: 'Spare',
  trc: 'Revive Lab', field: 'Field engineer', team: 'Team of', engineer: 'Revive Lab engineer', age: 'Age',
}

/** A column's first click: dates newest first, ages longest first, words A to Z. */
const FIRST_ASC: Record<SortKey, boolean> = {
  code: false, raised: false, age: false,
  status: true, category: true, hospital: true, spare: true, trc: true, field: true, team: true, engineer: true,
}

/** On a phone there are no column headings to click, so the orders are named. */
const PHONE_SORTS: Array<{ key: SortKey; asc: boolean; label: string }> = [
  { key: 'raised', asc: false, label: 'Newest first' },
  { key: 'raised', asc: true, label: 'Oldest first' },
  { key: 'status', asc: true, label: 'Status' },
  { key: 'category', asc: true, label: 'Category' },
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

/**
 * "17 Sep 2026" and "11:53 AM", apart — always with the year, so a list that
 * runs into January never leaves anyone guessing which one, and always AM or
 * PM, whatever the device's clock (lib/when).
 */
function raisedOn(iso: string): { date: string; time: string } {
  return { date: dayDate(iso), time: clockTime(iso) }
}

/** A filter's choice, and how many tickets it would show. */
interface Facet { value: string; label: string; n: number }

function sortValue(key: SortKey, t: Ticket, team: string | null): string | number | null {
  switch (key) {
    case 'code': return t.number
    case 'raised': return Date.parse(t.created_at)
    case 'status': return STATUS[t.status]?.order ?? 99
    // A before B before C, and within a category the critical ones first.
    case 'category': return t.spare_category ? `${t.spare_category}${t.criticality === 'critical' ? 0 : 1}` : null
    case 'hospital': return t.facility
    case 'spare': return itemsSummary(t)
    case 'trc': return t.trc_name
    case 'field': return t.stakeholder_name
    case 'team': return team
    case 'engineer': return t.engineer_name
    case 'age': return ageMs(t)
  }
}

const text = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

export default function Tickets() {
  const { me, employee } = useAuth()
  const navigate = useNavigate()
  const { search } = useLocation()
  const [params, setParams] = useSearchParams()
  const { data: tickets, isLoading } = useTickets()

  /*
    Which of this person's teams each ticket is from — the report of theirs it
    sits under, at any depth (rl_0029). Only for somebody with a team, and the
    column and filter only once the list holds one of their team's tickets.
  */
  const { data: myTeam } = useMyTeam()
  const teamOf = useMemo(() => {
    const ix = indexTeam(myTeam)
    const viewer = employee?.id ?? ''
    return (t: Ticket): { id: string; name: string } | null => {
      const owner = ownerOfTicket(ix, t)
      const b = owner ? branchOf(ix, owner, viewer) : null
      const p = b ? ix.byId.get(b) : null
      return p ? { id: p.id, name: p.name } : null
    }
  }, [myTeam, employee?.id])
  const showTeam = useMemo(() => (tickets ?? []).some(t => teamOf(t)), [tickets, teamOf])
  // The desk follows its engineers; anybody arriving by a link that names one gets the filter too.
  const desk = !!me && (me.is_coordinator || me.is_manager || me.is_admin)

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
  // A hospital's spares or a warehouse's (rl_0020); asked only once there are any from a warehouse.
  const from = params.get('from') ?? ''
  // The category and the criticality the Revive Lab gave it (rl_0024); 'none' is not classified yet.
  const cat = params.get('cat') ?? ''
  const crit = params.get('crit') ?? ''
  // The report of this person's a ticket's field engineer is under ('none': not their team's), and the Revive Lab engineer.
  const team = params.get('team') ?? ''
  const eng = params.get('eng') ?? ''
  const anyWarehouse = useMemo(() => (tickets ?? []).some(t => t.source === 'warehouse'), [tickets])
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

  // This tab's tickets that pass the search: what every filter chooses among.
  const searched = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const asNumber = parseTicketCode(q)
    let rows = (tickets ?? []).filter(tab.match)
    if (needle) {
      rows = rows.filter(t =>
        (asNumber !== null && t.number === asNumber)
        || [t.code, t.source_ticket_no, t.facility, t.spare_name, t.equipment_name, t.equipment_make, t.equipment_model,
            t.equipment_barcode, t.district, t.state, t.bemmp_code,
            t.stakeholder_name, t.stakeholder_ecode, t.engineer_name, t.in_awb, t.out_awb,
            t.source === 'warehouse' ? 'warehouse' : null,
            // Every spare and accessory, not just the first.
            ...(t.items ?? []).map(i => i.name)]
          .some(v => (v ?? '').toLowerCase().includes(needle)))
    }
    return rows
  }, [tickets, tab, q])

  /*
    The filters offer only what is there, each with how many it would show,
    and each counts what the others already allow — choose a Revive Lab and
    the statuses are that Revive Lab's (the user, 23 Sep: "show only what has
    data, and the dropdowns connected"). A choice that no longer matches
    anything stays offered, at nought, so it can be seen and cleared.
  */
  type Filter = 'lab' | 'status' | 'from' | 'cat' | 'crit' | 'team' | 'eng'
  const passes = (t: Ticket, skip: Filter | null = null) =>
    (skip === 'lab' || !trcId || t.trc_id === trcId)
    && (skip === 'team' || !team || (teamOf(t)?.id ?? 'none') === team)
    && (skip === 'eng' || !eng || (t.engineer_id ?? 'none') === eng)
    && (skip === 'status' || !status || t.status === status)
    && (skip === 'from' || !from || (t.source ?? 'hospital') === from)
    && (skip === 'cat' || !cat || (t.spare_category ?? 'none') === cat)
    && (skip === 'crit' || !crit || (t.criticality ?? 'none') === crit)

  const facets = useMemo(() => {
    const tally = (skip: Filter, key: (t: Ticket) => string, name: (t: Ticket) => string) => {
      const m = new Map<string, Facet>()
      for (const t of searched) {
        if (!passes(t, skip)) continue
        const k = key(t)
        const f = m.get(k) ?? { value: k, label: name(t), n: 0 }
        f.n++
        m.set(k, f)
      }
      return m
    }
    const labs = [...tally('lab', t => t.trc_id, t => t.trc_name).values()].sort((a, b) => text.compare(a.label, b.label))
    const statusMap = tally('status', t => t.status, t => STATUS[t.status]?.short ?? t.status)
    const statuses = STATUS_ORDER.filter(s => statusMap.has(s)).map(s => statusMap.get(s)!)
    const sources = tally('from', t => t.source ?? 'hospital', t => (t.source === 'warehouse' ? 'From warehouses' : 'From hospitals'))
    const cats = tally('cat', t => t.spare_category ?? 'none', t => (t.spare_category ? `Category ${t.spare_category}` : 'No category yet'))
    const crits = tally('crit', t => t.criticality ?? 'none', t => (t.criticality === 'critical' ? 'Critical' : t.criticality === 'non_critical' ? 'Non-critical' : 'Not said yet'))
    const byLabel = (m: Map<string, Facet>) => [...m.values()]
      .sort((a, b) => (a.value === 'none' ? 1 : b.value === 'none' ? -1 : text.compare(a.label, b.label)))
    const teams = byLabel(tally('team', t => teamOf(t)?.id ?? 'none', t => teamOf(t)?.name ?? 'Not from your team'))
    const engineers = byLabel(tally('eng', t => t.engineer_id ?? 'none', t => t.engineer_name ?? 'No engineer yet'))
    const keep = (list: Facet[], value: string, label: string) =>
      value && !list.some(f => f.value === value) ? [...list, { value, label, n: 0 }] : list
    return {
      labs: keep(labs, trcId, 'That Revive Lab'),
      statuses: keep(statuses, status, STATUS[status as TicketStatus]?.short ?? status),
      sources: keep(['hospital', 'warehouse'].filter(s => sources.has(s)).map(s => sources.get(s)!), from,
        from === 'warehouse' ? 'From warehouses' : 'From hospitals'),
      cats: keep(['A', 'B', 'C', 'none'].filter(s => cats.has(s)).map(s => cats.get(s)!), cat,
        cat === 'none' ? 'No category yet' : `Category ${cat}`),
      crits: keep(['critical', 'non_critical', 'none'].filter(s => crits.has(s)).map(s => crits.get(s)!), crit,
        crit === 'critical' ? 'Critical' : crit === 'non_critical' ? 'Non-critical' : 'Not said yet'),
      teams: keep(teams, team, 'That team'),
      engineers: keep(engineers, eng, 'That engineer'),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searched, trcId, status, from, cat, crit, team, eng, teamOf])

  const shown = useMemo(() => {
    const rows = searched.filter(t => passes(t))
    const dir = asc ? 1 : -1
    return [...rows].sort((a, b) => {
      const x = sortValue(sortKey, a, teamOf(a)?.name ?? null), y = sortValue(sortKey, b, teamOf(b)?.name ?? null)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searched, trcId, status, from, cat, crit, team, eng, sortKey, asc, teamOf])

  // What waits on this person, in groups by where each spare stands — the
  // same groups as the dashboard's card. Every other tab is one list.
  const grouped = view === 'mine'
  const groups: Array<{ key: string; label: string; tone: Tone; rows: Ticket[] }> = grouped
    ? statusGroups(shown)
    : [{ key: 'all', label: '', tone: 'slate', rows: shown }]

  // The phone's order, named; one set by a column heading on a wider
  // screen is kept rather than shown as something it is not.
  const phoneSorts = PHONE_SORTS.some(s => s.key === sortKey && s.asc === asc)
    ? PHONE_SORTS
    : [...PHONE_SORTS, { key: sortKey, asc, label: `${COLUMN[sortKey]}, ${asc ? 'ascending' : 'descending'}` }]

  // Scrolled sideways: the ticket column, which stays put, gets an edge.
  const [slid, setSlid] = useState(false)

  // What the list shows, as an Excel sheet — this tab, these filters, this
  // search, this order (the user, 23 Sep). The library loads on the click.
  const [saving, setSaving] = useState(false)
  const download = async () => {
    setSaving(true)
    try {
      const XLSX = await import('xlsx')
      // In the page's own order: Waiting on you is in its groups.
      XLSX.writeFile(
        ticketWorkbook(XLSX, groups.flatMap(g => g.rows), Date.now(), showTeam ? t => teamOf(t)?.name ?? null : undefined),
        ticketFileName(tab.label),
      )
    } finally {
      setSaving(false)
    }
  }

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
            <select className="input !py-1.5 sm:w-44" value={trcId} onChange={e => setParam('lab', e.target.value || null)} aria-label="Filter by Revive Lab">
              <option value="">All Revive Labs</option>
              {facets.labs.map(f => <option key={f.value} value={f.value}>{f.label} ({f.n})</option>)}
            </select>
            <select className="input !py-1.5 sm:w-44" value={status} onChange={e => setParam('status', e.target.value || null)} aria-label="Filter by status">
              <option value="">Any status</option>
              {facets.statuses.map(f => <option key={f.value} value={f.value}>{f.label} ({f.n})</option>)}
            </select>
            {(anyWarehouse || from) && (
              <select className="input !py-1.5 sm:w-48" value={from} onChange={e => setParam('from', e.target.value || null)} aria-label="Filter by where it came from">
                <option value="">Hospital or warehouse</option>
                {facets.sources.map(f => <option key={f.value} value={f.value}>{f.label} ({f.n})</option>)}
              </select>
            )}
            <select className="input !py-1.5 sm:w-36" value={cat} onChange={e => setParam('cat', e.target.value || null)} aria-label="Filter by category">
              <option value="">Any category</option>
              {facets.cats.map(f => <option key={f.value} value={f.value}>{f.label} ({f.n})</option>)}
            </select>
            <select className="input !py-1.5 sm:w-40" value={crit} onChange={e => setParam('crit', e.target.value || null)} aria-label="Filter by criticality">
              <option value="">Any criticality</option>
              {facets.crits.map(f => <option key={f.value} value={f.value}>{f.label} ({f.n})</option>)}
            </select>
            {(showTeam || team) && (
              <select className="input !py-1.5 sm:w-44" value={team} onChange={e => setParam('team', e.target.value || null)} aria-label="Filter by your team">
                <option value="">All your teams</option>
                {facets.teams.map(f => <option key={f.value} value={f.value}>{f.label} ({f.n})</option>)}
              </select>
            )}
            {(desk || eng) && (
              <select className="input !py-1.5 sm:w-52" value={eng} onChange={e => setParam('eng', e.target.value || null)} aria-label="Filter by Revive Lab engineer">
                <option value="">Any Revive Lab engineer</option>
                {facets.engineers.map(f => <option key={f.value} value={f.value}>{f.label} ({f.n})</option>)}
              </select>
            )}
            {/* The search and Excel as one: when the row runs out of room they move
                down together, and Excel is never left on a line of its own (the
                user, 24 Sep: "move excel button after search"). */}
            <div className="flex min-w-0 flex-1 gap-2 sm:flex-none">
            <label className="relative min-w-0 flex-1 sm:w-52 sm:flex-none">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
              <input
                className="input !py-1.5 !pl-8"
                placeholder="RL-07, SR number, hospital…"
                value={q}
                onChange={e => { setQ(e.target.value); setParam('q', e.target.value || null) }}
                aria-label="Search tickets"
              />
            </label>
            {/* After the search: what the list now shows, as an Excel sheet (the user, 23 Sep). */}
            <button
              type="button"
              className="btn-secondary !py-1.5 text-sm"
              onClick={() => void download()}
              disabled={shown.length === 0 || saving}
              title={shown.length
                ? `The ${shown.length} ticket${shown.length === 1 ? '' : 's'} listed below — this tab, with its filters — in an Excel sheet`
                : 'Nothing listed to download'}
            >
              {saving ? <Spinner className="h-4 w-4" /> : <Download className="h-4 w-4 text-green-600" />} Excel
            </button>
            </div>
          </div>
        </div>

        {shown.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={Inbox}
              title={view === 'parts' ? 'No component is pending' : view === 'mine' ? 'Nothing is waiting on you' : 'No tickets here'}
            >
              {view === 'parts'
                ? 'When a repair is waiting on a component — requested, being purchased, or ready — it shows up here.'
                : view === 'mine'
                  ? 'Whatever needs your move next — to accept, assign, dispatch, confirm — shows up here, in groups.'
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
                    <SortHeader label="Category" col="category" sortKey={sortKey} asc={asc} onSort={onSort} />
                    <SortHeader label={anyWarehouse ? 'Hospital / Warehouse' : 'Hospital'} col="hospital" sortKey={sortKey} asc={asc} onSort={onSort} />
                    <SortHeader label="Spare" col="spare" sortKey={sortKey} asc={asc} onSort={onSort} />
                    <SortHeader label="Revive Lab" col="trc" sortKey={sortKey} asc={asc} onSort={onSort} />
                    <SortHeader label="Field engineer" col="field" sortKey={sortKey} asc={asc} onSort={onSort} />
                    {showTeam && <SortHeader label="Team of" col="team" sortKey={sortKey} asc={asc} onSort={onSort} />}
                    <SortHeader label="Revive Lab engineer" col="engineer" sortKey={sortKey} asc={asc} onSort={onSort} />
                    <SortHeader label="Age" col="age" align="right" sortKey={sortKey} asc={asc} onSort={onSort} />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {groups.map(g => (
                  <Fragment key={g.key}>
                  {grouped && (
                    <tr className="bg-ink-50/70">
                      <td colSpan={showTeam ? 11 : 10} className="px-4 py-1.5">
                        <span className="sticky left-4 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-label">
                          <span aria-hidden className={clsx('h-2 w-2 rounded-full', TONE_DOT[g.tone])} />
                          <span className={TONE_TEXT[g.tone]}>{g.label}</span>
                          <span className="tabular-nums text-ink-400">{g.rows.length}</span>
                        </span>
                      </td>
                    </tr>
                  )}
                  {g.rows.map(t => {
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
                        <td className="px-4 py-3">
                          <StatusBadge status={t.status} closure={t.closure} />
                          <ReturnedTag ticket={t} className="mt-1 flex w-fit" />
                          <TransferTag ticket={t} className="mt-1 flex w-fit" />
                        </td>
                        <td className="px-4 py-3">
                          {t.spare_category || t.criticality
                            ? <ClassTag ticket={t} oneLine />
                            : <span className="text-ink-300">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-ink-900">{t.facility} <SectorTag ticket={t} className="ml-1" /></p>
                          {t.source === 'warehouse'
                            ? <WarehouseChip className="mt-0.5" />
                            : <p className="text-xs text-ink-500">{[t.district, t.bemmp_code].filter(Boolean).join(' · ')}</p>}
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
                        {showTeam && (
                          <td className="px-4 py-3">
                            {teamOf(t) ? <p className="text-ink-700">{teamOf(t)!.name}</p> : <span className="text-ink-300">—</span>}
                          </td>
                        )}
                        <td className="px-4 py-3">
                          {t.engineer_name
                            ? <><p className="text-ink-700">{t.engineer_name}</p><p className="text-xs text-ink-500">{t.engineer_ecode}</p></>
                            : <span className="text-ink-300">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-ink-600">{age(t)}</td>
                      </tr>
                    )
                  })}
                  </Fragment>
                  ))}
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
              {groups.map(g => (
              <Fragment key={g.key}>
              {grouped && (
                <li className="flex items-center gap-2 bg-ink-50/70 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-label">
                  <span aria-hidden className={clsx('h-2 w-2 rounded-full', TONE_DOT[g.tone])} />
                  <span className={TONE_TEXT[g.tone]}>{g.label}</span>
                  <span className="tabular-nums text-ink-400">{g.rows.length}</span>
                </li>
              )}
              {g.rows.map(t => {
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
                        <span className="flex shrink-0 items-center gap-1.5">
                          <ReturnedTag ticket={t} />
                          <TransferTag ticket={t} />
                          <StatusBadge status={t.status} closure={t.closure} />
                        </span>
                      </div>
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="min-w-0 text-sm text-ink-800">
                          {t.facility}
                          <SectorTag ticket={t} className="ml-1.5" />
                          {t.source === 'warehouse' && <WarehouseChip className="ml-1.5 align-middle" />}
                        </p>
                        <p className="shrink-0 text-xs text-ink-500">{raised.date}, {raised.time}</p>
                      </div>
                      {spare && <p className="text-xs text-ink-500">{spare}</p>}
                      <p className="text-xs text-ink-500">
                        {t.trc_name} · {t.stakeholder_name}{teamOf(t) ? ` (team of ${teamOf(t)!.name})` : ''} · {age(t)}
                      </p>
                      <ClassTag ticket={t} className="flex" />
                    </Link>
                  </li>
                )
              })}
              </Fragment>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
