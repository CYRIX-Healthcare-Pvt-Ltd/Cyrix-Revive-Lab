import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { ArrowLeft, PackagePlus } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useBemmpProjects, useRaiseTicket, useTickets, useTrcs, type Person } from '@/lib/queries'
import { runsTrc, TRC_KIND_LABEL, type TrcKind } from '@/lib/tickets'
import { STATES, districtsOf } from '@/lib/india'
import { uploadAttachment, type Slot } from '@/lib/attachments'
import { Alert, PageLoader, Spinner } from '@/components/ui'
import PersonPicker from '@/components/PersonPicker'
import { MediaCapture, type PendingPhoto } from '@/components/Attachments'

/**
 * Raising a ticket — the route card, on a screen.
 *
 * Field engineers already send spares in with a paper card, form
 * CHPL/CRL/SRC, and this asks what the card asks. State comes first, then
 * the district — only that state's districts — then which BEMMP the
 * equipment belongs to. Sent by is whoever is signed in, with their function,
 * and never typed; Date of dispatch is the inbound courier's date. The back
 * of the card — Action taken, Final status — belongs to the Close repair and
 * Received back steps.
 *
 * Who is asking decides which card it is, and nobody is asked. A field
 * engineer sending a spare in raises it for themselves. A Revive Lab's
 * coordinator or manager raises it at their Revive Lab, for a spare that
 * arrived there, and names the field engineer it belongs to — the desk does
 * not send spares in, so it is not offered the choice.
 */
export default function NewTicket() {
  const { me, employee } = useAuth()
  const navigate = useNavigate()
  const { data: trcs, isLoading } = useTrcs()
  const { data: bemmp } = useBemmpProjects()
  const { data: tickets } = useTickets()
  const raise = useRaiseTicket()

  const active = useMemo(() => (trcs ?? []).filter(t => t.is_active), [trcs])
  const deskTrcs = useMemo(() => active.filter(t => runsTrc(me, t.id)), [active, me])
  const canDesk = deskTrcs.length > 0
  const bemmpChoices = useMemo(() => (bemmp ?? []).filter(b => b.is_active), [bemmp])

  const atLab = canDesk

  const [kind, setKind] = useState<TrcKind | ''>('')
  const [trcId, setTrcId] = useState('')
  const [holder, setHolder] = useState<Person | null>(null)
  const [form, setForm] = useState({
    state: '', district: '', bemmpId: '', hospital: '', equipmentBarcode: '', equipmentName: '',
    spareName: '', sourceTicketNo: '', contactNumber: '', issue: '',
    returnAddress: '', inCourier: '', inAwb: '', inDispatchedOn: '',
  })
  const [photos, setPhotos] = useState<PendingPhoto[]>([])
  const [video, setVideo] = useState<Blob | null>(null)
  const [voice, setVoice] = useState<Blob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stage, setStage] = useState<'idle' | 'raising' | 'uploading'>('idle')

  /*
    The contact number starts as the official number on this person's KPI
    profile, and the return address as whatever they put on their last card.
    Only when the fields are still empty: nothing typed is ever overwritten.
  */
  useEffect(() => {
    if (!employee) return
    const last = (tickets ?? []).find(t => t.raised_by === employee.id && (t.contact_number || t.return_address))
    setForm(f => ({
      ...f,
      contactNumber: f.contactNumber || employee.official_phone || last?.contact_number || '',
      returnAddress: f.returnAddress || last?.return_address || '',
    }))
  }, [employee, tickets])

  const choices = (atLab ? deskTrcs : active).filter(t => !kind || t.kind === kind)
  const kinds = [...new Set((atLab ? deskTrcs : active).map(t => t.kind))]

  // One Revive Lab of that type: it is the answer, not a question.
  useEffect(() => {
    if (choices.length === 1) setTrcId(choices[0].id)
    else if (!choices.some(c => c.id === trcId)) setTrcId('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, atLab, trcs])

  const districts = districtsOf(form.state)

  const set = (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm(f => ({ ...f, [k]: e.target.value }))

  const chooseState = (state: string) => {
    // A district belongs to one state: changing the state clears it.
    setForm(f => ({ ...f, state, district: '' }))
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!trcId) { setError('Choose the Revive Lab the spare is going to.'); return }
    if (!form.state) { setError('Choose the state.'); return }
    if (!form.district) { setError('Choose the district.'); return }
    if (!form.bemmpId) { setError('Choose the BEMMP.'); return }
    if (form.hospital.trim().length < 2) { setError('Enter the hospital name.'); return }
    if (form.spareName.trim().length < 2) { setError('Enter the spare name.'); return }
    if (form.issue.trim().length < 3) { setError('Describe the issue identified.'); return }
    if (form.returnAddress.trim().length < 5) { setError('Enter the spare return address.'); return }
    if (atLab && !holder) { setError('Name the field engineer this spare belongs to.'); return }

    let created: { id: string; code: string } | null = null
    try {
      setStage('raising')
      created = await raise.mutateAsync({ ...form, trcId, stakeholderId: atLab ? holder!.id : null })
    } catch (err) {
      setStage('idle')
      setError(err instanceof Error ? err.message : 'Could not raise that ticket.')
      return
    }

    /*
      The ticket exists before its files do: the storage rules only let a
      file into a folder named for a ticket its sender raised. A file that
      fails does not undo the ticket — the ticket page offers the empty slot
      again, and says so.
    */
    setStage('uploading')
    const ticketId = created.id
    const jobs: Array<[string, Slot, Blob]> = [
      ...photos.map((p, i): [string, Slot, Blob] => [`photo ${i + 1}`, i === 0 ? 'image-1' : 'image-2', p.blob]),
      ...(video ? [['the video', 'video', video] as [string, Slot, Blob]] : []),
      ...(voice ? [['the voice note', 'voice', voice] as [string, Slot, Blob]] : []),
    ]
    const results = await Promise.allSettled(jobs.map(([, slot, blob]) => uploadAttachment(ticketId, slot, blob)))
    const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [jobs[i][0]] : []))

    setStage('idle')
    navigate(`/tickets/${created.code}`, {
      replace: true,
      state: failed.length ? { uploadFailed: failed } : undefined,
    })
  }

  if (isLoading) return <PageLoader />

  const busy = stage !== 'idle'

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <button type="button" onClick={() => navigate(-1)} className="inline-flex items-center gap-1.5 text-sm text-ink-600 hover:text-ink-900">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      <div>
        <h1 className="text-xl font-semibold text-ink-900">Raise a ticket</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          The spare&rsquo;s route card. It gets the next RL number when you raise it.
        </p>
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      <form onSubmit={submit} className="space-y-4">
        <div className="card space-y-3 p-4">
          <h2 className="text-sm font-semibold text-ink-800">{atLab ? 'Where it arrived' : 'Where it is going'}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">Revive Lab type</span>
              <select className="input mt-1" value={kind} onChange={e => setKind(e.target.value as TrcKind | '')}>
                <option value="">Any type</option>
                {kinds.map(k => <option key={k} value={k}>{TRC_KIND_LABEL[k]}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="label">Revive Lab <Req /></span>
              <select className="input mt-1" value={trcId} onChange={e => setTrcId(e.target.value)}>
                <option value="">Choose…</option>
                {choices.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          </div>
          {atLab && (
            <div>
              <span className="label">Field engineer it belongs to <Req /></span>
              <div className="mt-1"><PersonPicker value={holder} onChange={setHolder} /></div>
              <p className="mt-1 text-xs text-ink-500">They and their reporting manager follow this ticket as if they had raised it.</p>
            </div>
          )}
        </div>

        {/* The card, top to bottom. */}
        <div className="card space-y-3 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink-800">Service route card</h2>
            <span className="text-[11px] text-ink-400">Form CHPL/CRL/SRC</span>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="label">State <Req /></span>
              <select className="input mt-1" value={form.state} onChange={e => chooseState(e.target.value)}>
                <option value="">Choose…</option>
                {STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="label">District <Req /></span>
              <select
                className="input mt-1"
                value={form.district}
                onChange={set('district')}
                disabled={!form.state}
              >
                <option value="">{form.state ? 'Choose…' : 'Choose the state first'}</option>
                {districts.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="label">BEMMP <Req /></span>
              <select className="input mt-1" value={form.bemmpId} onChange={set('bemmpId')}>
                <option value="">Choose…</option>
                {bemmpChoices.map(b => <option key={b.id} value={b.id}>{b.code}</option>)}
              </select>
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Hospital name" value={form.hospital} onChange={set('hospital')} required />
            <Field label="Equipment barcode" value={form.equipmentBarcode} onChange={set('equipmentBarcode')} mono />
            <Field label="Equipment name" value={form.equipmentName} onChange={set('equipmentName')} placeholder="e.g. Ventilator" />
            <Field label="Spare name" value={form.spareName} onChange={set('spareName')} placeholder="e.g. SMPS board" required />
            <Field label="Ticket ID" value={form.sourceTicketNo} onChange={set('sourceTicketNo')} placeholder="The field service ticket" mono />
            <Field label="Contact number" type="tel" value={form.contactNumber} onChange={set('contactNumber')} placeholder="+91 …" />
          </div>

          <label className="block">
            <span className="label">Issue identified <Req /></span>
            <textarea className="input mt-1" rows={3} value={form.issue} onChange={set('issue')} maxLength={2000}
              placeholder="What is wrong with it, as found on site" />
          </label>

          {/* Photos, the video and the voice note, side by side. */}
          <div>
            <span className="label">Photos and recordings</span>
            <div className="mt-1">
              <MediaCapture
                photos={{ value: photos, onChange: setPhotos }}
                video={{ value: video, onChange: setVideo }}
                voice={{ value: voice, onChange: setVoice }}
              />
            </div>
          </div>

          <label className="block">
            <span className="label">Spare return address <Req /></span>
            <textarea className="input mt-1" rows={2} value={form.returnAddress} onChange={set('returnAddress')} maxLength={500}
              placeholder="Where the Revive Lab sends it back to" />
          </label>
        </div>

        <div className="card space-y-3 p-4">
          <h2 className="text-sm font-semibold text-ink-800">Courier details</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Courier" value={form.inCourier} onChange={set('inCourier')} placeholder="DTDC, Blue Dart…" />
            <Field label="Tracking / AWB number" value={form.inAwb} onChange={set('inAwb')} mono />
            <Field label="Date of dispatch" type="date" value={form.inDispatchedOn} onChange={set('inDispatchedOn')} />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => navigate(-1)} disabled={busy}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? <Spinner className="h-4 w-4" /> : <PackagePlus className="h-4 w-4" />}
            {stage === 'raising' ? 'Raising…' : stage === 'uploading' ? 'Sending photos and recordings…' : 'Raise ticket'}
          </button>
        </div>
      </form>
    </div>
  )
}

function Req() {
  return <span className="text-cyrixRed-600">*</span>
}

function Field({
  label, value, onChange, placeholder, type = 'text', required, mono,
}: {
  label: string
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder?: string
  type?: string
  required?: boolean
  mono?: boolean
}) {
  return (
    <label className="block">
      <span className="label">{label}{required && <> <Req /></>}</span>
      <input className={clsx('input mt-1', mono && 'font-mono')} type={type} value={value} onChange={onChange} placeholder={placeholder} />
    </label>
  )
}
