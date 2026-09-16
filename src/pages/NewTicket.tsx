import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { ArrowLeft, PackagePlus, Truck, Building2 } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useRaiseTicket, useTrcs, type Person } from '@/lib/queries'
import { runsTrc, TRC_KIND_LABEL, type TrcKind } from '@/lib/tickets'
import { Alert, PageLoader, Spinner } from '@/components/ui'
import PersonPicker from '@/components/PersonPicker'

/**
 * Raising a ticket.
 *
 * Two doors to the same form. A field engineer sending a spare in raises
 * it for themselves; a coordinator whose lab a spare has simply arrived at
 * raises it at the lab, and names the field engineer it belongs to — that
 * engineer, and their manager, then follow it exactly as if they had sent
 * it. Somebody who is both sees a switch; everybody else sees only the one
 * door that applies to them.
 */
export default function NewTicket() {
  const { me } = useAuth()
  const navigate = useNavigate()
  const { data: trcs, isLoading } = useTrcs()
  const raise = useRaiseTicket()

  const active = useMemo(() => (trcs ?? []).filter(t => t.is_active), [trcs])
  const deskTrcs = useMemo(() => active.filter(t => runsTrc(me, t.id)), [active, me])
  const canDesk = deskTrcs.length > 0

  const [atLab, setAtLab] = useState(false)
  useEffect(() => { setAtLab(canDesk) }, [canDesk])

  const [kind, setKind] = useState<TrcKind | ''>('')
  const [trcId, setTrcId] = useState('')
  const [holder, setHolder] = useState<Person | null>(null)
  const [form, setForm] = useState({
    facility: '', district: '', state: '', sourceTicketNo: '', item: '',
    inCourier: '', inAwb: '', inDispatchedOn: '',
  })
  const [error, setError] = useState<string | null>(null)

  const choices = (atLab ? deskTrcs : active).filter(t => !kind || t.kind === kind)
  const kinds = [...new Set((atLab ? deskTrcs : active).map(t => t.kind))]

  // One lab of that type: it is the answer, not a question.
  useEffect(() => {
    if (choices.length === 1) setTrcId(choices[0].id)
    else if (!choices.some(c => c.id === trcId)) setTrcId('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, atLab, trcs])

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!trcId) { setError('Choose the TRC the spare is going to.'); return }
    if (form.facility.trim().length < 2) { setError('Enter the facility the spare came from.'); return }
    if (atLab && !holder) { setError('Name the field engineer this spare belongs to.'); return }
    try {
      const out = await raise.mutateAsync({ ...form, trcId, stakeholderId: atLab ? holder!.id : null })
      navigate(`/tickets/${out.code}`, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not raise that ticket.')
    }
  }

  if (isLoading) return <PageLoader />

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <button type="button" onClick={() => navigate(-1)} className="inline-flex items-center gap-1.5 text-sm text-ink-600 hover:text-ink-900">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      <div>
        <h1 className="text-xl font-semibold text-ink-900">Raise a ticket</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          It gets the next RL number, and the TRC&rsquo;s coordinators are emailed straight away.
        </p>
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      <form onSubmit={submit} className="space-y-4">
        {canDesk && (
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              { lab: true, icon: Building2, title: 'A spare arrived at my TRC', sub: 'You name the field engineer it belongs to.' },
              { lab: false, icon: Truck, title: 'I am sending a spare in', sub: 'From a hospital, to a TRC.' },
            ].map(o => (
              <button
                key={String(o.lab)}
                type="button"
                onClick={() => { setAtLab(o.lab); setKind(''); setTrcId('') }}
                className={clsx(
                  'card flex items-start gap-3 p-3.5 text-left transition-colors',
                  atLab === o.lab ? 'border-ink-900 ring-1 ring-ink-900' : 'hover:border-ink-300',
                )}
                aria-pressed={atLab === o.lab}
              >
                <o.icon className="mt-0.5 h-5 w-5 shrink-0 text-ink-500" />
                <span>
                  <span className="block text-sm font-medium text-ink-900">{o.title}</span>
                  <span className="block text-xs text-ink-500">{o.sub}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="card space-y-3 p-4">
          <h2 className="text-sm font-semibold text-ink-800">Where it is going</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">TRC type</span>
              <select className="input mt-1" value={kind} onChange={e => setKind(e.target.value as TrcKind | '')}>
                <option value="">Any type</option>
                {kinds.map(k => <option key={k} value={k}>{TRC_KIND_LABEL[k]}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="label">TRC</span>
              <select className="input mt-1" value={trcId} onChange={e => setTrcId(e.target.value)} required>
                <option value="">Choose…</option>
                {choices.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          </div>
          {atLab && (
            <div>
              <span className="label">Field engineer it belongs to</span>
              <div className="mt-1">
                <PersonPicker value={holder} onChange={setHolder} />
              </div>
              <p className="mt-1 text-xs text-ink-500">They and their reporting manager follow this ticket as if they had raised it.</p>
            </div>
          )}
        </div>

        <div className="card space-y-3 p-4">
          <h2 className="text-sm font-semibold text-ink-800">The spare</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Source ticket number" value={form.sourceTicketNo} onChange={set('sourceTicketNo')} placeholder="The field service ticket that found it" />
            <Field label="Spare / board" value={form.item} onChange={set('item')} placeholder="e.g. SMPS board, ventilator" />
          </div>
          <Field label="Facility" value={form.facility} onChange={set('facility')} placeholder="Hospital or site" required />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="District" value={form.district} onChange={set('district')} />
            <Field label="State" value={form.state} onChange={set('state')} />
          </div>
        </div>

        <div className="card space-y-3 p-4">
          <h2 className="text-sm font-semibold text-ink-800">Inbound courier</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Courier" value={form.inCourier} onChange={set('inCourier')} placeholder="DTDC, Blue Dart…" />
            <Field label="Tracking / AWB number" value={form.inAwb} onChange={set('inAwb')} />
            <Field label="Dispatched on" type="date" value={form.inDispatchedOn} onChange={set('inDispatchedOn')} />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => navigate(-1)}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={raise.isPending}>
            {raise.isPending ? <Spinner className="h-4 w-4" /> : <PackagePlus className="h-4 w-4" />}
            Raise ticket
          </button>
        </div>
      </form>
    </div>
  )
}

function Field({
  label, value, onChange, placeholder, type = 'text', required,
}: {
  label: string
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder?: string
  type?: string
  required?: boolean
}) {
  return (
    <label className="block">
      <span className="label">{label}{required && <span className="text-cyrixRed-600"> *</span>}</span>
      <input className="input mt-1" type={type} value={value} onChange={onChange} placeholder={placeholder} required={required} />
    </label>
  )
}
