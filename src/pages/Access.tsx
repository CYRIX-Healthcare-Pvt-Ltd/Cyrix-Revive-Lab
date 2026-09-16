/**
 * People & TRCs — who does what in Revive Lab, and which labs exist.
 *
 * THIS FILE IS SHARED. The same component is KPI's SW Admin "Revive Lab"
 * tab (src/pages/admin/ReviveLabAccess.tsx there), so it depends on
 * nothing but the Supabase client and the four ui pieces both apps have.
 * Change it in one, copy it to the other.
 *
 * Roles are boxes. A person is any combination of TRC Engineer, TRC
 * Coordinator and TRC Manager, in any number of TRCs, and Admin is a box
 * of its own that means "may edit this table" — so "Manager + Admin" is
 * two ticks, not a role somebody had to invent. The database checks every
 * save (revive_save_member): only an admin or the software administrator
 * may change anything, and nobody can untick their own Admin box.
 */
import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Pencil, Plus, Search, Trash2, UserPlus, Users, X } from 'lucide-react'
import { supabase, friendlyError } from '@/lib/supabase'
import { Alert, EmptyState, Spinner, StatTile } from '@/components/ui'

type TrcKind = 'regional' | 'project'
const KIND_LABEL: Record<TrcKind, string> = { regional: 'Regional TRC', project: 'Project TRC' }

interface Trc { id: string; name: string; kind: TrcKind; is_active: boolean; sort_order: number }
interface Member {
  employee_id: string; ecode: string; full_name: string; designation: string | null
  is_engineer: boolean; is_coordinator: boolean; is_manager: boolean; is_admin: boolean
  trc_ids: string[]; updated_at: string; updated_by_name: string | null
}
interface Person { id: string; ecode: string; full_name: string; designation: string | null; department: string | null }

interface Draft {
  employee_id: string; full_name: string; ecode: string
  is_engineer: boolean; is_coordinator: boolean; is_manager: boolean; is_admin: boolean
  trc_ids: string[]
}

const ROLES: Array<[keyof Pick<Draft, 'is_engineer' | 'is_coordinator' | 'is_manager'>, string]> = [
  ['is_engineer', 'TRC Engineer'],
  ['is_coordinator', 'TRC Coordinator'],
  ['is_manager', 'TRC Manager'],
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
        <h1 className="text-xl font-semibold text-ink-900">People &amp; TRCs</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          Who works in Revive Lab, in which TRCs, doing what.
        </p>
      </div>
      <ReviveLabAccess />
    </div>
  )
}

export function ReviveLabAccess() {
  const qc = useQueryClient()
  const { data: me } = useQuery({
    queryKey: ['revive', 'me'],
    queryFn: async () => (await call<Array<{ employee_id: string; is_admin: boolean }>>('revive_me'))[0] ?? null,
  })
  const { data: trcs, isLoading: loadingTrcs } = useQuery({
    queryKey: ['revive', 'trcs'],
    queryFn: async () => {
      const { data, error } = await supabase.from('revive_trcs')
        .select('id, name, kind, is_active, sort_order').order('sort_order').order('name')
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
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['revive'] }),
  })

  const [editing, setEditing] = useState<Draft | null>(null)
  const [adding, setAdding] = useState(false)
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

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
      admins: rows.filter(m => m.is_admin).length,
    }
  }, [members])

  const startEdit = (m: Member) => {
    setError(null); setNotice(null); setAdding(false)
    setEditing({
      employee_id: m.employee_id, full_name: m.full_name, ecode: m.ecode,
      is_engineer: m.is_engineer, is_coordinator: m.is_coordinator, is_manager: m.is_manager,
      is_admin: m.is_admin, trc_ids: [...m.trc_ids],
    })
  }

  const save = async (d: Draft, removing = false) => {
    setError(null); setNotice(null)
    const payload = removing
      ? { ...d, is_engineer: false, is_coordinator: false, is_manager: false, is_admin: false, trc_ids: [] }
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
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="TRCs" value={(trcs ?? []).filter(t => t.is_active).length} sub={`${(trcs ?? []).length} in all`} />
        <StatTile label="TRC engineers" value={counts.engineers} />
        <StatTile label="Coordinators" value={counts.coordinators} />
        <StatTile label="Managers" value={counts.managers} />
        <StatTile label="Admins" value={counts.admins} sub="may edit this table" />
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      <div className="card overflow-hidden">
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
                is_engineer: false, is_coordinator: false, is_manager: false, is_admin: false,
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
              {canEdit && !q && 'Add the TRC coordinators first — tickets route to them.'}
            </EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">
                  <th className="px-4 py-2.5 font-medium">Employee</th>
                  <th className="px-4 py-2.5 font-medium">TRC(s)</th>
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
      </div>

      <TrcTable trcs={trcs ?? []} canEdit={canEdit} members={members ?? []} />
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
            <Check key={k} label={label} checked={draft[k]} onChange={v => onChange({ ...draft, [k]: v })} />
          ))}
        </div>
      </div>

      <div>
        <p className="label">TRC(s)</p>
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
        </div>
      </div>

      {(draft.is_engineer || draft.is_coordinator || draft.is_manager) && draft.trc_ids.length === 0 && (
        <p className="text-xs text-amber-700">A role does nothing without a TRC — tick the TRC(s) they work in.</p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary" onClick={onSave} disabled={busy}>
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

function TrcTable({ trcs, canEdit, members }: { trcs: Trc[]; canEdit: boolean; members: Member[] }) {
  const qc = useQueryClient()
  const saveTrc = useMutation({
    mutationFn: (t: { id: string | null; name: string; kind: TrcKind; active: boolean }) =>
      call('revive_save_trc', { p_id: t.id, p_name: t.name, p_kind: t.kind, p_active: t.active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['revive'] }),
  })
  const [draft, setDraft] = useState<{ id: string | null; name: string; kind: TrcKind; active: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const staff = (id: string) => members.filter(m => m.trc_ids.includes(id))

  const save = async () => {
    if (!draft) return
    setError(null)
    try { await saveTrc.mutateAsync(draft); setDraft(null) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save that TRC.') }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-ink-50 px-3 py-2">
        <h3 className="flex items-center gap-2 px-1 text-sm font-semibold text-ink-800">
          <Building2 className="h-4 w-4 text-ink-400" /> TRCs
        </h3>
        {canEdit && (
          <button type="button" className="btn-secondary ml-auto !py-1.5"
            onClick={() => setDraft({ id: null, name: '', kind: 'regional', active: true })}>
            <Plus className="h-4 w-4" /> Add TRC
          </button>
        )}
      </div>

      {error && <div className="p-3"><Alert kind="error">{error}</Alert></div>}

      {draft && (
        <div className="flex flex-wrap items-end gap-2 border-b border-ink-200 p-3">
          <label className="block min-w-[12rem] flex-1">
            <span className="label">Name</span>
            <input autoFocus className="input mt-1" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Regional TRC — Kochi" />
          </label>
          <label className="block">
            <span className="label">Type</span>
            <select className="input mt-1" value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as TrcKind })}>
              <option value="regional">Regional TRC</option>
              <option value="project">Project TRC</option>
            </select>
          </label>
          {draft.id && (
            <label className="flex items-center gap-2 pb-2 text-sm text-ink-700">
              <input type="checkbox" className="h-4 w-4" checked={draft.active} onChange={e => setDraft({ ...draft, active: e.target.checked })} />
              Taking tickets
            </label>
          )}
          <button type="button" className="btn-primary" onClick={save} disabled={saveTrc.isPending || draft.name.trim().length < 2}>
            {saveTrc.isPending && <Spinner className="h-4 w-4" />} Save
          </button>
          <button type="button" className="btn-secondary" onClick={() => setDraft(null)}>Cancel</button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">
              <th className="px-4 py-2.5 font-medium">TRC</th>
              <th className="px-4 py-2.5 font-medium">Type</th>
              <th className="px-4 py-2.5 font-medium">Coordinators</th>
              <th className="px-4 py-2.5 font-medium">Engineers</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              {canEdit && <th className="px-4 py-2.5" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {trcs.map(t => {
              const people = staff(t.id)
              const coordinators = people.filter(p => p.is_coordinator || p.is_manager)
              return (
                <tr key={t.id} className="hover:bg-ink-50">
                  <td className="px-4 py-3 font-medium text-ink-900">{t.name}</td>
                  <td className="px-4 py-3 text-ink-600">{KIND_LABEL[t.kind]}</td>
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
                        onClick={() => setDraft({ id: t.id, name: t.name, kind: t.kind, active: t.is_active })}>
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
