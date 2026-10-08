/**
 * People & Revive Labs — who does what in Revive Lab, and which Revive Labs exist.
 *
 * THIS FILE IS SHARED. The same component is KPI's SW Admin "Revive Lab"
 * tab (src/pages/admin/ReviveLabAccess.tsx there), so it depends on
 * nothing but the Supabase client and the four ui pieces both apps have.
 * Change it in one, copy it to the other.
 *
 * Roles are boxes. A person is any combination of Revive Lab Engineer, Revive Lab
 * Coordinator and Revive Lab Manager, in any number of Revive Labs, and Admin is a box
 * of its own that means "may edit this table" — so "Manager + Admin" is
 * two ticks, not a role somebody had to invent. The database checks every
 * save (revive_save_member): only an admin or the software administrator
 * may change anything, and nobody can untick their own Admin box.
 *
 * A Revive Lab and a BEMMP each belong to a state, or are Regional — every
 * state's. The route card offers a state's own and the Regional ones, and
 * the admins of a Regional Revive Lab approve anything else (rl_0014).
 * Warehouses are a list of the same kind: in a state, or in any (rl_0020).
 */
import { useDeferredValue, useMemo, useState } from 'react'
import clsx from 'clsx'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Hourglass, Layers, Pencil, Plus, RotateCcw, Search, Trash2, UserPlus, Users, Warehouse, X } from 'lucide-react'
import { supabase, friendlyError } from '@/lib/supabase'
import { Alert, EmptyState, Spinner, StatTile } from '@/components/ui'

type TrcKind = 'regional' | 'project'
const KIND_LABEL: Record<TrcKind, string> = { regional: 'Regional Revive Lab', project: 'Project Revive Lab' }

/** No state: Regional, serving every state. */
interface Trc { id: string; name: string; kind: TrcKind; state: string | null; is_active: boolean; sort_order: number }

/**
 * India's states and union territories — the route card's list, spelled the
 * same, because a Revive Lab is matched to a ticket's state by its name.
 * Here rather than imported so this file stays the same in both apps.
 */
const STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam',
  'Bihar', 'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka',
  'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh',
  'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
  'Nagaland', 'Odisha', 'Puducherry', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
  'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
] as const

/** The choice as a select holds it: '' is Regional, '__' not chosen yet. */
const REGIONAL = ''
const UNCHOSEN = '__'
const stateValue = (state: string | null | undefined) => (state === undefined ? UNCHOSEN : state ?? REGIONAL)
const stateFrom = (value: string): string | null | undefined => (value === UNCHOSEN ? undefined : value || null)

function StateSelect({ value, onChange, className, every = 'Regional — every state', ask = 'State or Regional…' }: {
  value: string | null | undefined
  onChange: (state: string | null | undefined) => void
  className?: string
  /** What no state is called: Regional for a Revive Lab or a BEMMP, any state for a warehouse. */
  every?: string
  ask?: string
}) {
  return (
    <select className={clsx('input', className)} value={stateValue(value)} onChange={e => onChange(stateFrom(e.target.value))}>
      {value === undefined && <option value={UNCHOSEN}>{ask}</option>}
      <option value={REGIONAL}>{every}</option>
      <optgroup label="One state">
        {STATES.map(x => <option key={x} value={x}>{x}</option>)}
      </optgroup>
    </select>
  )
}
interface Member {
  employee_id: string; ecode: string; full_name: string; designation: string | null
  is_engineer: boolean; is_coordinator: boolean; is_manager: boolean; is_admin: boolean
  trc_ids: string[]; updated_at: string; updated_by_name: string | null
  /** Buys what engineers request as a purchase (rl_0013). */
  is_purchase: boolean
  /** Only watches: the tickets of the Revive Labs ticked, with nothing to press (rl_0039). */
  is_observer?: boolean
  /** An Observer who also raises tickets, as a field engineer does (rl_0040). */
  may_raise?: boolean
}
interface Person { id: string; ecode: string; full_name: string; designation: string | null; department: string | null }

interface Draft {
  employee_id: string; full_name: string; ecode: string
  is_engineer: boolean; is_coordinator: boolean; is_manager: boolean; is_admin: boolean
  is_purchase: boolean
  is_observer: boolean
  may_raise: boolean
  trc_ids: string[]
}

const ROLES: Array<[keyof Pick<Draft, 'is_engineer' | 'is_coordinator' | 'is_manager' | 'is_purchase' | 'is_observer'>, string]> = [
  ['is_engineer', 'Revive Lab Engineer'],
  ['is_coordinator', 'Revive Lab Coordinator'],
  ['is_manager', 'Revive Lab Manager'],
  // Buys the components engineers request as a purchase, for the Revive Labs ticked.
  ['is_purchase', 'Revive Lab Purchase'],
  // Only watches: a dashboard and the tickets of the Revive Labs ticked, and nothing to press (rl_0039).
  ['is_observer', 'Revive Lab Observer'],
]

const call = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw new Error(friendlyError(error))
  return data as T
}

export default function Access() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">People &amp; Revive Labs</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          Who works in Revive Lab, in which Revive Labs, doing what.
        </p>
      </div>
      <ReviveLabAccess />
    </div>
  )
}

type Part = 'people' | 'labs' | 'bemmp' | 'warehouses' | 'limits' | 'reopen' | 'delete' | 'floor'
const PARTS: { id: Part; label: string; sw?: boolean }[] = [
  { id: 'people', label: 'People' },
  { id: 'labs', label: 'Revive Labs' },
  { id: 'bemmp', label: 'BEMMP' },
  { id: 'warehouses', label: 'Warehouses' },
  { id: 'limits', label: 'Close before raising', sw: true },
  { id: 'reopen', label: 'Reopen', sw: true },
  { id: 'delete', label: 'Delete', sw: true },
  { id: 'floor', label: 'Live floor', sw: true },
]

export function ReviveLabAccess() {
  const qc = useQueryClient()
  const { data: me } = useQuery({
    queryKey: ['revive', 'me'],
    queryFn: async () => (await call<Array<{ employee_id: string; is_admin: boolean; is_sw_admin: boolean }>>('revive_me'))[0] ?? null,
  })
  const { data: trcs, isLoading: loadingTrcs } = useQuery({
    queryKey: ['revive', 'trcs'],
    queryFn: async () => {
      const { data, error } = await supabase.from('revive_trcs')
        .select('id, name, kind, state, is_active, sort_order').order('sort_order').order('name')
      if (error) throw new Error(friendlyError(error))
      return data as Trc[]
    },
  })
  const { data: members, isLoading: loadingMembers } = useQuery({
    queryKey: ['revive', 'members'],
    queryFn: () => call<Member[]>('revive_member_list'),
  })

  const saveMember = useMutation({
    mutationFn: (d: Draft) => call('revive_save_member', {
      p_employee_id: d.employee_id,
      p_engineer: d.is_engineer, p_coordinator: d.is_coordinator,
      p_manager: d.is_manager, p_admin: d.is_admin,
      p_trc_ids: d.trc_ids,
      p_purchase: d.is_purchase,
      p_observer: d.is_observer,
      // The Observer's box: it goes when Observer does.
      p_may_raise: d.is_observer && d.may_raise,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['revive'] }),
  })

  const [editing, setEditing] = useState<Draft | null>(null)
  const [adding, setAdding] = useState(false)
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [part, setPart] = useState<Part>('people')

  const canEdit = !!me?.is_admin
  const trcName = useMemo(() => new Map((trcs ?? []).map(t => [t.id, t.name])), [trcs])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const rows = members ?? []
    return needle
      ? rows.filter(m => m.full_name.toLowerCase().includes(needle) || m.ecode.toLowerCase().includes(needle))
      : rows
  }, [members, q])

  const counts = useMemo(() => {
    const rows = members ?? []
    return {
      engineers: rows.filter(m => m.is_engineer).length,
      coordinators: rows.filter(m => m.is_coordinator).length,
      managers: rows.filter(m => m.is_manager).length,
      purchase: rows.filter(m => m.is_purchase).length,
      admins: rows.filter(m => m.is_admin).length,
    }
  }, [members])

  const startEdit = (m: Member) => {
    setError(null); setNotice(null); setAdding(false)
    setEditing({
      employee_id: m.employee_id, full_name: m.full_name, ecode: m.ecode,
      is_engineer: m.is_engineer, is_coordinator: m.is_coordinator, is_manager: m.is_manager,
      is_admin: m.is_admin, is_purchase: m.is_purchase, is_observer: !!m.is_observer, may_raise: !!m.may_raise, trc_ids: [...m.trc_ids],
    })
  }

  const save = async (d: Draft, removing = false) => {
    setError(null); setNotice(null)
    const payload = removing
      ? { ...d, is_engineer: false, is_coordinator: false, is_manager: false, is_admin: false, is_purchase: false, is_observer: false, may_raise: false, trc_ids: [] }
      : d
    try {
      await saveMember.mutateAsync(payload)
      setEditing(null); setAdding(false)
      setNotice(removing ? `${d.full_name} is out of Revive Lab.` : `Saved ${d.full_name}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that.')
    }
  }

  if (loadingTrcs || loadingMembers) {
    return <div className="flex justify-center py-16"><Spinner className="h-6 w-6 text-ink-400" /></div>
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Revive Labs" value={(trcs ?? []).filter(t => t.is_active).length} sub={`${(trcs ?? []).length} in all`} />
        <StatTile label="Revive Lab engineers" value={counts.engineers} />
        <StatTile label="Coordinators" value={counts.coordinators} />
        <StatTile label="Managers" value={counts.managers} />
        <StatTile label="Purchase" value={counts.purchase} />
        <StatTile label="Admins" value={counts.admins} sub="may edit this table" />
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-ink-200">
        {PARTS.filter(t => !t.sw || me?.is_sw_admin).map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setPart(t.id)}
            className={clsx(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
              part === t.id ? 'border-cyrixRed-600 text-ink-900' : 'border-transparent text-ink-400 hover:text-ink-700',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {part === 'people' && error && <Alert kind="error">{error}</Alert>}
      {part === 'people' && notice && <Alert kind="success">{notice}</Alert>}

      {part === 'people' && <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-ink-50 px-3 py-2">
          <h3 className="flex items-center gap-2 px-1 text-sm font-semibold text-ink-800">
            <Users className="h-4 w-4 text-ink-400" /> People
          </h3>
          <label className="relative ml-auto w-full sm:w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
            <input className="input !py-1.5 !pl-8" placeholder="Name or code" value={q} onChange={e => setQ(e.target.value)} />
          </label>
          {canEdit && (
            <button
              type="button"
              className="btn-primary !py-1.5"
              onClick={() => { setAdding(v => !v); setEditing(null); setError(null); setNotice(null) }}
            >
              <UserPlus className="h-4 w-4" /> Add person
            </button>
          )}
        </div>

        {adding && canEdit && (
          <AddPerson
            existing={new Set((members ?? []).map(m => m.employee_id))}
            onPick={p => {
              setAdding(false)
              setEditing({
                employee_id: p.id, full_name: p.full_name, ecode: p.ecode,
                is_engineer: false, is_coordinator: false, is_manager: false, is_admin: false, is_purchase: false, is_observer: false, may_raise: false,
                trc_ids: (trcs ?? []).length === 1 ? [trcs![0].id] : [],
              })
            }}
            onCancel={() => setAdding(false)}
          />
        )}

        {editing && !(members ?? []).some(m => m.employee_id === editing.employee_id) && (
          <div className="border-b border-ink-200 p-3">
            <EditRow draft={editing} trcs={trcs ?? []} busy={saveMember.isPending}
              onChange={setEditing} onSave={() => save(editing)} onCancel={() => setEditing(null)} />
          </div>
        )}

        {shown.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={Users} title={q ? 'Nobody matches that' : 'Nobody is in Revive Lab yet'}>
              {canEdit && !q && 'Add the Revive Lab coordinators first — tickets route to them.'}
            </EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">
                  <th className="px-4 py-2.5 font-medium">Employee</th>
                  <th className="px-4 py-2.5 font-medium">Revive Lab(s)</th>
                  <th className="px-4 py-2.5 font-medium">Role(s)</th>
                  <th className="px-4 py-2.5 font-medium">Admin</th>
                  <th className="px-4 py-2.5 font-medium">Last updated</th>
                  {canEdit && <th className="px-4 py-2.5" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {shown.map(m => editing?.employee_id === m.employee_id ? (
                  <tr key={m.employee_id}>
                    <td colSpan={canEdit ? 6 : 5} className="p-3">
                      <EditRow draft={editing} trcs={trcs ?? []} busy={saveMember.isPending}
                        onChange={setEditing} onSave={() => save(editing)} onCancel={() => setEditing(null)}
                        onRemove={m.employee_id === me?.employee_id ? undefined : () => save(editing, true)} />
                    </td>
                  </tr>
                ) : (
                  <tr key={m.employee_id} className="hover:bg-ink-50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink-900">{m.full_name}</p>
                      <p className="text-xs text-ink-500">{m.ecode}{m.designation ? ` · ${m.designation}` : ''}</p>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {m.trc_ids.length === 0
                          ? <span className="text-ink-300">—</span>
                          : m.trc_ids.map(id => (
                            <span key={id} className="badge bg-ink-100 text-ink-700">{trcName.get(id) ?? '?'}</span>
                          ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {ROLES.filter(([k]) => m[k]).map(([k, label]) => (
                          <span key={k} className="badge bg-sky-100 text-sky-900">{label}</span>
                        ))}
                        {!ROLES.some(([k]) => m[k]) && <span className="text-ink-300">—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {m.is_admin
                        ? <span className="badge bg-cyrixRed-100 text-cyrixRed-800">Admin</span>
                        : <span className="text-ink-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-500">
                      {new Date(m.updated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      {m.updated_by_name && <span className="block text-ink-400">by {m.updated_by_name}</span>}
                    </td>
                    {canEdit && (
                      <td className="px-4 py-3 text-right">
                        <button type="button" className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => startEdit(m)}>
                          <Pencil className="h-3.5 w-3.5" /> Edit
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>}

      {part === 'labs' && <TrcTable trcs={trcs ?? []} canEdit={canEdit} members={members ?? []} />}

      {part === 'bemmp' && <BemmpTable canEdit={canEdit} />}

      {part === 'warehouses' && <WarehouseTable canEdit={canEdit} />}

      {part === 'limits' && me?.is_sw_admin && <CloseLimits />}

      {part === 'reopen' && me?.is_sw_admin && <ReopenTicket />}

      {part === 'delete' && me?.is_sw_admin && <DeleteTicket />}

      {part === 'floor' && me?.is_sw_admin && <LiveFloorRoles />}
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * A BEMMP's project head, by name or E-code (rl_0047; the user, 8 Oct: "type
 * name also in head field? so suggestion comes"). Empty clears it.
 */
function HeadPicker({ value, name, onChange }: {
  value: string
  name: string
  onChange: (ecode: string, name: string) => void
}) {
  const [q, setQ] = useState(name ? `${name} (${value})` : value)
  const [open, setOpen] = useState(false)
  const term = useDeferredValue(q.trim())
  const { data: found } = useQuery({
    enabled: open && term.length >= 2,
    queryKey: ['revive', 'people', term.toLowerCase()],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('revive_find_people', { p_q: term })
      if (error) throw new Error(friendlyError(error))
      return (data ?? []) as { id: string; ecode: string; full_name: string; designation: string | null }[]
    },
  })
  return (
    <span className="relative inline-block">
      <input
        className="input !py-1 w-56"
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true); { const v = e.target.value.trim(); onChange(/^[A-Za-z_]*d+$/.test(v) ? v.toUpperCase() : v ? value : '', '') } }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Project head — name or E-code"
        aria-label="Project head"
      />
      {open && (found ?? []).length > 0 && (
        <span className="absolute left-0 top-full z-20 mt-1 block max-h-60 w-72 overflow-y-auto rounded-lg border border-ink-200 bg-surface py-1 shadow-lg">
          {(found ?? []).slice(0, 8).map(p => (
            <button
              key={p.id}
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { onChange(p.ecode, p.full_name); setQ(`${p.full_name} (${p.ecode})`); setOpen(false) }}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-ink-50"
            >
              <span className="text-ink-900">{p.full_name}</span>
              <span className="text-xs text-ink-500"> · {p.ecode}{p.designation ? ` · ${p.designation}` : ''}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  )
}

/* ------------------------------------------------------------------ */

/**
 * The BEMMP programmes a route card can name — AP, KL, RJ, UP, Pvt …
 *
 * A list rather than free text, so "KL", "Kerala" and "kl bemmp" do not
 * become three programmes in every report. Revive Lab admins and the
 * software administrator add to it; a programme that ends is retired rather
 * than deleted, so the tickets that named it still say so.
 *
 * Each is a state's programme, or Regional — Pvt runs in every state. The
 * route card offers only the chosen state's and the Regional ones.
 */
interface Bemmp {
  id: string; code: string; state: string | null; is_active: boolean; sort_order: number
  /** Approves a move to another state's Revive Lab first (rl_0047). Optional. */
  head_id: string | null
  head: { full_name: string; ecode: string } | null
}

function BemmpTable({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient()
  const { data: rows, isLoading } = useQuery({
    queryKey: ['revive', 'bemmp'],
    queryFn: async () => {
      const { data, error } = await supabase.from('revive_bemmp_projects')
        .select('id, code, state, is_active, sort_order, head_id, head:employees!revive_bemmp_projects_head_id_fkey(full_name, ecode)')
        .order('sort_order').order('code')
      if (error) throw new Error(friendlyError(error))
      return data as unknown as Bemmp[]
    },
  })
  const save = useMutation({
    // No state leaves it as it is: retiring a BEMMP does not change whose it is.
    mutationFn: (b: { id: string | null; code: string; active: boolean; state?: string | null }) =>
      call('revive_save_bemmp', {
        p_id: b.id, p_code: b.code, p_active: b.active,
        p_state: b.state === undefined ? null : b.state ?? 'Regional',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['revive', 'bemmp'] }),
  })
  const [adding, setAdding] = useState('')
  const [addingState, setAddingState] = useState<string | null | undefined>(undefined)
  const [editing, setEditing] = useState<{ id: string; code: string; state: string | null | undefined; head: string; headName: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const setHead = useMutation({
    mutationFn: (h: { id: string; ecode: string }) => call('revive_set_bemmp_head', { p_id: h.id, p_ecode: h.ecode || null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['revive', 'bemmp'] }),
  })

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (addingState === undefined) { setError('Choose its state, or Regional.'); return }
    try { await save.mutateAsync({ id: null, code: adding, active: true, state: addingState }); setAdding(''); setAddingState(undefined) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not add that.') }
  }
  const toggle = async (b: Bemmp) => {
    setError(null)
    try { await save.mutateAsync({ id: b.id, code: b.code, active: !b.is_active }) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not change that.') }
  }
  const saveEdit = async (b: Bemmp) => {
    if (!editing) return
    setError(null)
    try {
      await save.mutateAsync({ id: b.id, code: editing.code, active: b.is_active, state: editing.state })
      if (editing.head.trim().toUpperCase() !== (b.head?.ecode ?? '').toUpperCase()) {
        await setHead.mutateAsync({ id: b.id, ecode: editing.head.trim() })
      }
      setEditing(null)
    }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save that.') }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-ink-50 px-3 py-2">
        <h3 className="flex items-center gap-2 px-1 text-sm font-semibold text-ink-800">
          <Layers className="h-4 w-4 text-ink-400" /> BEMMP
        </h3>
        <span className="text-xs text-ink-400">· the programmes a route card can name</span>
      </div>
      <div className="space-y-3 p-4">
        {error && <Alert kind="error">{error}</Alert>}
        {isLoading ? <Spinner className="h-4 w-4 text-ink-400" /> : (
          <div className="flex flex-wrap gap-2">
            {(rows ?? []).map(b => editing?.id === b.id ? (
              <span key={b.id} className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-ink-300 bg-ink-50 p-1.5">
                <input
                  autoFocus
                  className="input !py-1 w-20"
                  value={editing.code}
                  onChange={e => setEditing({ ...editing, code: e.target.value })}
                  maxLength={20}
                  aria-label="BEMMP code"
                />
                <StateSelect className="!py-1 w-52" value={editing.state} onChange={state => setEditing({ ...editing, state })} />
                <HeadPicker value={editing.head} name={editing.headName} onChange={(head, headName) => setEditing({ ...editing, head, headName })} />
                <button type="button" className="btn-primary !px-3 !py-1 text-xs" onClick={() => void saveEdit(b)}
                  disabled={save.isPending || setHead.isPending || !editing.code.trim() || editing.state === undefined}>
                  {(save.isPending || setHead.isPending) && <Spinner className="h-3.5 w-3.5" />} Save
                </button>
                <button type="button" className="btn-secondary !px-3 !py-1 text-xs" onClick={() => setEditing(null)}>Cancel</button>
              </span>
            ) : (
              <span
                key={b.id}
                className={clsx(
                  'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm',
                  b.is_active ? 'border-ink-200 text-ink-900' : 'border-ink-200 bg-ink-50 text-ink-400',
                )}
              >
                <span className={clsx(!b.is_active && 'line-through')}>{b.code}</span>
                <span className="text-xs text-ink-500">{b.state ?? 'Regional'}</span>
                {b.head && <span className="text-xs text-ink-500">· Head: {b.head.full_name}</span>}
                {canEdit && (
                  <>
                    <button
                      type="button"
                      onClick={() => { setError(null); setEditing({ id: b.id, code: b.code, state: b.state, head: b.head?.ecode ?? '', headName: b.head?.full_name ?? '' }) }}
                      className="text-xs font-medium text-ink-500 hover:text-ink-900"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void toggle(b)}
                      disabled={save.isPending}
                      className="text-xs font-medium text-ink-500 hover:text-ink-900"
                      title={b.is_active ? 'Disable — tickets that name it keep it' : 'Enable'}
                    >
                      {b.is_active ? 'Disable' : 'Enable'}
                    </button>
                  </>
                )}
              </span>
            ))}
          </div>
        )}
        {canEdit && (
          <form onSubmit={add} className="flex flex-wrap items-center gap-2">
            <input
              className="input !py-1.5 w-28"
              value={adding}
              onChange={e => setAdding(e.target.value)}
              placeholder="e.g. TN"
              maxLength={20}
              aria-label="New BEMMP code"
            />
            <StateSelect className="!py-1.5 w-56" value={addingState} onChange={setAddingState} />
            <button type="submit" className="btn-secondary !py-1.5" disabled={save.isPending || !adding.trim() || addingState === undefined}>
              {save.isPending ? <Spinner className="h-4 w-4" /> : <Plus className="h-4 w-4" />} Add BEMMP
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

/**
 * The warehouses a defective spare can come from (rl_0020).
 *
 * A fixed list, like the BEMMPs, so one warehouse is not three spellings in
 * every report. A Revive Lab's coordinator raises a ticket for what a
 * warehouse sends in; the route card offers the warehouses in the state it
 * names, and those in no particular state. One that closes is retired, and
 * the tickets that named it still do.
 */
interface WarehouseRow { id: string; name: string; state: string | null; is_active: boolean; sort_order: number }

function WarehouseTable({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient()
  const { data: rows, isLoading } = useQuery({
    queryKey: ['revive', 'warehouses'],
    queryFn: async () => {
      const { data, error } = await supabase.from('revive_warehouses')
        .select('id, name, state, is_active, sort_order').order('sort_order').order('name')
      if (error) throw new Error(friendlyError(error))
      return data as WarehouseRow[]
    },
  })
  const save = useMutation({
    // No state leaves it as it is: retiring a warehouse does not move it.
    mutationFn: (w: { id: string | null; name: string; active: boolean; state?: string | null }) =>
      call('revive_save_warehouse', {
        p_id: w.id, p_name: w.name, p_active: w.active,
        p_state: w.state === undefined ? null : w.state ?? 'Any',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['revive', 'warehouses'] }),
  })
  const [adding, setAdding] = useState('')
  const [addingState, setAddingState] = useState<string | null | undefined>(undefined)
  const [editing, setEditing] = useState<{ id: string; name: string; state: string | null | undefined } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (addingState === undefined) { setError('Choose its state, or any state.'); return }
    try { await save.mutateAsync({ id: null, name: adding, active: true, state: addingState }); setAdding(''); setAddingState(undefined) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not add that.') }
  }
  const toggle = async (w: WarehouseRow) => {
    setError(null)
    try { await save.mutateAsync({ id: w.id, name: w.name, active: !w.is_active }) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not change that.') }
  }
  const saveEdit = async (w: WarehouseRow) => {
    if (!editing) return
    setError(null)
    try { await save.mutateAsync({ id: w.id, name: editing.name, active: w.is_active, state: editing.state }); setEditing(null) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save that.') }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-ink-50 px-3 py-2">
        <h3 className="flex items-center gap-2 px-1 text-sm font-semibold text-ink-800">
          <Warehouse className="h-4 w-4 text-ink-400" /> Warehouses
        </h3>
        <span className="text-xs text-ink-400">· where a defective spare can come from, besides a hospital</span>
      </div>
      <div className="space-y-3 p-4">
        {error && <Alert kind="error">{error}</Alert>}
        {isLoading ? <Spinner className="h-4 w-4 text-ink-400" /> : (rows ?? []).length === 0 ? (
          <p className="text-sm text-ink-500">
            None yet. {canEdit ? 'Add each warehouse once;' : 'An admin adds each warehouse once;'} a coordinator then chooses it on the route card.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {(rows ?? []).map(w => editing?.id === w.id ? (
              <span key={w.id} className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-ink-300 bg-ink-50 p-1.5">
                <input
                  autoFocus
                  className="input !py-1 w-48"
                  value={editing.name}
                  onChange={e => setEditing({ ...editing, name: e.target.value })}
                  maxLength={80}
                  aria-label="Warehouse name"
                />
                <StateSelect className="!py-1 w-52" value={editing.state} every="Any state" ask="State, or any…"
                  onChange={state => setEditing({ ...editing, state })} />
                <button type="button" className="btn-primary !px-3 !py-1 text-xs" onClick={() => void saveEdit(w)}
                  disabled={save.isPending || editing.name.trim().length < 2 || editing.state === undefined}>
                  {save.isPending && <Spinner className="h-3.5 w-3.5" />} Save
                </button>
                <button type="button" className="btn-secondary !px-3 !py-1 text-xs" onClick={() => setEditing(null)}>Cancel</button>
              </span>
            ) : (
              <span
                key={w.id}
                className={clsx(
                  'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm',
                  w.is_active ? 'border-ink-200 text-ink-900' : 'border-ink-200 bg-ink-50 text-ink-400',
                )}
              >
                <span className={clsx(!w.is_active && 'line-through')}>{w.name}</span>
                <span className="text-xs text-ink-500">{w.state ?? 'Any state'}</span>
                {canEdit && (
                  <>
                    <button
                      type="button"
                      onClick={() => { setError(null); setEditing({ id: w.id, name: w.name, state: w.state }) }}
                      className="text-xs font-medium text-ink-500 hover:text-ink-900"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void toggle(w)}
                      disabled={save.isPending}
                      className="text-xs font-medium text-ink-500 hover:text-ink-900"
                      title={w.is_active ? 'Disable — tickets that name it keep it' : 'Enable'}
                    >
                      {w.is_active ? 'Disable' : 'Enable'}
                    </button>
                  </>
                )}
              </span>
            ))}
          </div>
        )}
        {canEdit && (
          <form onSubmit={add} className="flex flex-wrap items-center gap-2">
            <input
              className="input !py-1.5 w-56"
              value={adding}
              onChange={e => setAdding(e.target.value)}
              placeholder="e.g. Kochi central warehouse"
              maxLength={80}
              aria-label="New warehouse name"
            />
            <StateSelect className="!py-1.5 w-56" value={addingState} onChange={setAddingState} every="Any state" ask="State, or any…" />
            <button type="submit" className="btn-secondary !py-1.5" disabled={save.isPending || adding.trim().length < 2 || addingState === undefined}>
              {save.isPending ? <Spinner className="h-4 w-4" /> : <Plus className="h-4 w-4" />} Add warehouse
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

/** "RL-07", "rl-7", "7" → 7. Anything else → null. */
const ticketNumberOf = (typed: string): number | null => {
  const m = typed.trim().match(/^(?:rl-?)?0*([0-9]{1,7})$/i)
  return m ? Number(m[1]) : null
}

/** "PR-01", "pr1", "PR 01" → 1: a component request for the stock (rl_0044). Anything else → null. */
const prNumberOf = (typed: string): number | null => {
  const m = typed.trim().match(/^pr\s*-?\s*0*([0-9]{1,7})$/i)
  return m ? Number(m[1]) : null
}

/** A ticket's status in words, for this page to say — it has no other file to ask. */
const STATUS_WORDS: Record<string, string> = {
  awaiting_approval: 'waiting for approval', approved: 'approved and not sent yet', not_approved: 'not approved',
  pending_acceptance: 'pending acceptance', transferred: 'on its way to another Revive Lab', accepted: 'accepted, with no engineer yet',
  assigned: 'assigned, the repair not accepted yet', in_repair: 'in repair', parts_requested: 'in repair, waiting for a component',
  parts_ordered: 'in repair, waiting for a component', parts_ready: 'in repair, waiting for a component',
  repaired: 'repaired', not_repairable: 'not repairable', service_denied: 'customer denied service',
  in_transit_return: 'already dispatched', received_back: 'back with the field engineer', closed: 'closed',
}
/** The engineer has closed the repair, and the coordinator has not sent the spare out. */
const REOPENABLE = ['repaired', 'not_repairable', 'service_denied']

/**
 * Close before raising, for the software administrator only (rl_0041).
 *
 * Per state, how many days a spare that came back may wait before its
 * field engineer cannot raise another ticket: in transit back, from the
 * dispatch date until they press Received back; and received back, from
 * that day until they close it, working or not (the user, 3 Oct: "for KL …
 * received back status … 5 days … in transit 7 days"; "admin should able to
 * decide for each state"). Engineers were leaving spares unclosed, and a
 * spare never closed as working can always be blamed on the Revive Lab.
 *
 * The database holds the rule: revive_raise_ticket refuses, and the raise
 * page lists the tickets, each opening its own. A ticket the desk raised in
 * an engineer's name is that engineer's to close too. Each state here shows
 * what it has waiting now, and whom the days typed would hold back today,
 * before they are saved.
 */
interface CloseLimit { state: string; received_back_days: number | null; in_transit_days: number | null }
interface LimitPreview {
  in_transit: number; in_transit_oldest: number | null
  received_back: number; received_back_oldest: number | null
  late_tickets: number; late_people: number
}

function CloseLimits() {
  const { data: rows, isLoading } = useQuery({
    queryKey: ['revive', 'close-limits'],
    queryFn: async () => {
      const { data, error } = await supabase.from('revive_close_limits')
        .select('state, received_back_days, in_transit_days').order('state')
      if (error) throw new Error(friendlyError(error))
      return data as CloseLimit[]
    },
  })
  const [adding, setAdding] = useState<string | null>(null)
  const taken = new Set((rows ?? []).map(r => r.state))

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-ink-50 px-4 py-2.5">
        <Hourglass className="h-4 w-4 text-ink-500" />
        <h3 className="text-sm font-semibold text-ink-800">Close before raising</h3>
        <span className="text-xs text-ink-400">· software administrator only</span>
      </div>
      <div className="space-y-3 p-4">
        <p className="text-sm text-ink-600">
          A field engineer with a spare left longer than this cannot raise a new ticket until they press Received back, or close it.
          Tickets the coordinator raised in their name count too.
        </p>
        <p className="text-xs text-ink-500">
          In transit back counts from the dispatch date, Received back from the day they pressed Received back. Leave a box empty for no limit.
        </p>
        {isLoading ? <Spinner className="h-4 w-4 text-ink-400" /> : (
          <div className="space-y-2.5">
            {(rows ?? []).map(r => <LimitRow key={r.state} row={r} />)}
            {adding && (
              <LimitRow key={`new-${adding}`} row={{ state: adding, received_back_days: null, in_transit_days: null }} fresh onDone={() => setAdding(null)} />
            )}
            {(rows ?? []).length === 0 && !adding && (
              <p className="rounded-xl border border-dashed border-ink-200 px-3 py-3 text-sm text-ink-500">No state has a limit yet, so nobody is held back.</p>
            )}
          </div>
        )}
        {!adding && (
          <select
            className="input !py-1.5 w-60"
            value=""
            aria-label="Add a state"
            onChange={e => { if (e.target.value) setAdding(e.target.value) }}
          >
            <option value="">Add a state…</option>
            {STATES.filter(x => !taken.has(x)).map(x => <option key={x} value={x}>{x}</option>)}
          </select>
        )}
      </div>
    </div>
  )
}

/** One state's two limits: typed, measured against today's spares, then saved. */
function LimitRow({ row, fresh = false, onDone }: { row: CloseLimit; fresh?: boolean; onDone?: () => void }) {
  const qc = useQueryClient()
  const [transit, setTransit] = useState(row.in_transit_days?.toString() ?? '')
  const [back, setBack] = useState(row.received_back_days?.toString() ?? '')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const number = (v: string) => (v.trim() === '' ? null : Number(v))
  const fits = (n: number | null) => n === null || (Number.isInteger(n) && n >= 1 && n <= 90)
  const t = number(transit), b = number(back)
  const valid = fits(t) && fits(b)
  const changed = fresh || t !== row.in_transit_days || b !== row.received_back_days
  // What the days typed would do today. Deferred, so typing 12 does not ask about 1 on the way.
  const laterT = useDeferredValue(t), laterB = useDeferredValue(b)
  const { data: pv } = useQuery({
    queryKey: ['revive', 'close-limit-preview', row.state, laterT, laterB],
    enabled: valid,
    placeholderData: keepPreviousData,
    queryFn: () => call<LimitPreview>('revive_close_limit_preview', { p_state: row.state, p_received_back_days: laterB, p_in_transit_days: laterT }),
  })
  const save = useMutation({
    mutationFn: (v: { t: number | null; b: number | null }) =>
      call<null>('revive_set_close_limit', { p_state: row.state, p_received_back_days: v.b, p_in_transit_days: v.t }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['revive', 'close-limits'] }),
  })
  const store = async (v: { t: number | null; b: number | null }) => {
    setError(null); setNotice(null)
    try { await save.mutateAsync(v); setNotice('Saved.'); onDone?.() }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save that.') }
  }
  const days = (value: string, set: (v: string) => void, label: string) => (
    <label className="flex items-center gap-2 text-sm text-ink-700">
      <span className="w-28 shrink-0">{label}</span>
      <input
        className={clsx('input !w-16 !py-1.5 text-center tabular-nums', !fits(number(value)) && '!border-cyrixRed-400')}
        inputMode="numeric"
        value={value}
        onChange={e => { setNotice(null); set(e.target.value.replace(/[^0-9]/g, '').slice(0, 2)) }}
        placeholder="—"
        aria-label={`${label}, days, ${row.state}`}
      />
      <span className="text-ink-500">days</span>
    </label>
  )

  return (
    <div className="rounded-xl border border-ink-200 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-ink-900">{row.state}</p>
        {fresh ? (
          <button type="button" className="text-xs font-medium text-ink-500 hover:text-ink-900" onClick={onDone}>Cancel</button>
        ) : (
          <button type="button" className="text-xs font-medium text-ink-500 hover:text-ink-900" disabled={save.isPending}
            title="Take this state's limits away: nobody here is held back" onClick={() => void store({ t: null, b: null })}>
            Remove
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-2">
        {days(transit, setTransit, 'In transit back')}
        {days(back, setBack, 'Received back')}
        <button
          type="button"
          className="btn-primary !py-1.5"
          disabled={!changed || !valid || save.isPending || (fresh && t === null && b === null)}
          onClick={() => void store({ t, b })}
        >
          {save.isPending && <Spinner className="h-4 w-4" />} Save
        </button>
      </div>
      {pv && (
        <div className="mt-2.5 space-y-0.5 text-xs">
          <p className="text-ink-500">
            Waiting now: {pv.in_transit} in transit back{pv.in_transit_oldest !== null ? ` (oldest ${pv.in_transit_oldest} days)` : ''}
            {' · '}{pv.received_back} received back{pv.received_back_oldest !== null ? ` (oldest ${pv.received_back_oldest} days)` : ''}
          </p>
          {(t !== null || b !== null) && (
            <p className={clsx('font-medium', pv.late_people ? 'text-amber-700' : 'text-green-700')}>
              {changed ? 'If saved, today' : 'Today'}:{' '}
              {pv.late_people
                ? `${pv.late_people} field engineer${pv.late_people === 1 ? '' : 's'} cannot raise — ${pv.late_tickets} ticket${pv.late_tickets === 1 ? '' : 's'} past the limit`
                : 'nobody is held back'}
            </p>
          )}
        </div>
      )}
      {error && <div className="mt-2"><Alert kind="error">{error}</Alert></div>}
      {notice && !changed && <p className="mt-2 text-xs font-medium text-green-700">{notice}</p>}
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * Reopening a repair, for the software administrator only (rl_0037, rl_0038).
 *
 * A repair the engineer has closed — repaired, not repairable, or denied by
 * the customer — goes back to In repair with the same engineer, while the
 * Revive Lab still has the spare: before the coordinator dispatches it or
 * moves it to scrap. Asked for as deleting a ticket is (the user, 1 Oct:
 * "like delete in admin panel, just need a field to enter ticket id"): type
 * the number, and the ticket is named back before anything happens. The
 * database refuses anybody else (revive_reopen_repair), and the ticket's
 * history keeps the step.
 */
function ReopenTicket() {
  const qc = useQueryClient()
  const [typed, setTyped] = useState('')
  const [found, setFound] = useState<{ id: string; code: string; facility: string; status: string; engineer: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const number = ticketNumberOf(typed)

  const lookUp = async () => {
    setError(null); setNotice(null); setFound(null)
    if (!number) { setError('Type a ticket number, like RL-05.'); return }
    setBusy(true)
    try {
      const { data, error: err } = await supabase.from('revive_tickets')
        .select('id, code, facility, status, engineer_id').eq('number', number).maybeSingle()
      if (err) { setError(friendlyError(err)); return }
      const t = data as { id: string; code: string; facility: string; status: string; engineer_id: string | null } | null
      if (!t) { setError(`There is no ticket RL-${number < 10 ? '0' : ''}${number}.`); return }
      if (!REOPENABLE.includes(t.status)) {
        setError(`${t.code} is ${STATUS_WORDS[t.status] ?? t.status}. Only a repair the engineer has closed, and the coordinator has not yet dispatched or scrapped, can be reopened.`)
        return
      }
      // Whose repair it goes back to, by name.
      const { data: who } = t.engineer_id
        ? await supabase.from('employees').select('full_name').eq('id', t.engineer_id).maybeSingle()
        : { data: null }
      setFound({ id: t.id, code: t.code, facility: t.facility, status: t.status, engineer: (who as { full_name: string } | null)?.full_name ?? null })
    } finally {
      setBusy(false)
    }
  }

  const reopen = async () => {
    if (!found) return
    setBusy(true); setError(null)
    try {
      await call<null>('revive_reopen_repair', { p_ticket_id: found.id })
      setNotice(`Reopened ${found.code}. It is back in repair${found.engineer ? ` with ${found.engineer}` : ''}.`)
      setFound(null); setTyped('')
      qc.invalidateQueries({ queryKey: ['revive'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reopen that ticket.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-ink-200 bg-ink-50 px-4 py-2.5">
        <RotateCcw className="h-4 w-4 text-ink-500" />
        <h3 className="text-sm font-semibold text-ink-800">Reopen a ticket</h3>
        <span className="text-xs text-ink-400">· software administrator only</span>
      </div>
      <div className="space-y-3 p-4">
        {error && <Alert kind="error">{error}</Alert>}
        {notice && <Alert kind="success">{notice}</Alert>}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={e => { e.preventDefault(); void lookUp() }}
        >
          <label className="block w-40">
            <span className="label">Ticket number</span>
            <input
              className="input mt-1 font-mono"
              value={typed}
              onChange={e => { setTyped(e.target.value); setFound(null) }}
              placeholder="RL-05"
            />
          </label>
          <button type="submit" className="btn-secondary" disabled={busy || !typed.trim()}>
            {busy && !found ? <Spinner className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />} Reopen
          </button>
        </form>

        {found && (
          <div className="rounded-xl border border-ink-200 bg-ink-50 p-3">
            <p className="text-sm font-medium text-ink-900">
              Reopen {found.code} · {found.facility}?
            </p>
            <p className="mt-0.5 text-xs text-ink-600">
              It was closed as {STATUS_WORDS[found.status]}. It goes back to In repair{found.engineer ? <> with {found.engineer}</> : null}, to be closed again.
            </p>
            <div className="mt-2 flex gap-2">
              <button type="button" className="btn-primary" onClick={reopen} disabled={busy}>
                {busy && <Spinner className="h-4 w-4" />} Yes, reopen {found.code}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setFound(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Deleting a ticket, or a component request for the stock, for the software
 * administrator only.
 *
 * For clearing out test tickets: type the number, press Delete, and the
 * ticket is named back before anything happens — a typed "RL-15" for
 * "RL-51" should cost a second look, not a real ticket. The database
 * refuses anybody else (revive_delete_ticket), keeps one audit line of
 * what went, and restarts numbering at RL-01 once no tickets are left.
 *
 * The same field takes a component request's number, PR-01 on (rl_0044;
 * the user, 7 Oct: "same field enough bcz this rqst series will be PR-01"):
 * revive_delete_part_request, with its own audit line, and PR numbering
 * starts again at PR-01 once none are left. What it added to stock stays.
 */
/**
 * Which roles get the dashboard's Overview / Live floor switch (the user,
 * 9 Oct: "add option in sw_admin, ie animation enable disable for roles ...
 * check box"). The software administrator always has it; nothing saved yet
 * means every role (rl_0050).
 */
const FLOOR_ROLES: Array<{ id: string; label: string }> = [
  { id: 'engineer', label: 'Revive Lab Engineer' },
  { id: 'coordinator', label: 'Coordinator' },
  { id: 'manager', label: 'Manager' },
  { id: 'admin', label: 'Admin' },
  { id: 'purchase', label: 'Purchase' },
  { id: 'observer', label: 'Observer' },
]

function LiveFloorRoles() {
  const qc = useQueryClient()
  const { data: saved, isLoading } = useQuery({
    queryKey: ['revive', 'live-floor-roles'],
    queryFn: async () => {
      const { data, error } = await supabase.from('app_settings').select('value').eq('key', 'revive_live_floor_roles').maybeSingle()
      if (error) throw new Error(friendlyError(error))
      return Array.isArray(data?.value) ? (data!.value as string[]) : FLOOR_ROLES.map(r => r.id)
    },
  })
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = picked ?? new Set(saved ?? [])
  const save = useMutation({
    mutationFn: async (roles: string[]) => {
      const { error } = await supabase.rpc('revive_set_live_floor_roles', { p_roles: roles })
      if (error) throw new Error(friendlyError(error))
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['revive', 'live-floor-roles'] }),
  })
  const toggle = (id: string) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id); else next.add(id)
    setPicked(next); setNotice(null)
  }
  const changed = picked !== null && (picked.size !== (saved ?? []).length || [...picked].some(r => !(saved ?? []).includes(r)))
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-ink-200 bg-ink-50 px-4 py-2.5">
        <Layers className="h-4 w-4 text-ink-500" />
        <h3 className="text-sm font-semibold text-ink-800">Live floor</h3>
        <span className="text-xs text-ink-400">· software administrator only</span>
      </div>
      <div className="space-y-3 p-4">
        {error && <Alert kind="error">{error}</Alert>}
        {notice && <Alert kind="success">{notice}</Alert>}
        {isLoading ? <Spinner className="h-4 w-4 text-ink-400" /> : (
          <div className="flex flex-wrap gap-2">
            {FLOOR_ROLES.map(r => (
              <label key={r.id} className={clsx('flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                current.has(r.id) ? 'border-ink-400 bg-ink-50 text-ink-900' : 'border-ink-200 text-ink-600 hover:border-ink-300')}>
                <input type="checkbox" checked={current.has(r.id)} onChange={() => toggle(r.id)} />
                {r.label}
              </label>
            ))}
          </div>
        )}
        <button type="button" className="btn-primary" disabled={!changed || save.isPending}
          onClick={async () => {
            setError(null)
            try {
              const roles = [...current]
              await save.mutateAsync(roles)
              setPicked(null)
              setNotice(roles.length ? `Live floor on for: ${FLOOR_ROLES.filter(r => current.has(r.id)).map(r => r.label).join(', ')}.` : 'Live floor off for every role.')
            } catch (err) { setError(err instanceof Error ? err.message : 'Could not save that.') }
          }}>
          {save.isPending && <Spinner className="h-4 w-4" />} Save
        </button>
      </div>
    </div>
  )
}

function DeleteTicket() {
  const qc = useQueryClient()
  const [typed, setTyped] = useState('')
  const [found, setFound] = useState<{ kind: 'ticket' | 'pr'; id: string; code: string; facility: string; status: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const pr = prNumberOf(typed)
  const number = pr === null ? ticketNumberOf(typed) : null

  const lookUp = async () => {
    setError(null); setNotice(null); setFound(null)
    if (pr === null && !number) { setError('Type a ticket number, like RL-05, or a component request’s, like PR-01.'); return }
    setBusy(true)
    if (pr !== null) {
      const { data, error: err } = await supabase.from('revive_part_requests')
        .select('id, code, name, qty, status').eq('number', pr).is('ticket_id', null).maybeSingle()
      setBusy(false)
      if (err) { setError(friendlyError(err)); return }
      if (!data) { setError(`There is no component request PR-${pr < 10 ? '0' : ''}${pr}.`); return }
      const r = data as { id: string; code: string; name: string; qty: number; status: string }
      setFound({ kind: 'pr', id: r.id, code: r.code, facility: `${r.qty} × ${r.name}`, status: r.status })
      return
    }
    const { data, error: err } = await supabase.from('revive_tickets')
      .select('id, code, facility, status').eq('number', number!).maybeSingle()
    setBusy(false)
    if (err) { setError(friendlyError(err)); return }
    if (!data) { setError(`There is no ticket RL-${number! < 10 ? '0' : ''}${number}.`); return }
    setFound({ kind: 'ticket', ...(data as { id: string; code: string; facility: string; status: string }) })
  }

  const remove = async () => {
    if (!found) return
    setBusy(true); setError(null)
    try {
      /*
        Its photos and voice note first. Storage files do not go with the
        row, and once it is gone the read rule that finds them has nothing
        to check against — they would be left where nobody could ever
        reach them again. A component request keeps its photo and bill
        pages in requests/<request>/ (rl_0044).
      */
      const bucket = supabase.storage.from('revive-attachments')
      const folder = found.kind === 'pr' ? `requests/${found.id}` : found.id
      const { data: files } = await bucket.list(folder)
      if (files?.length) {
        const { error: rmErr } = await bucket.remove(files.map(f => `${folder}/${f.name}`))
        if (rmErr) throw new Error(friendlyError(rmErr))
      }
      if (found.kind === 'pr') {
        const out = await call<{ code: string; numbering_restarted: boolean }>('revive_delete_part_request', { p_request_id: found.id })
        setNotice(`Deleted ${out.code}.` + (out.numbering_restarted ? ' No component requests are left, so the next one will be PR-01.' : ''))
      } else {
        const out = await call<{ code: string; numbering_restarted: boolean }>('revive_delete_ticket', { p_ticket_id: found.id })
        setNotice(`Deleted ${out.code}.` + (out.numbering_restarted ? ' No tickets are left, so the next one will be RL-01.' : ''))
      }
      setFound(null); setTyped('')
      qc.invalidateQueries({ queryKey: ['revive'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not delete that ${found.kind === 'pr' ? 'request' : 'ticket'}.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-ink-200 bg-ink-50 px-4 py-2.5">
        <Trash2 className="h-4 w-4 text-cyrixRed-600" />
        <h3 className="text-sm font-semibold text-ink-800">Delete a ticket or PR</h3>
        <span className="text-xs text-ink-400">· software administrator only</span>
      </div>
      <div className="space-y-3 p-4">
        {error && <Alert kind="error">{error}</Alert>}
        {notice && <Alert kind="success">{notice}</Alert>}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={e => { e.preventDefault(); void lookUp() }}
        >
          <label className="block w-44">
            <span className="label">Ticket or PR number</span>
            <input
              className="input mt-1 font-mono"
              value={typed}
              onChange={e => { setTyped(e.target.value); setFound(null) }}
              placeholder="RL-05 or PR-01"
            />
          </label>
          <button type="submit" className="btn-secondary !text-cyrixRed-700" disabled={busy || !typed.trim()}>
            {busy && !found ? <Spinner className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />} Delete
          </button>
        </form>

        {found && (
          <div className="rounded-xl border border-cyrixRed-200 bg-cyrixRed-50 p-3">
            <p className="text-sm font-medium text-cyrixRed-900">
              Delete {found.code} · {found.facility} for good?
            </p>
            <p className="mt-0.5 text-xs text-cyrixRed-800">
              {found.kind === 'pr'
                ? 'Its history, photo and bill go with it; what it added to stock stays in stock. This cannot be undone.'
                : 'Its history and transfers go with it. This cannot be undone.'}
            </p>
            <div className="mt-2 flex gap-2">
              <button type="button" className="btn-danger" onClick={remove} disabled={busy}>
                {busy && <Spinner className="h-4 w-4" />} Yes, delete {found.code}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setFound(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function Check({ checked, onChange, label, tone }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; tone?: 'admin'
}) {
  return (
    <label
      className={clsx(
        'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
        checked
          ? tone === 'admin' ? 'border-cyrixRed-300 bg-cyrixRed-50 text-cyrixRed-900' : 'border-ink-900 bg-ink-50 text-ink-900'
          : 'border-ink-200 text-ink-600 hover:border-ink-300',
      )}
    >
      <input type="checkbox" className="h-4 w-4 accent-current" checked={checked} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

function EditRow({ draft, trcs, busy, onChange, onSave, onCancel, onRemove }: {
  draft: Draft; trcs: Trc[]; busy: boolean
  onChange: (d: Draft) => void; onSave: () => void; onCancel: () => void; onRemove?: () => void
}) {
  const toggleTrc = (id: string, on: boolean) =>
    onChange({ ...draft, trc_ids: on ? [...draft.trc_ids, id] : draft.trc_ids.filter(x => x !== id) })
  // An Observer sees the tickets of the Revive Labs ticked, so with none ticked they see nothing —
  // two were saved that way the day the role came in. It is not saved until one is ticked.
  const observerNeedsLab = draft.is_observer && draft.trc_ids.length === 0

  return (
    <div className="space-y-3 rounded-xl border border-ink-200 bg-surface p-4">
      <div>
        <p className="font-medium text-ink-900">{draft.full_name}</p>
        <p className="text-xs text-ink-500">{draft.ecode}</p>
      </div>

      <div>
        <p className="label">Role(s)</p>
        <div className="mt-1 flex flex-wrap gap-2">
          {ROLES.map(([k, label]) => (
            <Check key={k} label={label} checked={draft[k]} onChange={v => onChange({
              ...draft, [k]: v,
              // Ticked with no Revive Lab chosen, an Observer starts with every Revive Lab: untick what they should not see.
              ...(k === 'is_observer' && v && draft.trc_ids.length === 0 ? { trc_ids: trcs.filter(t => t.is_active).map(t => t.id) } : {}),
            })} />
          ))}
        </div>
      </div>

      <div>
        <p className="label">Revive Lab(s)</p>
        <div className="mt-1 flex flex-wrap gap-2">
          {trcs.map(t => (
            <Check key={t.id} label={`${t.name}${t.is_active ? '' : ' (closed)'}`}
              checked={draft.trc_ids.includes(t.id)} onChange={v => toggleTrc(t.id, v)} />
          ))}
        </div>
      </div>

      <div>
        <p className="label">Access</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Check tone="admin" label="Admin — may edit this table" checked={draft.is_admin}
            onChange={v => onChange({ ...draft, is_admin: v })} />
          {/* For an Observer who also sends spares in: everything to see, and tickets to raise (rl_0040). */}
          {draft.is_observer && (
            <Check label="May raise tickets" checked={draft.may_raise}
              onChange={v => onChange({ ...draft, may_raise: v })} />
          )}
        </div>
      </div>

      {(draft.is_engineer || draft.is_coordinator || draft.is_manager || draft.is_purchase) && draft.trc_ids.length === 0 && (
        <p className="text-xs text-amber-700">A role does nothing without a Revive Lab — tick the Revive Lab(s) they work in.</p>
      )}
      {observerNeedsLab && (
        <p className="text-xs font-medium text-cyrixRed-700">
          Tick the Revive Lab(s) this Observer should watch — with none ticked they would see no tickets.
        </p>
      )}
      {/* What the box means, said while it is the only one ticked: it takes things away as well as giving them. */}
      {draft.is_observer && !(draft.is_engineer || draft.is_coordinator || draft.is_manager || draft.is_purchase || draft.is_admin) && (
        <p className="text-xs text-ink-500">
          {draft.may_raise
            ? 'This Observer sees a dashboard and the tickets of the Revive Lab(s) ticked, and raises tickets as a field engineer does. Nothing else to press.'
            : 'An Observer only watches: a dashboard and the tickets of the Revive Lab(s) ticked, with nothing to press and no ticket to raise.'}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary" onClick={onSave} disabled={busy || observerNeedsLab}>
          {busy && <Spinner className="h-4 w-4" />} Save
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        {onRemove && (
          <button type="button" className="btn-secondary ml-auto !text-cyrixRed-700" onClick={onRemove} disabled={busy}>
            <Trash2 className="h-4 w-4" /> Remove from Revive Lab
          </button>
        )}
      </div>
    </div>
  )
}

function AddPerson({ existing, onPick, onCancel }: {
  existing: Set<string>; onPick: (p: Person) => void; onCancel: () => void
}) {
  const [q, setQ] = useState('')
  const term = q.trim()
  const { data, isFetching } = useQuery({
    enabled: term.length >= 2,
    queryKey: ['revive', 'people', term.toLowerCase()],
    queryFn: () => call<Person[]>('revive_find_people', { p_q: term }),
  })

  return (
    <div className="space-y-2 border-b border-ink-200 p-3">
      <div className="flex items-center gap-2">
        <label className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input autoFocus className="input !pl-8" placeholder="Find by employee code or name" value={q} onChange={e => setQ(e.target.value)} />
        </label>
        <button type="button" className="btn-icon" onClick={onCancel} aria-label="Close"><X className="h-4 w-4" /></button>
      </div>
      {isFetching && <Spinner className="h-4 w-4 text-ink-400" />}
      {term.length >= 2 && !isFetching && (
        <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
          {(data ?? []).length === 0 && <li className="px-3 py-2 text-sm text-ink-500">Nobody active matches.</li>}
          {(data ?? []).map(p => (
            <li key={p.id}>
              <button
                type="button"
                disabled={existing.has(p.id)}
                onClick={() => onPick(p)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-ink-50 disabled:opacity-50"
              >
                <span>
                  <span className="block text-sm font-medium text-ink-900">{p.full_name}</span>
                  <span className="block text-xs text-ink-500">{p.ecode}{p.designation ? ` · ${p.designation}` : ''}</span>
                </span>
                {existing.has(p.id)
                  ? <span className="text-xs text-ink-400">already in</span>
                  : <Plus className="h-4 w-4 text-ink-400" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

/** A Revive Lab being added or edited. A state not chosen yet is undefined; Regional is null. */
interface TrcDraft { id: string | null; name: string; kind: TrcKind; state: string | null | undefined; active: boolean }

function TrcTable({ trcs, canEdit, members }: { trcs: Trc[]; canEdit: boolean; members: Member[] }) {
  const qc = useQueryClient()
  const saveTrc = useMutation({
    mutationFn: (t: TrcDraft) =>
      call('revive_save_trc', {
        p_id: t.id, p_name: t.name, p_kind: t.kind, p_active: t.active, p_state: t.state ?? 'Regional',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['revive'] }),
  })
  const [draft, setDraft] = useState<TrcDraft | null>(null)
  const [error, setError] = useState<string | null>(null)

  const staff = (id: string) => members.filter(m => m.trc_ids.includes(id))

  const save = async () => {
    if (!draft) return
    setError(null)
    if (draft.state === undefined) { setError('Choose the state it serves, or Regional.'); return }
    try { await saveTrc.mutateAsync(draft); setDraft(null) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save that Revive Lab.') }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-ink-50 px-3 py-2">
        <h3 className="flex items-center gap-2 px-1 text-sm font-semibold text-ink-800">
          <Building2 className="h-4 w-4 text-ink-400" /> Revive Labs
        </h3>
        {canEdit && (
          <button type="button" className="btn-secondary ml-auto !py-1.5"
            onClick={() => setDraft({ id: null, name: '', kind: 'regional', state: undefined, active: true })}>
            <Plus className="h-4 w-4" /> Add Revive Lab
          </button>
        )}
      </div>

      {error && <div className="p-3"><Alert kind="error">{error}</Alert></div>}

      {draft && (
        <div className="flex flex-wrap items-end gap-2 border-b border-ink-200 p-3">
          <label className="block min-w-[12rem] flex-1">
            <span className="label">Name</span>
            <input autoFocus className="input mt-1" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Regional Revive Lab — Kochi" />
          </label>
          <label className="block">
            <span className="label">Type</span>
            <select className="input mt-1" value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as TrcKind })}>
              <option value="regional">Regional Revive Lab</option>
              <option value="project">Project Revive Lab</option>
            </select>
          </label>
          {/* Which route cards offer it: one state's, or every state's. */}
          <label className="block">
            <span className="label">State</span>
            <StateSelect className="mt-1 w-56" value={draft.state} onChange={state => setDraft({ ...draft, state })} />
          </label>
          {draft.id && (
            <label className="flex items-center gap-2 pb-2 text-sm text-ink-700">
              <input type="checkbox" className="h-4 w-4" checked={draft.active} onChange={e => setDraft({ ...draft, active: e.target.checked })} />
              Taking tickets
            </label>
          )}
          <button type="button" className="btn-primary" onClick={save} disabled={saveTrc.isPending || draft.name.trim().length < 2 || draft.state === undefined}>
            {saveTrc.isPending && <Spinner className="h-4 w-4" />} Save
          </button>
          <button type="button" className="btn-secondary" onClick={() => setDraft(null)}>Cancel</button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">
              <th className="px-4 py-2.5 font-medium">Revive Lab</th>
              <th className="px-4 py-2.5 font-medium">Type</th>
              <th className="px-4 py-2.5 font-medium">State</th>
              <th className="px-4 py-2.5 font-medium">Coordinators</th>
              <th className="px-4 py-2.5 font-medium">Engineers</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              {canEdit && <th className="px-4 py-2.5" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {trcs.map(t => {
              const people = staff(t.id)
              // The desk is its coordinators: a manager approves, and does not take spares in (rl_0036).
              const coordinators = people.filter(p => p.is_coordinator)
              return (
                <tr key={t.id} className="hover:bg-ink-50">
                  <td className="px-4 py-3 font-medium text-ink-900">{t.name}</td>
                  <td className="px-4 py-3 text-ink-600">{KIND_LABEL[t.kind]}</td>
                  <td className="px-4 py-3 text-ink-600">
                    {t.state ?? <>Regional <span className="text-ink-400">· every state</span></>}
                  </td>
                  <td className="px-4 py-3 text-ink-600">
                    {coordinators.length
                      ? coordinators.map(p => p.full_name).join(', ')
                      : <span className="text-amber-700">Nobody — tickets here would wait unseen</span>}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-ink-600">{people.filter(p => p.is_engineer).length}</td>
                  <td className="px-4 py-3">
                    <span className={clsx('badge', t.is_active ? 'bg-emerald-100 text-emerald-900' : 'bg-ink-100 text-ink-600')}>
                      {t.is_active ? 'Taking tickets' : 'Closed'}
                    </span>
                  </td>
                  {canEdit && (
                    <td className="px-4 py-3 text-right">
                      <button type="button" className="btn-secondary !px-2.5 !py-1.5 text-xs"
                        onClick={() => setDraft({ id: t.id, name: t.name, kind: t.kind, state: t.state, active: t.is_active })}>
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
